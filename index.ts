import Anthropic from '@anthropic-ai/sdk';

// DEBUG 开关，默认开启
const DEBUG = process.env.DEBUG !== 'false';

// 日志函数
function debug(...args: any[]) {
  if (DEBUG) {
    console.log('[DEBUG]', new Date().toISOString(), ...args);
  }
}

function info(...args: any[]) {
  console.log('[INFO]', new Date().toISOString(), ...args);
}

function error(...args: any[]) {
  console.error('[ERROR]', new Date().toISOString(), ...args);
}

// 解析凭据的函数
function parseCredentials(headers: Headers): { apiKey: string | null; baseURL: string | null } {
  debug('开始解析凭据...');
  
  // 遍历所有 headers，不区分大小写
  const headerEntries: [string, string][] = [];
  for (const [key, value] of headers.entries()) {
    headerEntries.push([key.toLowerCase(), value]);
  }
  
  debug('所有 headers:', Object.fromEntries(headerEntries));

  // 查找 authorization 或 x-api-key
  let authValue: string | null = null;
  for (const [key, value] of headerEntries) {
    if (key === 'authorization' || key === 'x-api-key') {
      authValue = value;
      debug(`找到认证 header: ${key} = ${value.substring(0, 10)}...`);
      break;
    }
  }

  if (!authValue) {
    debug('未找到认证 header');
    return { apiKey: null, baseURL: null };
  }

  // 检查是否包含 "cc:"
  if (!authValue.includes('cc:')) {
    debug('认证值不包含 "cc:"，返回原始值作为 apiKey');
    return { apiKey: authValue, baseURL: null };
  }

  // 提取 "cc:" 后的内容
  const ccIndex = authValue.indexOf('cc:');
  const ccContent = authValue.substring(ccIndex + 3); // 跳过 "cc:"
  debug(`提取到 cc: 后的内容: ${ccContent}`);

  // 用第一个 "!" 分隔
  const exclamationIndex = ccContent.indexOf('!');
  
  if (exclamationIndex === -1) {
    debug('未找到 "!" 分隔符，整个内容作为 apiKey');
    return { apiKey: ccContent, baseURL: null };
  }

  const apiKey = ccContent.substring(0, exclamationIndex);
  const baseURL = ccContent.substring(exclamationIndex + 1);
  
  debug(`解析结果: apiKey=${apiKey.substring(0, 10)}..., baseURL=${baseURL}`);
  
  return { apiKey, baseURL };
}

// 创建 Anthropic 客户端
function createAnthropicClient(apiKey: string, baseURL: string | null): Anthropic {
  const options: any = {
    apiKey,
    dangerouslyAllowBrowser: true,
  };
  
  if (baseURL) {
    options.baseURL = baseURL;
    debug(`使用自定义 baseURL: ${baseURL}`);
  }
  
  return new Anthropic(options);
}

// 处理流式响应
async function handleStreamingResponse(
  stream: AsyncIterable<any>,
  controller: ReadableStreamDefaultController
) {
  const encoder = new TextEncoder();
  
  try {
    for await (const chunk of stream) {
      const data = `data: ${JSON.stringify(chunk)}\n\n`;
      debug('流式响应块:', chunk.type);
      controller.enqueue(encoder.encode(data));
    }
    
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    debug('流式响应完成');
  } catch (err) {
    error('流式响应错误:', err);
    throw err;
  } finally {
    controller.close();
  }
}

// 主处理函数
async function handleRequest(request: Request): Promise<Response> {
  const startTime = Date.now();
  const requestId = crypto.randomUUID().substring(0, 8);
  
  debug(`[${requestId}] 收到请求: ${request.method} ${request.url}`);
  
  // 只处理 POST 请求到 /v1/messages
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  if (url.pathname !== '/v1/messages') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // 解析凭据
    const { apiKey, baseURL } = parseCredentials(request.headers);
    
    if (!apiKey) {
      error(`[${requestId}] 缺少有效的认证凭据`);
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Missing or invalid authentication credentials',
          },
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 创建 Anthropic 客户端
    const client = createAnthropicClient(apiKey, baseURL);
    
    // 解析请求体
    const body = await request.json();
    debug(`[${requestId}] 请求体:`, {
      model: body.model,
      max_tokens: body.max_tokens,
      stream: body.stream,
      messages_count: body.messages?.length,
    });

    // 判断是否为流式请求
    const isStreaming = body.stream === true;
    
    if (isStreaming) {
      debug(`[${requestId}] 处理流式请求`);
      
      // 创建流式响应
      const stream = new ReadableStream({
        async start(controller) {
          try {
            const messageStream = await client.messages.create({
              ...body,
              stream: true,
            });
            
            await handleStreamingResponse(messageStream, controller);
            
            const duration = Date.now() - startTime;
            info(`[${requestId}] 流式请求完成，耗时: ${duration}ms`);
          } catch (err) {
            error(`[${requestId}] 流式请求错误:`, err);
            const errorData = err instanceof Error ? err.message : String(err);
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ error: errorData })}\n\n`)
            );
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } else {
      debug(`[${requestId}] 处理非流式请求`);
      
      // 非流式请求
      const message = await client.messages.create({
        ...body,
        stream: false,
      });
      
      const duration = Date.now() - startTime;
      info(`[${requestId}] 非流式请求完成，耗时: ${duration}ms`);
      debug(`[${requestId}] 响应:`, {
        id: message.id,
        model: message.model,
        stop_reason: message.stop_reason,
        usage: message.usage,
      });
      
      return new Response(JSON.stringify(message), {
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }
  } catch (err: any) {
    error(`[${requestId}] 请求处理错误:`, err);
    
    // 处理 Anthropic SDK 错误
    if (err instanceof Anthropic.APIError) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: err.type || 'api_error',
            message: err.message,
          },
        }),
        {
          status: err.status || 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // 通用错误
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'internal_error',
          message: err.message || 'Internal server error',
        },
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// 启动服务器
const server = Bun.serve({
  port: 8000,
  async fetch(request) {
    return handleRequest(request);
  },
});

info(`🚀 Claude Messages API 代理服务器启动成功`);
info(`📡 监听端口: ${server.port}`);
info(`🔍 DEBUG 模式: ${DEBUG ? '开启' : '关闭'}`);
info(`💡 使用方法:`);
info(`   1. 标准认证: Authorization: Bearer sk-xxx`);
info(`   2. 代理认证: Authorization: cc:sk-xxx!https://custom-api.com`);
info(`   3. 环境变量: DEBUG=false 关闭调试日志`);
