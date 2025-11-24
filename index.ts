import { Anthropic } from "@anthropic-ai/sdk";

console.log("🔥 Max Proxy is running on port 3000...");

Bun.serve({
  port: 3000,
  async fetch(req) {
    // 仅处理 POST 请求
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      // 1. 凭据与上游地址解析逻辑
      let anthropicApiKey: string | undefined;
      let anthropicBaseUrl: string | undefined;

      // 遍历 Headers，忽略大小写
      for (const [key, value] of req.headers.entries()) {
        const lowerKey = key.toLowerCase();

        // 匹配 Authorization 或 x-api-key
        if (lowerKey === "authorization" || lowerKey === "x-api-key") {
          if (value && value.includes("cc:")) {
            // 截取 "cc:" 之后的内容
            // 使用 split 切分一次，防止 token 中也有 cc: 导致错误（虽然极少见）
            const afterCc = value.substring(value.indexOf("cc:") + 3).trim();

            // 尝试用第一个 "!" 进行切分
            const firstExclamationIndex = afterCc.indexOf("!");

            if (firstExclamationIndex !== -1) {
              // 切分成功
              const extractedToken = afterCc.substring(0, firstExclamationIndex);
              const extractedUrl = afterCc.substring(firstExclamationIndex + 1);

              if (extractedToken && extractedUrl) {
                anthropicApiKey = extractedToken;
                anthropicBaseUrl = extractedUrl;
                // 找到有效凭据后跳出循环
                break;
              }
            }
          }
        }
      }

      // 验证是否获取到了必要的配置
      if (!anthropicApiKey || !anthropicBaseUrl) {
        return new Response(
          JSON.stringify({
            error: {
              type: "authentication_error",
              message: "Missing or invalid credentials format (cc:token!url)",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      // 2. 解析请求体
      const body = await req.json();

      // 3. 初始化 Anthropic 客户端 (针对当前请求)
      const client = new Anthropic({
        apiKey: anthropicApiKey,
        baseURL: anthropicBaseUrl,
      });

      // 4. 转发请求逻辑
      // 检查是否开启流式传输
      const isStreaming = body.stream === true;

      if (isStreaming) {
        // 创建流式请求
        const stream = await client.messages.create(body);

        // 将 SDK 的 AsyncIterable 转换为 Web ReadableStream
        const readable = new ReadableStream({
          async start(controller) {
            for await (const chunk of stream) {
              // SDK 返回的是对象，需要转回 SSE 格式的字符串或者直接传 JSON 块
              // Claude SDK 的流返回的是一个个 MessageStreamEvent
              // 为了保持标准的 SSE 格式，我们需要手动构造 event data
              const eventText = `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`;
              controller.enqueue(new TextEncoder().encode(eventText));
            }
            controller.close();
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      } else {
        // 普通请求
        const message = await client.messages.create(body);
        return Response.json(message);
      }

    } catch (error: any) {
      // 错误处理
      console.error("Proxy Error:", error);
      
      // 尝试返回 Anthropic 风格的错误结构
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: error.message || "Internal Server Error",
          },
        }),
        { 
            status: error.status || 500, 
            headers: { "Content-Type": "application/json" } 
        }
      );
    }
  },
});
