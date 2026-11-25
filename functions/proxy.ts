const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const TENCENT_SEARCH_SOURCES = new Set(["tencent", "qq", "tx"]);

/**
 * QQ 搜索适配器（洛雪 musicSdk/tx 思路的重新实现，只做搜索，不抄洛雪代码）。
 *
 * 背景：默认 GD 上游对 tencent 直接返回 400 不支持，QQ 搜不到；洛雪桌面版
 * 的搜索本来就不在 .js 脚本里，而在各平台内置适配器里，QQ 用的是
 * 带 zzc 签名的 musics.fcg（DoSearchForQQMusicDesktop）。把这一个平台的
 * 搜索搬到 /proxy 的服务端转发层，搜 QQ 时不再经过 GD 上游。
 * 局限：只解决搜索。歌词/封面/播放地址仍走原有链路（GD 失败时播放靠
 * 洛雪脚本解析 tx 平台），pic_id 沿用 QQ 专辑 mid 以便将来接封面。
 * 注意：source 为 tencent 时，无论 ?apiBase= 指向哪个上游，搜索都走
 * 这个适配器，不再转发给那个上游。
 */
function tencentArtistName(item: any): string {
  const singer = item?.singer;
  if (Array.isArray(singer)) {
    return singer.map((s: any) => (typeof s === "string" ? s : s?.name || "")).filter(Boolean).join(" / ");
  }
  if (typeof singer === "string") return singer;
  return "";
}

function normalizeTencentItem(item: any): any | null {
  if (!item || typeof item !== "object") return null;
  // 洛雪 tx 适配器只保留有 media_mid 的条目（有可播文件）；旧接口条目没有
  // file 字段时不设此门槛，避免把旧接口结果误杀。
  if ("file" in item && !item.file?.media_mid) return null;
  const mid = item.mid || item.songmid || item.id;
  const name = item.title || item.name || item.songname;
  if (!mid || !name) return null;
  const album = item.album && typeof item.album === "object" ? item.album : null;
  return {
    id: String(mid),
    name: String(name),
    artist: tencentArtistName(item) || "未知艺术家",
    album: album?.name || item.albumname || (typeof item.album === "string" ? item.album : ""),
    // interval 为歌曲全长（秒）：播放器用它判断解析出的地址是不是试听片段，
    // 缺了它就无法识别，宁可为 0（跳过判断）也不填错值。
    duration: Number(item.interval) || 0,
    pic_id: album?.mid || item.albummid || "",
    url_id: String(mid),
    lyric_id: String(mid),
    source: "tencent",
  };
}

function findTencentSongList(node: any, depth = 0): any[] | null {
  if (!node || typeof node !== "object" || depth > 4) return null;
  const song = (node as any).song;
  if (song && Array.isArray(song.list)) return song.list;
  if (Array.isArray((node as any).list)) return (node as any).list;
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const found = findTencentSongList(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 洛雪 tx 的 zzc 签名（musicSdk/tx/utils/crypto.js 的同义实现，不抄原文件）：
 * SHA1(请求体) 取指定位字符 + 异或扰动后的 base64，拼成 zzc… 签名。
 * Worker 内用 crypto.subtle 做 SHA1，base64 用 btoa 实现。
 */
const ZZC_PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19];
const ZZC_PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
const ZZC_SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64StripSpecial(bytes: number[]): string {
  const u8 = Uint8Array.from(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  }
  return btoa(binary).replace(/[\\/+=]/g, "");
}

async function zzcSign(text: string): Promise<string> {
  const hash = await sha1Hex(text);
  const part1 = ZZC_PART_1_INDEXES.map((idx) => hash[idx]).join("");
  const part2 = ZZC_PART_2_INDEXES.map((idx) => hash[idx]).join("");
  const scrambled = ZZC_SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16));
  return `zzc${part1}${base64StripSpecial(scrambled)}${part2}`.toLowerCase();
}

function tencentSearchId(): string {
  let guid = "";
  for (let i = 0; i < 32; i++) guid += Math.floor(Math.random() * 16).toString(16);
  return guid.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, "0");
}

/**
 * 带签名的 QQ 搜索（洛雪 tx/musicSearch.js 的请求形状）：POST 到
 * musics.fcg?sign=zzc…，请求体键名即模块名，响应按该键名取回。
 * 无签名的 musicu.fcg 实测返回 sum 0、列表为空，故不用它作首选。
 */
async function searchTencentSigned(keyword: string, count: number, page: number): Promise<any[]> {
  const payload: Record<string, unknown> = {
    comm: {
      _channelid: "0", _os_version: "6.2.9200-2", ct: "19", cv: "2151",
      guid: "1F70E520B2EAA7D25E11760783C53CA9", patch: "118",
      psrf_access_token_expiresAt: 0, psrf_qqaccess_token: "", psrf_qqopenid: "", psrf_qqunionid: "",
      tmeAppID: "qqmusic", tmeLoginType: 0, uin: "0", wid: "7223299733393904640",
    },
    "music.search.SearchCgiService": {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicDesktop",
      param: {
        grp: 1, num_per_page: count, page_num: page, query: keyword,
        remoteplace: "txt.newclient.top", search_type: 0, searchid: tencentSearchId(),
      },
    },
  };
  const bodyText = JSON.stringify(payload);
  const sign = await zzcSign(bodyText);
  const response = await fetchWithTimeout(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "QQMusic 14090508(android 12)",
    },
    body: bodyText,
  }, 10000);
  if (!response.ok) throw new Error(`QQ 签名搜索返回 HTTP ${response.status}`);
  const json: any = await response.json();
  const req = json?.["music.search.SearchCgiService"] ?? json?.req;
  if (!req || json?.code !== 0 || req.code !== 0) {
    throw new Error(`QQ 签名搜索返回异常 code=${json?.code}/${req?.code}`);
  }
  const list = req.data?.body?.song?.list || [];
  return list.map(normalizeTencentItem).filter(Boolean);
}

