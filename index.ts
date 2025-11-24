// server.ts
import Anthropic from "@anthropic-ai/sdk";

type AnthropicConfig = {
  apiKey: string;
  baseURL: string;
};

/**
 * 从 HTTP 请求头中提取 Anthropic 配置信息：
 * - 遍历所有 header，大小写不敏感匹配 `authorization` 或 `x-api-key`
 * - 值中必须包含关键字 `cc:`
 * - 取 `cc:` 之后的部分，以第一个 `!` 分隔：
 *   - 左：apiKey
 *   - 右：baseURL
 */
function extractAnthropicConfig(headers: Headers): AnthropicConfig | null {
  let rawHeaderValue: string | null = null;

  // 遍历所有 header，保证大小写不敏感
  for (const [key, value] of headers) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "authorization" || lowerKey === "x-api-key") {
      if (value && value.includes("cc:")) {
        rawHeaderValue = value;
        break;
      }
    }
  }

  if (!rawHeaderValue) return null;

  const ccIndex = rawHeaderValue.indexOf("cc:");
  if (ccIndex === -1) return null;

  // 取出 "cc:" 之后的内容
  const configPart = rawHeaderValue.slice(ccIndex + 3).trim();
  if (!configPart) return null;

  // 按第一个 "!" 分割
  const bangIndex = configPart.indexOf("!");
  if (bangIndex === -1) return null;

  const apiKey = configPart.slice(0, bangIndex).trim();
  const baseURL = configPart.slice(bangIndex + 1).trim();

  if (!apiKey || !baseURL) return null;

  return { apiKey, baseURL };
}

// Bun 服务器，暴露 Claude Messages API 兼容的端点
const server = Bun.serve({
  port: 8000,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // 只处理 POST /v1/messages
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      return new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "Only POST /v1/messages is supported by this proxy.",
          },
        }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // 从 Header 中提取 apiKey 和 baseURL
    const cfg = extractAnthropicConfig(req.headers);
    if (!cfg) {
      return new Response(
        JSON.stringify({
          error: {
            type: "authentication_error",
            message:
              'Missing or invalid credentials. Expected "cc:<ANTHROPIC_AUTH_TOKEN>!<ANTHROPIC_BASE_URL>" in Authorization or X-API-Key header.',
          },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }

    let body: any;
    try {
      body = await req.json(); // 直接转发 Claude Messages API 请求体
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "Request body must be valid JSON.",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // 创建 Anthropic 客户端，使用上游地址和凭据
    const client = new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL, // 例如：https://api.anthropic.com
    });

    try {
      // 直接调用 Claude Messages API（非流式）
      const upstreamResp = await client.messages.create(body as any);

      return new Response(JSON.stringify(upstreamResp), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    } catch (err: any) {
      console.error("Upstream Anthropic error:", err);

      const status = typeof err?.status === "number" ? err.status : 500;
      const message =
        err?.message ||
        err?.error?.message ||
        "Upstream Anthropic request failed.";

      return new Response(
        JSON.stringify({
          error: {
            type: "upstream_error",
            message,
          },
        }),
        {
          status,
          headers: { "content-type": "application/json" },
        },
      );
    }
  },
});

console.log(`Claude Messages proxy listening on http://localhost:${server.port}`);
