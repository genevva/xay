import { serve } from "bun";
import Anthropic from "@anthropic-ai/sdk";

// Anthropic 风格错误响应
function errorJSON(type: string, message: string) {
  return JSON.stringify({
    type: "error",
    error: { type, message },
  });
}

type Creds = { authToken: string; baseURL: string };

function extractCreds(headers: Headers): { creds?: Creds; error?: string } {
  let candidate: string | null = null;

  // 遍历全部 headers，保证大小写不敏感
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if ((lower === "authorization" || lower === "x-api-key") && value) {
      if (value.includes("cc:")) {
        candidate = value;
        break;
      }
    }
  }

  if (!candidate) return {};

  // 找到 "cc:"，后面的部分作为自定义负载
  const lowerVal = candidate.toLowerCase();
  const idx = lowerVal.indexOf("cc:");
  if (idx === -1) return {};

  // 注意用原始字符串切（保留大小写，但这里对我们没影响）
  const payload = candidate.slice(idx + 3);
  const bangIdx = payload.indexOf("!");
  if (bangIdx === -1) {
    return { error: 'invalid cc header: missing "!" separator' };
  }

  const authToken = payload.slice(0, bangIdx).trim();
  const baseURL = payload.slice(bangIdx + 1).trim();

  if (!authToken || !baseURL) {
    return { error: "invalid cc header: empty token or base URL" };
  }

  return { creds: { authToken, baseURL } };
}

serve({
  port: 8000,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/messages" && req.method === "POST") {
      // 解析 cc: 凭据
      const { creds, error } = extractCreds(req.headers);
      if (error) {
        return new Response(errorJSON("invalid_request_error", error), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (!creds) {
        return new Response(
          errorJSON(
            "authentication_error",
            'Missing credentials: expected "Authorization" or "X-API-Key" header containing "cc:AUTH_TOKEN!BASE_URL"',
          ),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // 解析请求 JSON（Claude Messages API 参数原样转发）
      let payload: any;
      try {
        payload = await req.json();
      } catch {
        return new Response(
          errorJSON("invalid_request_error", "Request body must be valid JSON"),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // 构造 Anthropic 客户端（每请求一次，使用上游凭据/地址）
      const client = new Anthropic({
        authToken: creds.authToken,
        baseURL: creds.baseURL, // 例如 https://api.anthropic.com
      });

      const isStream = !!payload.stream;

      // 非流式调用：直接转成 JSON 返回
      if (!isStream) {
        try {
          const result = await client.messages.create(payload);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        } catch (err: any) {
          const msg = err?.message ?? "Upstream request failed";
          const status = err?.status ?? 500;
          const type = err?.error?.type ?? "api_error";
          return new Response(errorJSON(type, msg), {
            status,
            headers: { "content-type": "application/json" },
          });
        }
      }

      // 流式调用：转成 SSE 输出（与 Claude Messages API 类似）
      try {
        const upstreamStream = await client.messages.create({
          ...payload,
          stream: true,
        } as any);

        const encoder = new TextEncoder();

        const sseStream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const event of upstreamStream as any) {
                // event.type 如 message_start / content_block_delta 等
                const sseChunk =
                  `event: ${event.type}\n` +
                  `data: ${JSON.stringify(event)}\n\n`;
                controller.enqueue(encoder.encode(sseChunk));
              }
              controller.close();
            } catch (e: any) {
              const sseChunk =
                `event: error\n` +
                `data: ${JSON.stringify({
                  type: "stream_error",
                  message: e?.message ?? String(e),
                })}\n\n`;
              controller.enqueue(encoder.encode(sseChunk));
              controller.close();
            }
          },
        });

        return new Response(sseStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
          },
        });
      } catch (err: any) {
        const msg = err?.message ?? "Failed to start upstream stream";
        const status = err?.status ?? 500;
        const type = err?.error?.type ?? "api_error";
        return new Response(errorJSON(type, msg), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // 其它路径返回 404
    return new Response(errorJSON("not_found", "Not found"), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
});

// Bun 启动：bun run index.ts