async function searchTencentViaMusicU(keyword: string, count: number, page: number): Promise<any[]> {
  const payload = {
    comm: { g_tk: 5381, uin: 0, format: "json", inCharset: "utf-8", outCharset: "utf-8", notice: 0, platform: "h5", needNewCode: 1, ct: 24, cv: 0 },
    req_1: {
      method: "DoSearchForQQMusicDesktop",
      module: "music.search.SearchCgiService",
      param: { num_per_page: count, page_num: page, query: keyword, search_type: 0 },
    },
  };
  const response = await fetchWithTimeout("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://y.qq.com/",
      Origin: "https://y.qq.com/",
    },
    body: JSON.stringify(payload),
  }, 10000);
  if (!response.ok) throw new Error(`QQ musicu 返回 HTTP ${response.status}`);
  const json: any = await response.json();
  const list = findTencentSongList(json?.req_1?.data) || findTencentSongList(json) || [];
  return list.map(normalizeTencentItem).filter(Boolean);
}

async function searchTencentViaLegacy(keyword: string, count: number, page: number): Promise<any[]> {
  const params = new URLSearchParams({
    ct: "24", qqmusic_ver: "1298", new_json: "1", remoteplace: "txt.yqq.song",
    searchid: String(Date.now()), t: "0", aggr: "1", cr: "1", catZhida: "1",
    lossless: "0", flag_qc: "0", p: String(page), n: String(count), w: keyword,
    g_tk: "5381", loginUin: "0", hostUin: "0", format: "json",
    inCharset: "utf8", outCharset: "utf-8", notice: "0", platform: "yqq.json", needNewCode: "0",
  });
  const response = await fetchWithTimeout(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://y.qq.com/",
    },
  }, 10000);
  if (!response.ok) throw new Error(`QQ 旧搜索接口返回 HTTP ${response.status}`);
  let text = await response.text();
  const firstParen = text.indexOf("(");
  const lastParen = text.lastIndexOf(")");
  if (text.trimStart().startsWith("callback") && firstParen >= 0 && lastParen > firstParen) {
    text = text.slice(firstParen + 1, lastParen);
  }
  const json: any = JSON.parse(text);
  const list = findTencentSongList(json?.data) || findTencentSongList(json) || [];
  return list.map(normalizeTencentItem).filter(Boolean);
}

async function searchTencent(keyword: string, count: number, page: number): Promise<any[]> {
  let lastError: unknown = null;
  for (const attempt of [searchTencentSigned, searchTencentViaMusicU, searchTencentViaLegacy]) {
    try {
      const results = await attempt(keyword, count, page);
      if (results.length > 0) return results;
    } catch (err) {
      lastError = err;
      console.warn("[QQ搜索] 一路接口失败，尝试下一路:", err);
    }
  }
  if (lastError) throw lastError;
  return [];
}

const KUWO_SEARCH_SOURCES = new Set(["kuwo", "kw"]);

/**
 * 酷我搜索适配器（洛雪 kw/musicSearch.js 的请求形状，无签名）：
 * GET search.kuwo.cn/r.s，响应 abslist 归一化为 GD 形数组。
 * 只解决搜索；歌词/封面/播放地址仍走原有链路。
 */
