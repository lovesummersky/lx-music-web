/**
 * /proxy-fetch：洛雪 Worker 的通用请求代理。
 *
 * POST JSON { url, method, headers, body, timeoutMs }
 * GET  ?url=…（仅 GET、无请求体）
 * 返回 JSON 信封 { statusCode, headers, body, url }，body 始终为字符串。
 *
 * 限制（与 Node 版保持一致）：
 * - 只放行公网 http(s)，拦本地/内网/元数据地址与带凭证的 URL；
 * - 响应体上限 2 MB；音频/视频类响应只读前 8 KB（脚本只看状态与头）；
 * - 超时默认 8 秒、上限 30 秒。
 * 仅供用户自己添加的脚本使用：调用方已登录 Solara，脚本来源须信任。
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MEDIA_BODY_CAP = 8 * 1024;

function isPrivateIpLiteral(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || a === 0 || (a === 169 && b === 254);
  }
  return hostname === "::1" || hostname === "[::1]";
}

function isSafeFetchUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local")
      || hostname === "metadata.google.internal" || isPrivateIpLiteral(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const HOP_HEADERS = new Set(["host", "connection", "content-length", "cookie", "authorization"]);

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  let target = "";
  let method = "GET";
  let headers: Record<string, string> = {};
  let body: unknown = null;
  let timeoutMs = 8000;

  if (request.method === "GET") {
    target = new URL(request.url).searchParams.get("url") || "";
  } else if (request.method === "POST") {
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return jsonResponse({ ok: false, error: "请求体必须是 JSON" }, 400);
    }
    target = typeof payload.url === "string" && payload.url ? payload.url : "";
    if (!target) {
      // 兼容只把 url 放在查询串里的调用方（Worker 旧版 POST 曾这样发）。
      target = new URL(request.url).searchParams.get("url") || "";
    }
    method = typeof payload.method === "string" ? payload.method.toUpperCase() : "GET";
    if (payload.headers && typeof payload.headers === "object") {
      for (const [key, value] of Object.entries(payload.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
    }
    body = payload.body ?? null;
    if (Number.isFinite(payload.timeoutMs)) {
      timeoutMs = Math.min(Math.max(Number(payload.timeoutMs), 1000), 30000);
    }
  } else {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  if (!target || !isSafeFetchUrl(target)) {
    return jsonResponse({ ok: false, error: "无效或不被允许的目标地址" }, 400);
  }
  if (!["GET", "POST", "HEAD"].includes(method)) {
    return jsonResponse({ ok: false, error: "仅支持 GET / POST / HEAD" }, 400);
  }

  const forwardHeaders: Record<string, string> = { "User-Agent": "Solara/2.0 (lx-worker)" };
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_HEADERS.has(key.toLowerCase())) forwardHeaders[key] = value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: forwardHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : (typeof body === "string" ? body : body == null ? undefined : JSON.stringify(body)),
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error && err.name === "AbortError" ? "上游请求超时" : "上游请求失败";
    return jsonResponse({ ok: false, error: message }, 502);
  } finally {
    clearTimeout(timer);
  }

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  const contentType = (responseHeaders["content-type"] || "").toLowerCase();
  const cap = /^(audio|video)\//.test(contentType) ? MEDIA_BODY_CAP : MAX_BODY_BYTES;

  let text = "";
  try {
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > cap) {
            const keep = value.subarray(0, Math.max(0, cap - (total - value.length)));
            if (keep.length) chunks.push(keep);
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
        }
      }
      const merged = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      text = new TextDecoder("utf-8").decode(merged);
    }
  } catch {
    text = "";
  }

  return jsonResponse({
    ok: true,
    statusCode: upstream.status,
    headers: responseHeaders,
    body: text,
    url: upstream.url || target,
  });
}
