/* 下载中转：GET /download?url=<已解析音频地址>&title=<歌名>&artist=<歌手>&format=mp3|flac|m4a
 * 浏览器忽略跨域 <a download> 的文件名，CDN 直链只能在新标签页播放。
 * 本接口以本站同源流式取回音频，返回 Content-Disposition: attachment，
 * 浏览器直接保存为“歌手 - 歌名.后缀”。不缓存、不落盘、不缓冲整文件。
 * 安全：只放行已知音乐 CDN 域名后缀，http / 内网 / 其他域名一律 400，
 * 绝不做通用下载代理。 */

const DOWNLOAD_HOST_SUFFIXES = [
  ".qq.com", ".tc.qq.com", ".qqmusic.qq.com",
  ".kugou.com",
  ".kuwo.cn",
  ".126.net", ".163.com",
  ".migu.cn",
  ".music.163.com",
];

function downloadHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return DOWNLOAD_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
}

function sanitizeFilePart(value: string): string {
  return (value || "").replace(/[\u0000-\u001f\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function extForContentType(contentType: string, fallback: string): string {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (ct === "audio/flac" || ct === "audio/x-flac") return "flac";
  if (ct === "audio/mpeg" || ct === "audio/mp3") return "mp3";
  if (ct === "audio/mp4" || ct === "audio/x-m4a") return "m4a";
  if (ct === "audio/ogg") return "ogg";
  if (ct === "audio/wav" || ct === "audio/x-wav") return "wav";
  if (ct === "audio/aac") return "aac";
  return fallback;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

function refererFor(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host.endsWith(".qq.com") || host.endsWith(".tc.qq.com")) return "https://y.qq.com/";
  if (host.endsWith(".kugou.com")) return "https://www.kugou.com/";
  if (host.endsWith(".kuwo.cn")) return "https://www.kuwo.cn/";
  if (host.endsWith(".126.net") || host.endsWith(".163.com")) return "https://music.163.com/";
  if (host.endsWith(".migu.cn")) return "https://music.migu.cn/";
  return "https://lx-music-web-2wu.pages.dev/";
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") return jsonError("Method not allowed", 405);

  const url = new URL(request.url);
  const target = url.searchParams.get("url") || "";
  const title = sanitizeFilePart(url.searchParams.get("title") || "");
  const artist = sanitizeFilePart(url.searchParams.get("artist") || "");
  const formatParam = (url.searchParams.get("format") || "").toLowerCase();
  const formatFallback = ["mp3", "flac", "m4a", "ogg", "wav", "aac"].includes(formatParam) ? formatParam : "mp3";

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonError("url 无效", 400);
  }
  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") return jsonError("只支持 http/https 音频地址", 400);
  if (!downloadHostAllowed(targetUrl.hostname)) return jsonError("该音频域名不在下载放行范围", 400);
  if (!title) return jsonError("缺少歌名", 400);

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "audio/*,*/*;q=0.8",
        Referer: refererFor(targetUrl.hostname),
      },
    });
  } catch {
    return jsonError("音频拉取失败", 502);
  }
  if (!upstream.ok || !upstream.body) return jsonError(`音频拉取失败：HTTP ${upstream.status}`, 502);

  const contentType = upstream.headers.get("content-type") || "audio/mpeg";
  // 上游没返回音频（例如反盗链页 / 验证页）时拒绝，绝不把 HTML 存成 .mp3。
  if (!/^audio\//.test(contentType.split(";")[0].trim().toLowerCase()) && contentType.split(";")[0].trim().toLowerCase() !== "application/octet-stream") {
    return jsonError("上游未返回音频内容", 502);
  }
  const ext = extForContentType(contentType, formatFallback);
  const baseName = artist ? `${artist} - ${title}` : title;
  const filename = `${baseName}.${ext}`;
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_") || "download.mp3";
  const disposition = `attachment; filename="${asciiFallback.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", disposition);
  headers.set("Cache-Control", "no-store");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Content-Disposition");
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  const range = upstream.headers.get("content-range");
  if (range) headers.set("Content-Range", range);

  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
}