function decodeKuwoName(raw: string): string {
  return String(raw || "")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function searchKuwo(keyword: string, count: number, page: number): Promise<any[]> {
  const params = new URLSearchParams({
    client: "kt", all: keyword, pn: String(page - 1), rn: String(count),
    uid: "794762570", ver: "kwplayer_ar_9.2.2.1", vipver: "1", show_copyright_off: "1",
    newver: "1", ft: "music", cluster: "0", strategy: "2012", encoding: "utf8",
    rformat: "json", vermerge: "1", mobi: "1", issubtitle: "1",
  });
  const response = await fetchWithTimeout(`http://search.kuwo.cn/r.s?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  }, 10000);
  if (!response.ok) throw new Error(`酷我搜索返回 HTTP ${response.status}`);
  let text = await response.text();
  const firstParen = text.indexOf("(");
  const lastParen = text.lastIndexOf(")");
  if (text.trimStart().startsWith("callback") && firstParen >= 0 && lastParen > firstParen) {
    text = text.slice(firstParen + 1, lastParen);
  }
  const json: any = JSON.parse(text);
  const abslist = Array.isArray(json?.abslist) ? json.abslist : [];
  const results: any[] = [];
  for (const info of abslist) {
    const songId = String(info?.MUSICRID || "").replace(/^MUSIC_/, "");
    const name = decodeKuwoName(info?.SONGNAME || "");
    if (!songId || !name) continue;
    results.push({
      id: songId,
      name,
      artist: decodeKuwoName(info?.ARTIST || "") || "未知艺术家",
      album: decodeKuwoName(info?.ALBUM || ""),
      pic_id: decodeKuwoName(info?.ALBUMID || ""),
      url_id: songId,
      lyric_id: songId,
      source: "kuwo",
    });
  }
  return results;
}

const KUGOU_SEARCH_SOURCES = new Set(["kugou", "kg"]);

/**
 * 酷狗搜索适配器（洛雪 kg/musicSearch.js 的请求形状，无签名）：
 * GET songsearch.kugou.com/song_search_v2，响应 data.lists 归一化为
 * GD 形数组。id 取 FileHash（洛雪脚本解析与 GD 酷狗都以 hash 为键），
 * Grp 子项一并展开并按 Audioid+FileHash 去重。只解决搜索。
 */
function normalizeKugouItem(raw: any): any | null {
  if (!raw || typeof raw !== "object") return null;
  const hash = raw.FileHash || raw.HQFileHash || raw.SQFileHash || "";
  const name = `${decodeKuwoName(raw.OriSongName || raw.SongName || "")}${raw.Suffix ? ` ${decodeKuwoName(raw.Suffix)}` : ""}`.trim();
  if (!hash || !name) return null;
  const singers = Array.isArray(raw.Singers) ? raw.Singers : [];
  const artist = singers.map((s: any) => decodeKuwoName(s?.name || s || "")).filter(Boolean).join(" / ") || decodeKuwoName(raw.SingerName || "") || "未知艺术家";
  return {
    id: String(hash),
    name,
    artist,
    album: decodeKuwoName(raw.AlbumName || ""),
    // Duration 为歌曲全长（秒）：播放器用它判断解析出的地址是不是试听片段。
    duration: Number(raw.Duration) || 0,
    pic_id: raw.AlbumID != null ? String(raw.AlbumID) : "",
    url_id: String(hash),
    lyric_id: String(hash),
    source: "kugou",
  };
}

async function searchKugou(keyword: string, count: number, page: number): Promise<any[]> {
  const params = new URLSearchParams({
    platform: "AndroidFilter", iscorrection: "1", keyword,
    hifiquality: "0", pagesize: String(count), PrivilegeFilter: "0", page: String(page),
  });
  const response = await fetchWithTimeout(`http://songsearch.kugou.com/song_search_v2?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Linux; Android 11; MI 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    },
  }, 10000);
  if (!response.ok) throw new Error(`酷狗搜索返回 HTTP ${response.status}`);
  const json: any = await response.json();
  if (!json || json.error_code !== 0 || !Array.isArray(json.data?.lists)) {
    throw new Error(`酷狗搜索返回异常 error_code=${json?.error_code}`);
  }
  const seen = new Set<string>();
  const results: any[] = [];
  for (const item of json.data.lists) {
    for (const candidate of [item, ...(Array.isArray(item?.Grp) ? item.Grp : [])]) {
      const key = `${candidate?.Audioid || ""}${candidate?.FileHash || ""}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const normalized = normalizeKugouItem(candidate);
      if (normalized) results.push(normalized);
    }
  }
  return results;
}

async function handleKugouSearch(url: URL): Promise<Response> {
  const keyword = (url.searchParams.get("name") || "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "Missing keyword" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count")) || 20));
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("pages")) || 1));
  try {
    const results = await searchKugou(keyword, count, page);
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(results), { status: 200, headers });
  } catch (err) {
    console.warn("[酷狗搜索] 失败:", err);
    return new Response(JSON.stringify({ error: "酷狗搜索失败" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

async function handleKuwoSearch(url: URL): Promise<Response> {  const keyword = (url.searchParams.get("name") || "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "Missing keyword" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count")) || 20));
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("pages")) || 1));
  try {
    const results = await searchKuwo(keyword, count, page);
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(results), { status: 200, headers });
  } catch (err) {
    console.warn("[酷我搜索] 失败:", err);
    return new Response(JSON.stringify({ error: "酷我搜索失败" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

const MIGU_SEARCH_SOURCES = new Set(["migu", "mg"]);

/**
 * 纯 JS MD5（RFC 1321）。Worker 的 crypto.subtle 不提供 MD5，而咪咕搜索
 * 签名要求 MD5，故自带实现；已在 Node 里对照 crypto 验算通过（含中文）。
 */
function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 8, bitLen & 0xffffffff, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const K: number[] = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const add = (x: number, y: number) => (x + y) >>> 0;
  const rol = (x: number, c: number) => ((x << c) | (x >>> (32 - c))) >>> 0;

  for (let off = 0; off < paddedLen; off += 64) {
    const M: number[] = [];
    for (let j = 0; j < 16; j++) M.push(view.getUint32(off + j * 4, true));
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      b = add(b, rol(add(add(add(a, f), K[i]), M[g]), S[i]));
      a = tmp;
    }
    a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d);
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return Array.from(out).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * 咪咕搜索适配器（洛雪 mg/musicSearch.js 的请求形状，MD5 签名）：
 * GET jadeite.migu.cn/music_search/v3/search/searchAll，响应
 * songResultData.resultList（组内数组）归一化为 GD 形数组。
 * id 取 songId，url_id 取 copyrightId（播放解析用），只解决搜索。
 */
async function searchMigu(keyword: string, count: number, page: number): Promise<any[]> {
  const time = Date.now().toString();
  const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
  const sign = md5Hex(`${keyword}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`);
  const params = new URLSearchParams({
    isCorrect: "0", isCopyright: "1",
    searchSwitch: '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}',
    pageSize: String(count), text: keyword, pageNo: String(page), sort: "0", sid: "USS",
  });
  const response = await fetchWithTimeout(`https://jadeite.migu.cn/music_search/v3/search/searchAll?${params.toString()}`, {
    headers: {
      uiVersion: "A_music_3.6.1",
      deviceId,
      timestamp: time,
      sign,
      channel: "0146921",
      "User-Agent": "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30",
    },
  }, 10000);
  if (!response.ok) throw new Error(`咪咕搜索返回 HTTP ${response.status}`);
  const json: any = await response.json();
  if (!json || json.code !== "000000") {
    throw new Error(`咪咕搜索返回异常 code=${json?.code} info=${json?.info || ""}`);
  }
  const groups = json.songResultData?.resultList || [];
  const seen = new Set<string>();
  const results: any[] = [];
  for (const group of groups) {
    for (const data of Array.isArray(group) ? group : [group]) {
      if (!data?.songId || !data?.copyrightId || seen.has(String(data.copyrightId))) continue;
      seen.add(String(data.copyrightId));
      const singers = Array.isArray(data.singerList) ? data.singerList : [];
      const artist = singers.map((s: any) => s?.name || "").filter(Boolean).join(" / ") || "未知艺术家";
      results.push({
        id: String(data.songId),
        name: String(data.name || ""),
        artist,
        album: String(data.album || ""),
        pic_id: data.albumId != null ? String(data.albumId) : "",
        url_id: String(data.copyrightId),
        lyric_id: String(data.songId),
        source: "migu",
      });
    }
  }
  return results;
}

