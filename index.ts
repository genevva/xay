import Anthropic from "@anthropic-ai/sdk";

const PORT = 8000;

interface ProxyConfig {
  authToken: string;
  baseURL?: string;
}

// 从 headers 中提取代理配置（不区分大小写）
function extractProxyConfig(headers: Headers): ProxyConfig | null {
  // 遍历所有 headers，查找 authorization 或 x-api-key
  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    
    if ((lowerKey === "authorization" || lowerKey === "x-api-key") && value) {
      // 检查是否包含 "cc:" 关键字
      const ccIndex = value.indexOf("cc:");
      if (ccIndex !== -1) {
        // 提取 "cc:" 之后的内容
        const ccContent = value.substring(ccIndex + 3);
        
        // 尝试用 "!" 分割
        const parts = ccContent.split("!");
        
        if (parts.length >= 1 && parts[0]) {
          return {
            authToken: parts[0],
            baseURL: parts.length >= 2 && parts[1] ? parts[1] : undefined,
          };
        }
      }
    }
  }
  
  return null;
}

// 创建 Anthropic 客户端
function createAnthropicClient(config: ProxyConfig): Anthropic {
  return new Anthropic({
    apiKey: config.authToken,
    baseURL: config.baseURL,
  });
}

// 处理流式响应
async function handleStreamingResponse(
  stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent>,
  writer: WritableStreamDefaultWriter<Uint8Array>
) {
  const encoder = new TextEncoder();
  
  try {
    for await (const event of stream) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      await writer.write(encoder.encode(data));
    }
  } finally {
    await writer.close();
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    
    // 只处理 /v1/messages 路径
    if (url.pathname !== "/v1/messages") {
      return new Response("Not Found", { status: 404 });
    }
    
    // 只支持 POST 方法
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    
    try {
      // 提取代理配置
      const proxyConfig = extractProxyConfig(req.headers);
      
      if (!proxyConfig) {
        return new Response(
          JSON.stringify({
            error: {
              type: "authentication_error",
              message: "Missing or invalid proxy configuration. Please provide authorization or x-api-key header with format 'cc:AUTH_TOKEN!BASE_URL' or 'cc:AUTH_TOKEN'",
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      
      // 解析请求体
      const body = await req.json();
      
      // 创建 Anthropic 客户端
      const client = createAnthropicClient(proxyConfig);
      
      // 检查是否为流式请求
      const isStreaming = body.stream === true;
      
      if (isStreaming) {
        // 流式响应
        const stream = client.messages.stream(body);
        
        const readableStream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            
            try {
              for await (const event of stream) {
                const data = `data: ${JSON.stringify(event)}\n\n`;
                controller.enqueue(encoder.encode(data));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (error: any) {
              const errorData = `data: ${JSON.stringify({ error: { type: "error", message: error.message } })}\n\n`;
              controller.enqueue(encoder.encode(errorData));
            } finally {
              controller.close();
            }
          },
        });
        
        return new Response(readableStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      } else {
        // 非流式响应
        const message = await client.messages.create(body);
        
        return new Response(JSON.stringify(message), {
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (error: any) {
      console.error("Error:", error);
      
      // 处理 Anthropic SDK 错误
      if (error instanceof Anthropic.APIError) {
        return new Response(
          JSON.stringify({
            error: {
              type: error.type || "api_error",
              message: error.message,
            },
          }),
          {
            status: error.status || 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      
      // 通用错误处理
      return new Response(
        JSON.stringify({
          error: {
            type: "internal_error",
            message: error.message || "Internal server error",
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
});

console.log(`🚀 Claude Messages API Proxy running on http://localhost:${PORT}`);
console.log(`\nUsage: Send requests to http://localhost:${PORT}/v1/messages`);
console.log(`Header format: authorization: cc:YOUR_API_KEY!CUSTOM_BASE_URL`);
console.log(`Or: x-api-key: cc:YOUR_API_KEY!CUSTOM_BASE_URL`);
console.log(`Or: x-api-key: cc:YOUR_API_KEY (uses default base URL)\n`);
