import { Anthropic } from '@anthropic-ai/sdk';

// ==========================================
// CONFIGURATION
// ==========================================
const PORT = 8000;
const DEBUG = true; // 默认开启DEBUG

// ==========================================
// LOGGER
// ==========================================
const logger = {
  info: (msg: string, ...args: any[]) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, ...args);
  },
  debug: (msg: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, ...args);
    }
  },
  error: (msg: string, ...args: any[]) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, ...args);
  },
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * 从Headers中提取认证信息
 * 支持 Authorization 或 x-api-key，不区分大小写
 */
function extractAuthHeaders(headers: Headers): string | null {
  // 转换为小写key的map以便查找，虽然Headers对象本身get不区分大小写，
  // 但为了遍历查找特定值方便，还是逻辑明确点
  const authHeader = headers.get('authorization');
  const apiKeyHeader = headers.get('x-api-key');

  if (authHeader && authHeader.trim().length > 0) return authHeader;
  if (apiKeyHeader && apiKeyHeader.trim().length > 0) return apiKeyHeader;

  return null;
}

/**
 * 解析认证字符串，提取 API Key 和 Base URL
 * 逻辑：查找 "cc:"，取其后部分，尝试用 "!" 分割
 */
function parseCredentials(authString: string) {
  // 移除 "Bearer " 前缀（如果存在）
  let cleanAuth = authString;
  if (cleanAuth.toLowerCase().startsWith('bearer ')) {
    cleanAuth = cleanAuth.slice(7).trim();
  }

  // 查找 "cc:"
  const ccIndex = cleanAuth.indexOf('cc:');
  
  // 默认值
  let apiKey = cleanAuth;
  let baseURL = 'https://api.anthropic.com'; 

  if (ccIndex !== -1) {
    logger.debug(`Found 'cc:' keyword in credentials.`);
    // 提取 cc: 之后的内容
    const contentAfterCc = cleanAuth.substring(ccIndex + 3);
    
    // 尝试用 "!" 分割
    const separatorIndex = contentAfterCc.indexOf('!');
    
    if (separatorIndex !== -1) {
      const part1 = contentAfterCc.substring(0, separatorIndex);
      const part2 = contentAfterCc.substring(separatorIndex + 1);
      
      if (part1 && part2) {
        apiKey = part1;
        baseURL = part2;
        logger.debug(`Successfully parsed credentials. Custom BaseURL detected.`);
      } else {
         logger.debug(`Split failed or empty parts, falling back to raw content.`);
         apiKey = contentAfterCc;
      }
    } else {
      logger.debug(`No '!' separator found after 'cc:', using entire suffix as key.`);
      apiKey = contentAfterCc;
    }
  } else {
    logger.debug(`No 'cc:' keyword found, using provided auth string as key.`);
  }

  // 确保BaseURL格式正确 (SDK通常处理得很好，但为了保险)
  if (!baseURL.startsWith('http')) {
      baseURL = `https://${baseURL}`;
  }
  // 移除末尾斜杠
  if (baseURL.endsWith('/')) {
      baseURL = baseURL.slice(0, -1);
  }

  // 简单脱敏打印
  const maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : '***';
  logger.debug(`Final Config -> API Key: ${maskedKey}, BaseURL: ${baseURL}`);

  return { apiKey, baseURL };
}

// ==========================================
// SERVER LOGIC
// ==========================================

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    logger.info(`Incoming request: ${req.method} ${url.pathname}`);

    // 仅处理 POST /v1/messages
    // 注意：Anthropic SDK 默认路径可能是 /v1/messages，这里做一个宽泛匹配
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      // 1. 提取 Header
      const rawAuth = extractAuthHeaders(req.headers);
      if (!rawAuth) {
        logger.error('No authorization header found.');
        return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'Missing API key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 2. 解析凭据
      const { apiKey, baseURL } = parseCredentials(rawAuth);

      // 3. 初始化 Anthropic 客户端
      // 注意：baseURL 需要包含 /v1 吗？通常 SDK 会自动追加，或者我们传入根域名
      // 官方SDK构造函数里，如果传入 baseURL，它会直接使用。
      // 如果解析出的 baseURL 包含 /v1，SDK 可能会重复拼接，这里假设用户传入的是域名或根路径
      // 通常 Anthropic 的 baseURL 是 https://api.anthropic.com
      const client = new Anthropic({
        apiKey: apiKey,
        baseURL: baseURL,
      });

      // 4. 解析请求体
      let body: any;
      try {
        body = await req.json();
      } catch (e) {
        logger.error('Failed to parse request body JSON.');
        return new Response('Invalid JSON', { status: 400 });
      }

      const isStreaming = body.stream === true;
      logger.debug(`Mode: ${isStreaming ? 'Streaming' : 'Non-Streaming'}`);

      // 5. 调用上游 API
      // 使用 client.messages.create
      try {
        const responsePromise = client.messages.create(body);

        if (isStreaming) {
           // 处理流式响应
           const stream = await responsePromise as AsyncIterable<any>;
           
           const readable = new ReadableStream({
             async start(controller) {
               try {
                 for await (const chunk of stream) {
                   // Anthropic SDK 返回的是对象，我们需要将其转换为 SSE 格式
                   // SDK 的 chunk 结构对应 API 的 event data
                   // SDK 会自动处理 event 类型，但这里我们拿到的是解包后的对象
                   // 实际上 client.messages.create({ stream: true }) 返回的是一个 Stream 对象
                   // 这个 Stream 对象迭代出来的就是 event data (JSON Object)
                   // 我们需要手动构造 SSE 格式： `event: <type>\ndata: <json>\n\n`
                   
                   // 注意：anthropic sdk 的 stream iterator 返回的是 MessageStreamEvent
                   const eventType = chunk.type;
                   
                   // 构造 SSE 消息
                   const sseMessage = `event: ${eventType}\ndata: ${JSON.stringify(chunk)}\n\n`;
                   controller.enqueue(new TextEncoder().encode(sseMessage));
                 }
                 // 流结束
                 controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type": "ping"}\n\n')); // Optional keep-alive
                 controller.close();
               } catch (err) {
                 logger.error('Error during streaming iteration:', err);
                 controller.error(err);
               }
             }
           });

           return new Response(readable, {
             headers: {
               'Content-Type': 'text/event-stream',
               'Cache-Control': 'no-cache',
               'Connection': 'keep-alive',
               'Access-Control-Allow-Origin': '*',
             },
           });

        } else {
          // 处理非流式响应
          const result = await responsePromise;
          return new Response(JSON.stringify(result), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

      } catch (apiError: any) {
        logger.error('Upstream API Error:', apiError);
        const status = apiError.status || 500;
        const errorBody = apiError.error || { message: apiError.message };
        return new Response(JSON.stringify(errorBody), {
          status: status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

    } catch (err: any) {
      logger.error('Internal Server Error:', err);
      return new Response(JSON.stringify({ error: { message: 'Internal Proxy Error' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
});

console.log(`Max's Anthropic Proxy running on port ${PORT}`);
console.log(`Debug Mode: ${DEBUG ? 'ON' : 'OFF'}`);