async function handleMiguSearch(url: URL): Promise<Response> {
  const keyword = (url.searchParams.get("name") || "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "Missing keyword" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count")) || 20));
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("pages")) || 1));
  try {
    const results = await searchMigu(keyword, count, page);
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(results), { status: 200, headers });
  } catch (err) {
    console.warn("[咪咕搜索] 失败:", err);
    return new Response(JSON.stringify({ error: "咪咕搜索失败" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

async function handleTencentSearch(url: URL): Promise<Response> {
  const keyword = (url.searchParams.get("name") || "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "Missing keyword" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count")) || 20));
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("pages")) || 1));
  try {
    const results = await searchTencent(keyword, count, page);
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(results), { status: 200, headers });
  } catch (err) {
    console.warn("[QQ搜索] 两路接口均失败:", err);
    return new Response(JSON.stringify({ error: "QQ 搜索失败" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

/**
 * 校验界面传入的自定义上游（`?apiBase=`）。字符串级校验：只放行公网
 * http(s) 地址，拦住本地/内网/元数据地址与带凭证的 URL。
 * 注意：Cloudflare Workers 内无法做 DNS 解析，DNS 重绑定风险由部署方
 * 承担——只在自己信任的部署上使用，且不要把 Solara 暴露给不可信用户。
 */
function isPrivateIpLiteral(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || a === 0 || (a === 169 && b === 254);
  }
  return hostname === "::1" || hostname === "[::1]";
}

export function isSafeApiBaseUrl(raw: string): boolean {
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

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const cache = caches.default;
  
  // 构建缓存 Key（过滤掉随机签名 s 以及强制刷新标记 nocache，以便重试成功后能更新同一个缓存项）
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");
  
  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers
  });

  // 如果是 GET 请求且未指定 nocache 强制刷新，尝试命中缓存
  const bypassCache = url.searchParams.get("nocache") === "true";
  if (request.method === "GET" && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        console.log(`[Cache HIT] ${url.toString()}`);
        const response = new Response(cachedResponse.body, cachedResponse);
        response.headers.set("X-Cache-Status", "HIT");
        response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return response;
      }
    } catch (err) {
      console.warn(`[Cache ERROR] ${url.toString()}`, err);
    }
  }

  console.log(`[Cache MISS] Fetching from upstream: ${url.toString()}`);

  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback" || key === "s" || key === "nocache" || key === "apiBase") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": "Meting/1.5.0",
      "Accept": "application/json",
    },
  });

  const responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  // 判断是否应该缓存：必须是 200 状态，且内容不能是空数组或包含错误标识，且未指定强制刷新
  const isSearch = url.searchParams.get("types") === "search";
  const isEmptyResult = responseText.trim() === "[]";
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');
  
  let shouldCache = upstream.status === 200 && request.method === "GET" && !isError && !bypassCache;
  
  // 如果是搜索请求且结果为空，通常是 API 繁忙或异常，不建议长缓存
  if (isSearch && isEmptyResult) {
    shouldCache = false;
  }

  if (shouldCache) {
    headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  const response = new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  // 写入缓存（不阻塞主流程）
  if (shouldCache && waitUntil) {
    waitUntil(cache.put(cacheKey, response.clone()));
    console.log(`[Cache PUT] Saved to cache: ${url.toString()}`);
  }

  return response;
}

/* ============ 榜单与发现（服务端直取官方接口，1 天缓存） ============ */

/**
 * 榜单只接已实测的官方接口，名字与编号逐一核对过：
 * QQ（c.y.qq.com toplist，topid 28 已核对为网络歌曲榜；29/72 名字未核实，不收录；
 * TVB/KKBOX 无此接口，不收录）；网易云（官方歌单 id）；酷我（kbangserver）。
 * 酷狗榜单接口实测未返回数据、咪咕/JOOX/B站无已验证接口，这些平台返回
 * unsupported，由界面如实显示“暂未接入”，绝不编造榜单数据。
 * 趋势百分比/箭头：上述接口不返回可靠的排名变化字段，v1 只给名次与
 * 时长，不编趋势数据；MV/VIP 角标只按接口明确字段映射。
 */
const CHART_TTL_SECONDS = 86400;

const QQ_CHARTS: Record<string, { topid: number; name: string }> = {
  hot: { topid: 26, name: "热歌榜" },
  new: { topid: 27, name: "新歌榜" },
  soaring: { topid: 62, name: "飙升榜" },
  pop: { topid: 4, name: "流行指数榜" },
  mainland: { topid: 5, name: "内地榜" },
  western: { topid: 3, name: "欧美榜" },
  korea: { topid: 16, name: "韩国榜" },
  japan: { topid: 17, name: "日本榜" },
  hk: { topid: 59, name: "香港地区榜" },
  tw: { topid: 61, name: "台湾地区榜" },
  network: { topid: 28, name: "网络歌曲榜" },
};

const NETEASE_CHARTS: Record<string, { id: string; name: string }> = {
  hot: { id: "3778678", name: "热歌榜" },
  soaring: { id: "19723756", name: "飙升榜" },
  new: { id: "3779629", name: "新歌榜" },
  original: { id: "2884035", name: "原创榜" },
};

const KUWO_CHARTS: Record<string, { id: string; name: string }> = {
  hot: { id: "16", name: "酷我热歌榜" },
};

