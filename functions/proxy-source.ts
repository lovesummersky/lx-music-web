/**
 * GET /proxy-source?url=<洛雪音源脚本地址>[&includeCode=1]
 *
 * 服务端拉取脚本并解析头部元数据（@name/@version/@author/@description），
 * 校验它确实是洛雪脚本（引用 globalThis.lx 且上报 musicUrl）。
 * 默认只返回元数据；Worker 加载时用 includeCode=1 取原文。
 * 脚本原文不写入任何存储，前端也只存 URL + 元数据。
 */

const MAX_CODE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

function isPrivateIpLiteral(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || a === 0 || (a === 169 && b === 254);
  }
  return hostname === "::1" || hostname === "[::1]";
}

function isSafeScriptUrl(raw: string): boolean {
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

function parseHeaderField(code: string, field: string): string {
  const match = code.match(new RegExp(`@\\s*${field}\\s+([^\\r\\n*]+)`, "i"));
  return match ? match[1].trim().replace(/\s*\*\/\s*$/, "").trim() : "";
}

function parsePlatforms(code: string): string[] {
  // 脚本上报形如：wy: "网易云音乐", tx: "QQ音乐", kw: "酷我音乐"…
  const found = new Set<string>();
  const block = code.match(/PLATFORM_NAMES\s*=\s*\{([\s\S]{0,600}?)\}/);
  if (block) {
    for (const m of block[1].matchAll(/\b(wy|tx|kw|kg|mg)\s*:/g)) found.add(m[1]);
  }
  if (found.size === 0) {
    for (const m of code.matchAll(/["'](wy|tx|kw|kg|mg)["']\s*:/g)) found.add(m[1]);
  }
  return Array.from(found);
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("url") || "";
  if (!target || !isSafeScriptUrl(target)) {
    return jsonResponse({ ok: false, error: "无效的脚本地址" }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: { "User-Agent": "Solara/2.0", Accept: "text/javascript,application/javascript,text/plain,*/*" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error && err.name === "AbortError" ? "拉取脚本超时" : "拉取脚本失败，请检查地址与网络";
    return jsonResponse({ ok: false, error: message }, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    return jsonResponse({ ok: false, error: `脚本地址返回 HTTP ${upstream.status}` }, 502);
  }
  const contentLength = Number(upstream.headers.get("content-length") || "0");
  if (contentLength > MAX_CODE_BYTES) {
    return jsonResponse({ ok: false, error: "脚本文件过大（超过 2 MB）" }, 502);
  }
  const code = await upstream.text();
  if (code.length > MAX_CODE_BYTES) {
    return jsonResponse({ ok: false, error: "脚本文件过大（超过 2 MB）" }, 502);
  }

  const looksLikeLx = code.includes("globalThis.lx") && code.includes("EVENT_NAMES");
  const supportsMusicUrl = looksLikeLx && code.includes("musicUrl");
  if (!looksLikeLx) {
    return jsonResponse({ ok: false, error: "该文件不是洛雪音源脚本（未找到 globalThis.lx / EVENT_NAMES）" }, 422);
  }

  const meta = {
    name: parseHeaderField(code, "name"),
    version: parseHeaderField(code, "version"),
    author: parseHeaderField(code, "author"),
    description: parseHeaderField(code, "description"),
    platforms: parsePlatforms(code),
    supportsMusicUrl,
  };

  const result: Record<string, unknown> = {
    ok: true,
    url: target,
    ...meta,
    codeSize: code.length,
  };
  if (url.searchParams.get("includeCode") === "1") {
    result.code = code;
  }
  return jsonResponse(result);
}