function beijingDateString(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function clampChartInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function fetchQQToplist(topid: number, offset: number, limit: number): Promise<{ date: string; total: number; songs: any[] }> {
  const songs: any[] = [];
  let total = 0;
  let date = "";
  // QQ 单次最多回 50 条，超了就按 song_begin 分页拉，最多 6 页（300 首）。
  let begin = offset;
  let pages = 0;
  while (songs.length < limit && pages < 6) {
    const want = Math.min(50, offset + limit - begin);
    if (want <= 0) break;
    const params = new URLSearchParams({
      tpl: "3", page: "detail", topid: String(topid), type: "top",
      song_begin: String(begin), song_num: String(want),
      format: "json", inCharset: "utf8", outCharset: "utf-8", notice: "0",
      platform: "yqq.json", needNewCode: "0",
    });
    const response = await fetchWithTimeout(`https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://y.qq.com/",
      },
    }, 10000);
    if (!response.ok) throw new Error(`QQ 榜单返回 HTTP ${response.status}`);
    const json: any = await response.json();
    if (!json || json.code !== 0) throw new Error(`QQ 榜单返回异常 code=${json?.code}`);
    total = Number(json.total_song_num) || total;
    date = String(json.date || date);
    const list = Array.isArray(json.songlist) ? json.songlist : [];
    if (list.length === 0) break;
    list.forEach((entry: any, i: number) => {
      const d = entry?.data;
      if (!d?.songmid || !d?.songname) return;
      const singers = Array.isArray(d.singer) ? d.singer.map((s: any) => s?.name).filter(Boolean).join(" / ") : "";
      const albummid = String(d.albummid || "");
      songs.push({
        rank: begin + i + 1,
        id: String(d.songmid),
        name: String(d.songname),
        artist: singers || "未知艺术家",
        album: String(d.albumname || ""),
        duration: Number(d.interval) || 0,
        pic_id: albummid,
        url_id: String(d.songmid),
        lyric_id: String(d.songmid),
        source: "tencent",
        pic: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : "",
        mv: Boolean(d.vid),
        vip: d?.pay?.payplay === 1,
      });
    });
    pages += 1;
    begin += list.length;
    if (list.length < want) break;
    if (total > 0 && begin >= total) break;
  }
  return { date: date || beijingDateString(), total, songs };
}

async function fetchNeteaseChart(id: string, offset: number, limit: number): Promise<{ date: string; total: number; songs: any[] }> {
  const response = await fetchWithTimeout(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  }, 10000);
  if (!response.ok) throw new Error(`网易云榜单返回 HTTP ${response.status}`);
  const json: any = await response.json();
  const result = json?.result;
  if (!result || !Array.isArray(result.tracks)) throw new Error("网易云榜单返回结构异常");
  const tracks = result.tracks;
  const total = Number(result.trackCount) || tracks.length;
  const slice = tracks.slice(offset, offset + limit);
  const songs = slice.map((t: any, i: number) => ({
    rank: offset + i + 1,
    id: String(t.id),
    name: String(t.name || ""),
    artist: (Array.isArray(t.artists) ? t.artists.map((a: any) => a?.name).filter(Boolean).join(" / ") : "") || "未知艺术家",
    album: String(t.album?.name || ""),
    duration: Math.round(Number(t.duration || t.dt || 0) / 1000),
    pic_id: "",
    url_id: String(t.id),
    lyric_id: String(t.id),
    source: "netease",
    pic: String(t.album?.picUrl || ""),
    mv: Number(t.mv) > 0,
    vip: Number(t.fee) === 1,
  }));
  const updateTime = Number(result.updateTime);
  const date = updateTime ? new Date(updateTime + 8 * 3600 * 1000).toISOString().slice(0, 10) : beijingDateString();
  return { date, total, songs };
}

async function fetchKuwoChart(id: string, offset: number, limit: number): Promise<{ date: string; total: number; songs: any[] }> {
  const songs: any[] = [];
  let total = 0;
  let date = "";
  let begin = offset;
  let pages = 0;
  while (songs.length < limit && pages < 6) {
    const want = Math.min(50, offset + limit - begin);
    if (want <= 0) break;
    const params = new URLSearchParams({
      from: "pc", fmt: "json", pn: String(begin), rn: String(want),
      type: "bang", data: "content", id,
    });
    const response = await fetchWithTimeout(`http://kbangserver.kuwo.cn/ksong.s?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    }, 10000);
    if (!response.ok) throw new Error(`酷我榜单返回 HTTP ${response.status}`);
    const json: any = await response.json();
    const list = Array.isArray(json?.musiclist) ? json.musiclist : [];
    if (list.length === 0) break;
    total = Number(json.num) || total;
    date = String(json.pub || date);
    list.forEach((item: any, i: number) => {
      if (!item?.id || !item?.name) return;
      songs.push({
        rank: begin + i + 1,
        id: String(item.id),
        name: String(item.name),
        artist: String(item.artist || "") || "未知艺术家",
        album: String(item.album || ""),
        duration: Number(item.song_duration) || Number(item.duration) || 0,
        pic_id: item.albumid != null ? String(item.albumid) : "",
        url_id: String(item.id),
        lyric_id: String(item.id),
        source: "kuwo",
        pic: "",
        mv: false,
        vip: false,
        trend: String(item.trend || "").startsWith("u") ? "up" : String(item.trend || "").startsWith("d") ? "down" : "flat",
        trendChange: Number(item.rank_change) || 0,
      });
    });
    pages += 1;
    begin += list.length;
    if (list.length < want) break;
    if (total > 0 && begin >= total) break;
  }
  return { date: date || beijingDateString(), total, songs };
}

function chartCatalogFor(platform: string): Record<string, { name: string }> | null {
  if (platform === "tencent") return QQ_CHARTS;
  if (platform === "netease") return NETEASE_CHARTS;
  if (platform === "kuwo") return KUWO_CHARTS;
  return null;
}

function chartJsonHeaders(cacheable: boolean): Headers {
  const headers = createCorsHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", cacheable
    ? `public, s-maxage=${CHART_TTL_SECONDS}, stale-while-revalidate=${CHART_TTL_SECONDS}`
    : "no-store, no-cache, must-revalidate");
  return headers;
}

async function handleChart(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void): Promise<Response> {
  const platform = (url.searchParams.get("platform") || "tencent").toLowerCase();
  const chart = (url.searchParams.get("chart") || "hot").toLowerCase();
  const offset = clampChartInt(Number(url.searchParams.get("offset")), 0, 0, 10000);
  const limit = clampChartInt(Number(url.searchParams.get("limit")), 50, 1, 300);

  const catalog = chartCatalogFor(platform);
  if (!catalog) {
    return new Response(JSON.stringify({
      platform, chart, name: "", date: beijingDateString(), total: 0, songs: [], unsupported: true,
    }), { status: 200, headers: chartJsonHeaders(false) });
  }
  const def: any = (catalog as Record<string, any>)[chart];
  if (!def) {
    return new Response(JSON.stringify({ error: "Unknown chart" }), {
      status: 400, headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  if (request.method === "GET" && url.searchParams.get("nocache") !== "true") {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("X-Cache-Status", "HIT");
        hit.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return hit;
      }
    } catch (err) {
      console.warn("[榜单缓存] 读缓存失败:", err);
    }
  }

  try {
    let data: { date: string; total: number; songs: any[] };
    if (platform === "tencent") data = await fetchQQToplist(def.topid, offset, limit);
    else if (platform === "netease") data = await fetchNeteaseChart(def.id, offset, limit);
    else data = await fetchKuwoChart(def.id, offset, limit);
    const payload = { platform, chart, name: def.name, date: data.date, total: data.total, songs: data.songs };
    const headers = chartJsonHeaders(data.songs.length > 0);
    headers.set("X-Cache-Status", "MISS");
    headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
    const response = new Response(JSON.stringify(payload), { status: 200, headers });
    if (data.songs.length > 0 && waitUntil) {
      waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  } catch (err) {
    console.warn("[榜单] 获取失败:", err);
    return new Response(JSON.stringify({ error: "榜单获取失败" }), {
      status: 502, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

async function fetchNeteasePersonalized(limit: number): Promise<any[]> {
  const response = await fetchWithTimeout(`https://music.163.com/api/personalized/playlist?limit=${limit}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  }, 10000);
  if (!response.ok) throw new Error(`网易云推荐歌单返回 HTTP ${response.status}`);
  const json: any = await response.json();
  if (!json || json.code !== 200 || !Array.isArray(json.result)) throw new Error("网易云推荐歌单返回结构异常");
  return json.result.map((p: any) => ({
    id: String(p.id),
    name: String(p.name || ""),
    pic: String(p.picUrl || ""),
    playCount: Number(p.playCount) || 0,
    trackCount: Number(p.trackCount) || 0,
  })).filter((p: any) => p.id && p.name);
}

async function handleDiscover(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void): Promise<Response> {
  const platform = (url.searchParams.get("platform") || "tencent").toLowerCase();
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  if (request.method === "GET" && url.searchParams.get("nocache") !== "true") {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("X-Cache-Status", "HIT");
        hit.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return hit;
      }
    } catch (err) {
      console.warn("[发现缓存] 读缓存失败:", err);
    }
  }
  try {
    let sections: any[] = [];
    let date = beijingDateString();
    if (platform === "tencent") {
      const fresh = await fetchQQToplist(27, 0, 9);
      const hot = await fetchQQToplist(26, 0, 9);
      date = fresh.date || hot.date || date;
      sections = [
        { title: "新歌速递", kind: "songs", items: fresh.songs },
        { title: "热门单曲", kind: "songs", items: hot.songs },
      ];
    } else if (platform === "netease") {
      const playlists = await fetchNeteasePersonalized(6);
      const fresh = await fetchNeteaseChart("3779629", 0, 9);
      date = fresh.date || date;
      sections = [
        { title: "推荐歌单", kind: "playlists", items: playlists },
        { title: "新歌榜", kind: "songs", items: fresh.songs },
      ];
    } else if (platform === "kuwo") {
      const hot = await fetchKuwoChart("16", 0, 9);
      date = hot.date || date;
      sections = [{ title: "热歌榜", kind: "songs", items: hot.songs }];
    } else {
      return new Response(JSON.stringify({
        platform, date, sections: [], unsupported: true,
      }), { status: 200, headers: chartJsonHeaders(false) });
    }
    const payload = { platform, date, sections };
    const headers = chartJsonHeaders(true);
    headers.set("X-Cache-Status", "MISS");
    headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
    const response = new Response(JSON.stringify(payload), { status: 200, headers });
    if (waitUntil) waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.warn("[发现] 获取失败:", err);
    return new Response(JSON.stringify({ error: "发现内容获取失败" }), {
      status: 502, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

/* ─── 外部歌单导入：QQ / 酷狗 / 酷我 ────────────────────────────────
   路线与榜单相同：服务端直取各平台公开的歌单接口（做法参考 winterssy /
   mxget、yhsj0919/KMusic 等开源项目公开的接口形态），返回 GD 形态的歌曲
   列表，复用现有播放链路。咪咕 / 哔哩哔哩歌单暂未接入：前者详情页需
   解析内嵌的非标准 JSON，后者音频歌单接口未验证——不返回假数据。 */

const IMPORT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function importPicHttps(pic: string): string {
  return pic ? pic.replace(/^http:\/\//, "https://") : "";
}

async function fetchQQPlaylist(disstid: string): Promise<{ name: string; total: number; songs: any[] }> {
  const params = new URLSearchParams({
    type: "1", json: "1", utf8: "1", onlysong: "0", disstid,
    format: "json", g_tk: "5381", loginUin: "0", hostUin: "0",
    inCharset: "utf8", outCharset: "utf-8", notice: "0", platform: "yqq", needNewCode: "0",
  });
  const response = await fetchWithTimeout(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${params.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": IMPORT_UA, Referer: "https://y.qq.com/" },
  }, 15000);
  if (!response.ok) throw new Error(`QQ 歌单返回 HTTP ${response.status}`);
  const json: any = await response.json();
  const cd = Array.isArray(json?.cdlist) ? json.cdlist[0] : null;
  if (!cd) throw new Error("QQ 歌单无数据");
  const list = Array.isArray(cd.songlist) ? cd.songlist : [];
  const songs = list.filter((s: any) => s?.songmid && s?.songname).slice(0, 300).map((s: any, i: number) => {
    const singers = Array.isArray(s.singer) ? s.singer.map((x: any) => x?.name).filter(Boolean).join(" / ") : "";
    const albummid = String(s.albummid || "");
    return {
      rank: i + 1,
      id: String(s.songmid),
      name: String(s.songname),
      artist: singers || "未知艺术家",
      album: String(s.albumname || s.albumdesc || ""),
      duration: Number(s.interval) || 0,
      pic_id: albummid,
      url_id: String(s.songmid),
      lyric_id: String(s.songmid),
      source: "tencent",
      pic: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : "",
      mv: Boolean(s.vid),
      vip: s?.pay?.payplay === 1,
    };
  });
  return { name: String(cd.dissname || ""), total: Number(cd.songnum) || songs.length, songs };
}

async function fetchKugouPlaylist(specialid: string): Promise<{ name: string; total: number; songs: any[] }> {
  const songs: any[] = [];
  let page = 1;
  while (songs.length < 500 && page <= 5) {
    const params = new URLSearchParams({ specialid, page: String(page), pagesize: "100" });
    const response = await fetchWithTimeout(`http://mobilecdn.kugou.com/api/v3/special/song?${params.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": IMPORT_UA },
    }, 15000);
    if (!response.ok) throw new Error(`酷狗歌单返回 HTTP ${response.status}`);
    const json: any = await response.json();
    if (json?.errcode !== 0) throw new Error(`酷狗歌单返回异常 errcode=${json?.errcode}`);
    const info = Array.isArray(json?.data?.info) ? json.data.info : [];
    if (info.length === 0) break;
    info.forEach((s: any) => {
      const hash = String(s?.hash || "");
      if (!hash) return;
      // 该接口不直接给歌名/歌手字段，从 filename "歌手 - 歌名" 拆分。
      const filename = String(s.filename || "");
      const sep = filename.indexOf(" - ");
      const artist = sep > 0 ? filename.slice(0, sep).trim() : "";
      const name = sep > 0 ? filename.slice(sep + 3).trim() : filename;
      if (!name) return;
      songs.push({
        rank: songs.length + 1,
        id: hash,
        name,
        artist: artist || "未知艺术家",
        album: "",
        duration: Number(s.duration) || 0,
        pic_id: String(s.album_id || ""),
        url_id: hash,
        lyric_id: hash,
        source: "kugou",
        pic: "",
        mv: Boolean(s.mvhash),
        vip: false,
      });
    });
    if (info.length < 100) break;
    page += 1;
  }
  return { name: "", total: songs.length, songs };
}

async function fetchKuwoPlaylist(pid: string): Promise<{ name: string; total: number; songs: any[] }> {
  const songs: any[] = [];
  const seen = new Set<string>();
  let total = 0;
  let pn = 0;
  while (songs.length < 500 && pn < 5) {
    const params = new URLSearchParams({
      op: "getlistinfo", pid, pn: String(pn), rn: "100",
      encode: "utf8", keyset: "pl2012", vipver: "MUSIC_9.1.1.2_BCS2", newver: "1",
    });
    const response = await fetchWithTimeout(`http://nplserver.kuwo.cn/pl.svc?${params.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": IMPORT_UA },
    }, 15000);
    if (!response.ok) throw new Error(`酷我歌单返回 HTTP ${response.status}`);
    const json: any = await response.json();
    const list = Array.isArray(json?.musiclist) ? json.musiclist : [];
    if (pn === 0) total = Number(json?.total) || 0;
    if (list.length === 0) break;
    list.forEach((s: any) => {
      const id = s?.id != null ? String(s.id) : "";
      if (!id || !s?.name || seen.has(id)) return;
      seen.add(id);
      songs.push({
        rank: songs.length + 1,
        id,
        name: String(s.name),
        artist: String(s.artist || "未知艺术家"),
        album: String(s.album || ""),
        duration: Number(s.duration) || 0,
        pic_id: s?.albumid != null ? String(s.albumid) : "",
        url_id: id,
        lyric_id: id,
        source: "kuwo",
        pic: importPicHttps(String(s.albumpic || "")),
        mv: Boolean(s.hasmv),
        vip: false,
      });
    });
    if (total > 0 && songs.length >= total) break;
    if (list.length < 100) break;
    pn += 1;
  }
  return { name: "", total: total || songs.length, songs };
}

async function handleImport(url: URL): Promise<Response> {
  const platform = (url.searchParams.get("platform") || "").toLowerCase();
  const id = (url.searchParams.get("id") || "").trim();
  const bad = (message: string) => new Response(JSON.stringify({ error: message }), {
    status: 400, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
  if (!/^\d+$/.test(id)) return bad("歌单 id 无效");
  if (platform !== "tencent" && platform !== "kugou" && platform !== "kuwo") {
    return bad("该平台歌单暂未接入");
  }
  try {
    const data = platform === "tencent"
      ? await fetchQQPlaylist(id)
      : platform === "kugou"
        ? await fetchKugouPlaylist(id)
        : await fetchKuwoPlaylist(id);
    if (data.songs.length === 0) {
      return new Response(JSON.stringify({ error: "歌单没有取到歌曲" }), {
        status: 502, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(JSON.stringify({ platform, name: data.name, total: data.total, songs: data.songs }), {
      status: 200, headers: chartJsonHeaders(false),
    });
  } catch (err) {
    console.warn("[导入] 获取失败:", err);
    return new Response(JSON.stringify({ error: "歌单获取失败" }), {
      status: 502, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

const SOURCE_STATUS_JSON_URL =
  "https://raw.githubusercontent.com/lovesummersky/cf-anheplayer/main/public/sources-status.json";
const SOURCE_STATUS_TTL_SECONDS = 3600;

/**
 * 音源检测状态：代取 cf-anheplayer 仓库里定时检测生成的 sources-status.json
 * （每 4 小时由 GitHub Actions 实测生成，含各脚本 128k 流可达性）。
 * 供 Solara 前端按“检测通过优先”排序洛雪脚本链。数据不验时长，试听片段
 * 仍靠播放时时长保护拦截；拉取失败/格式异常时前端回落原顺序。
 */
async function handleSourceStatus(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  if (request.method === "GET") {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("X-Cache-Status", "HIT");
        hit.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return hit;
      }
    } catch (err) {
      console.warn("[音源状态] 读缓存失败:", err);
    }
  }
  try {
    const upstream = await fetchWithTimeout(SOURCE_STATUS_JSON_URL, {
      headers: { Accept: "application/json", "User-Agent": "Solara-Proxy/1.0" },
    }, 10000);
    if (!upstream.ok) throw new Error(`状态文件 HTTP ${upstream.status}`);
    const data: any = await upstream.json();
    if (!data || !Array.isArray(data.sources)) throw new Error("状态文件格式异常");
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", `public, s-maxage=${SOURCE_STATUS_TTL_SECONDS}, stale-while-revalidate=${SOURCE_STATUS_TTL_SECONDS}`);
    headers.set("X-Cache-Status", "MISS");
    headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
    const response = new Response(JSON.stringify(data), { status: 200, headers });
    if (waitUntil) waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.warn("[音源状态] 获取失败:", err);
    return new Response(JSON.stringify({ error: "音源状态获取失败" }), {
      status: 502, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

/* ─── 歌词：GD 上游只支持网易云，QQ / 酷狗 / 酷我 / 咪咕走各平台官方歌词接口 ───
   QQ：c.y.qq.com fcg_query_lyric_new.fcg，返回 base64 歌词（UTF-8 解码）。
   酷狗：www.kugou.com getdata，hash 取歌，lyrics 字段 base64。
   酷我：m.kuwo.cn songinfoandlrc，lrclist 转 LRC 文本。
   咪咕：music.migu.cn getLyric，copyrightId 取歌，尽力解析 lyric 字段。
   任一失败返回空歌词（前端如实显示“暂无歌词”），绝不编造。 */

function b64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch { return ""; }
}

async function handleLyric(url: URL): Promise<Response> {
  const source = (url.searchParams.get("source") || "").toLowerCase();
  const id = (url.searchParams.get("id") || "").trim();
  const empty = () => new Response(JSON.stringify({ lyric: "" }), { status: 200, headers: chartJsonHeaders(false) });
  if (!id) return empty();
  try {
    let lyric = "";
    if (source === "tencent") {
      const res = await fetchWithTimeout(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(id)}&format=json&nobase64=0&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`, {
        headers: { Referer: "https://y.qq.com/portal/player.html", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      }, 10000);
      const json: any = await res.json();
      if (json && typeof json.lyric === "string" && json.lyric) lyric = b64ToUtf8(json.lyric);
    } else if (source === "kugou") {
      const dfid = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const res = await fetchWithTimeout(`https://www.kugou.com/yy/index.php?r=play/getdata&hash=${encodeURIComponent(id)}&dfid=${dfid}&appid=1014&mid=${dfid}&platid=4`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", Referer: "https://www.kugou.com/" },
      }, 10000);
      const json: any = await res.json();
      const raw = json?.data?.lyrics;
      if (typeof raw === "string" && raw) lyric = b64ToUtf8(raw);
    } else if (source === "kuwo") {
      const res = await fetchWithTimeout(`https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(id)}`, {
        headers: { Referer: "https://www.kuwo.cn/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      }, 10000);
      const json: any = await res.json();
      const list = json?.data?.lrclist;
      if (Array.isArray(list) && list.length) {
        lyric = list.map((l: any) => {
          const t = Number(l.time) || 0;
          const mm = String(Math.floor(t / 60)).padStart(2, "0");
          const ss = (t % 60).toFixed(2).padStart(5, "0");
          return `[${mm}:${ss}]${l.lineLyric || ""}`;
        }).join("\n");
      }
    } else if (source === "migu") {
      const res = await fetchWithTimeout(`https://music.migu.cn/v3/api/music/audioPlayer/getLyric?copyrightId=${encodeURIComponent(id)}`, {
        headers: { Referer: "https://music.migu.cn/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      }, 10000);
      const json: any = await res.json();
      const raw = typeof json?.lyric === "string" ? json.lyric : (typeof json?.data?.lyric === "string" ? json.data.lyric : "");
      lyric = raw || "";
    }
    return new Response(JSON.stringify({ lyric }), { status: 200, headers: chartJsonHeaders(false) });
  } catch (err) {
    console.warn("[歌词] 获取失败:", err);
    return empty();
  }
}

export async function onRequest({ request, waitUntil, env }: { request: Request, waitUntil: (promise: Promise<any>) => void, env: any }): Promise<Response> {
  // 优先使用环境变量中配置的 API 地址，CF 部署未设置时 fallback 到默认节点；
  // 界面里用户添加并设为“当前生效”的自定义上游（?apiBase=）优先级最高，
  // 但必须通过校验，否则 400，绝不把非法地址当成上游去请求。
  let apiBaseUrl = (typeof env?.API_BASE_URL === "string" && env.API_BASE_URL) ? env.API_BASE_URL : DEFAULT_API_BASE_URL;
  const requestedUrl = new URL(request.url);
  const requestedApiBase = requestedUrl.searchParams.get("apiBase");
  if (requestedApiBase) {
    if (!isSafeApiBaseUrl(requestedApiBase)) {
      return new Response(JSON.stringify({ error: "Invalid apiBase" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    apiBaseUrl = requestedApiBase;
  }
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(target, request);
  }

  // 榜单与发现走服务端直取官方接口（1 天缓存），不经过 GD 上游。
  if (url.searchParams.get("types") === "chart") {
    return handleChart(url, request, waitUntil);
  }
  if (url.searchParams.get("types") === "discover") {
    return handleDiscover(url, request, waitUntil);
  }

  // 外部歌单导入走服务端直取官方接口，不经过 GD 上游。
  if (url.searchParams.get("types") === "import") {
    return handleImport(url);
  }

  // 音源检测状态走服务端代取仓库检测结果（1 小时缓存），不经过 GD 上游。
  if (url.searchParams.get("types") === "status") {
    return handleSourceStatus(url, request, waitUntil);
  }

  // 歌词：GD 只支持网易云，其余平台走官方歌词接口（见 handleLyric）。
  if (url.searchParams.get("types") === "lyric") {
    const lyricSource = (url.searchParams.get("source") || "").toLowerCase();
    if (lyricSource === "tencent" || lyricSource === "kugou" || lyricSource === "kuwo" || lyricSource === "migu") {
      return handleLyric(url);
    }
  }

  // QQ 搜索走洛雪式适配器，不经过 GD 上游（GD 对 tencent 返回 400）。
  if (url.searchParams.get("types") === "search" && TENCENT_SEARCH_SOURCES.has((url.searchParams.get("source") || "").toLowerCase())) {
    return handleTencentSearch(url);
  }

  // 酷我搜索走洛雪式适配器，不经过 GD 上游（GD 对 kuwo 返回 400）。
  if (url.searchParams.get("types") === "search" && KUWO_SEARCH_SOURCES.has((url.searchParams.get("source") || "").toLowerCase())) {
    return handleKuwoSearch(url);
  }

  // 酷狗搜索走洛雪式适配器，不经过 GD 上游（GD 对 kugou 返回 400）。
  // 主界面下拉没有酷狗选项，这路只影响音源检测面板的酷狗药丸。
  if (url.searchParams.get("types") === "search" && KUGOU_SEARCH_SOURCES.has((url.searchParams.get("source") || "").toLowerCase())) {
    return handleKugouSearch(url);
  }

  // 咪咕搜索走洛雪式适配器，不经过 GD 上游（GD 对 migu 返回 400）。
  // 主界面下拉没有咪咕选项，这路只影响音源检测面板的咪咕药丸。
  if (url.searchParams.get("types") === "search" && MIGU_SEARCH_SOURCES.has((url.searchParams.get("source") || "").toLowerCase())) {
    return handleMiguSearch(url);
  }

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
