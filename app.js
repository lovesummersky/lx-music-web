"use strict";
/* LX Music 网页版（精简版）前端：新写单页应用，无构建步骤。
 * 搜索/歌词/封面走同源 /proxy（Worker）；播放地址走洛雪脚本隔离 Worker，
 * 脚本网络请求经 /proxy-fetch 转发；试听片段保护 + 跨平台代播见 playSong。 */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (s) => { if (!Number.isFinite(s) || s <= 0) return "00:00"; s = Math.floor(s); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOURCE_LABEL = { netease: "网易云", tencent: "QQ", kuwo: "酷我", kugou: "酷狗", migu: "咪咕" };
const LX_PLATFORM = { netease: "wy", tencent: "tx", kuwo: "kw", kugou: "kg", migu: "mg" };
const QUALITY_TO_LX = { "320": "320k", "128": "128k", flac: "flac" };

const DEFAULT_SOURCES = [
  { id: "default-hei", name: "Hei Music聚合源", url: "https://lxmusic.1381886.xyz/sources/d0947a4fe4.js" },
  { id: "default-wending", name: "稳定版音源 v1.0.3", url: "https://lxmusic.1381886.xyz/sources/09382b4b05.js" },
  { id: "default-shouji", name: "收集の聚合接口(LX版)", url: "https://lxmusic.1381886.xyz/sources/e4927e850e.js" },
  { id: "default-xigua", name: "西瓜聚合源", url: "https://lxmusic.1381886.xyz/sources/2f0663b30a.js" },
  { id: "default-xinghai-pdone", name: "星海音乐源 (pdone)", url: "https://raw.githubusercontent.com/pdone/lx-music-source/main/xinghai/latest.js" },
  { id: "default-yuningxi", name: "lx-玉宁熙-Pro", url: "https://lxmusic.1381886.xyz/sources/e4baddc775.js" },
  { id: "default-doubao", name: "豆包定制", url: "https://lxmusic.1381886.xyz/sources/f600412fe0.js" },
  { id: "default-xinghai", name: "星海音乐源", url: "https://lxmusic.1381886.xyz/sources/remote/xinghai.js" },
  { id: "default-huibi", name: "回避聚合 (HuiBi Aggregate)", url: "https://lxmusic.1381886.xyz/sources/2e8e5efc47.js" },
  { id: "default-kulao", name: "裤佬SVIP音源(二改整合版)", url: "https://lxmusic.1381886.xyz/sources/db1633ebdc.js" },
  { id: "default-molan", name: "墨澜聚合音源", url: "https://lxmusic.1381886.xyz/sources/3c9c4b293e.js" },
  { id: "default-xinghai-3217", name: "星海音乐源 v3.2.17", url: "https://lxmusic.1381886.xyz/sources/0b3492d150.js" },
  { id: "default-hyw", name: "HYWmusic_公益版", url: "https://lxmusic.1381886.xyz/sources/5c5f30d31c.js" },
  { id: "default-xinglan", name: "星澜聚合音源 (StellarWave)", url: "https://lxmusic.1381886.xyz/sources/56d2f39627.js" },
  { id: "default-fish", name: "fish_music", url: "https://lxmusic.1381886.xyz/sources/648d5f515a.js" },
];

const LS = { sources: "lxweb.sources.v1", seeded: "lxweb.sourcesSeeded.v1", favs: "lxweb.favorites.v1", queue: "lxweb.queue.v1" };
function lsGet(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

let sources = lsGet(LS.sources, null);
if (!Array.isArray(sources) || !localStorage.getItem(LS.seeded)) {
  sources = DEFAULT_SOURCES.map((s) => ({ ...s, enabled: true, kind: "lx-script" }));
  lsSet(LS.sources, sources); try { localStorage.setItem(LS.seeded, "1"); } catch {}
}
let favorites = lsGet(LS.favs, []);
let queue = lsGet(LS.queue, []);
let results = [];
let currentIndex = -1;
let currentSong = null;
let playMode = "order"; // order | random | single
let playToken = 0;
let lyricsData = [];
let lyricsSongKey = "";

const audio = $("#audio");
const statusEl = $("#status");
function setStatus(t) { if (statusEl) statusEl.textContent = t; }
function setNote(t) { $("#nowNote").textContent = t || ""; }

async function fetchJson(url, timeoutMs = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: { Accept: "application/json" }, signal: c.signal }); const txt = await r.text(); if (!r.ok) throw new Error("HTTP " + r.status); return JSON.parse(txt); }
  finally { clearTimeout(t); }
}
function normSong(raw, fallbackSource) {
  if (!raw || typeof raw !== "object") return null;
  const artistRaw = raw.artist ?? raw.singer ?? "";
  const artist = Array.isArray(artistRaw) ? artistRaw.map((a) => (typeof a === "string" ? a : a?.name || "")).filter(Boolean).join(" / ") : String(artistRaw || "");
  const id = String(raw.id ?? raw.songmid ?? raw.url_id ?? raw.lyric_id ?? "");
  const name = String(raw.name ?? raw.title ?? raw.songname ?? "");
  if (!id || !name) return null;
  return { id, name, artist: artist || "未知艺术家", album: String(raw.album?.name ?? raw.album ?? raw.albumname ?? ""), duration: Number(raw.duration ?? raw.interval ?? (raw.dt ? raw.dt / 1000 : 0)) || 0, pic_id: String(raw.pic_id ?? raw.albummid ?? ""), lyric_id: String(raw.lyric_id ?? id), url_id: String(raw.url_id ?? id), source: String(raw.source || fallbackSource || "netease"), pic: raw.pic || "" };
}

async function searchOne(source, keyword) {
  const params = new URLSearchParams({ types: "search", source, name: keyword, count: "20", pages: "1", s: Math.random().toString(36).slice(2) });
  const data = await fetchJson("/proxy?" + params.toString());
  const arr = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.songs) ? data.songs : []));
  return arr.map((x) => normSong(x, source)).filter(Boolean);
}
async function doSearch() {
  const keyword = $("#keyword").value.trim();
  if (!keyword) { setStatus("先输入歌名或歌手。"); return; }
  showView("search");
  const sel = $("#sourceSelect").value;
  const wanted = sel === "all" ? ["netease", "tencent", "kuwo", "kugou", "migu"] : [sel];
  setStatus("搜索中：" + keyword + "（" + wanted.map((s) => SOURCE_LABEL[s]).join(" / ") + "）…");
  $("#resultList").innerHTML = "";
  const settled = await Promise.allSettled(wanted.map((s) => searchOne(s, keyword)));
  results = []; const failed = [];
  settled.forEach((r, i) => { if (r.status === "fulfilled") results.push(...r.value); else failed.push(SOURCE_LABEL[wanted[i]]); });
  renderResults();
  setStatus(results.length ? ("找到 " + results.length + " 条" + (failed.length ? "；失败：" + failed.join("、") + "（上游波动，换个平台或稍后重试）" : "")) : ("没有结果" + (failed.length ? "；失败：" + failed.join("、") : "") + "。换个关键词或平台试试。"));
}

/* ---------- 洛雪脚本隔离 Worker ---------- */
const workers = new Map();
async function fetchScriptCode(url) {
  const data = await fetchJson("/proxy-source?url=" + encodeURIComponent(url) + "&includeCode=1", 15000);
  if (!data || data.ok !== true || typeof data.code !== "string") throw new Error((data && data.error) || "拉取音源脚本失败");
  return data.code;
}
function ensureWorker(entry) {
  const ex = workers.get(entry.id);
  if (ex) return ex.ready;
  const worker = new Worker("lx-worker.js");
  const rec = { worker, config: null, ready: null };
  rec.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("音源脚本加载超时")), 20000);
    const onMsg = (e) => { const d = e.data || {}; if (d.type === "loaded") { clearTimeout(timer); worker.removeEventListener("message", onMsg); if (!d.hasHandler) { reject(new Error("脚本没有注册 musicUrl 处理函数")); return; } rec.config = d.config || null; resolve(rec); } else if (d.type === "load-error") { clearTimeout(timer); worker.removeEventListener("message", onMsg); reject(new Error(d.message || "脚本加载失败")); } else if (d.type === "inited") { rec.config = d.config || rec.config; } };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", (err) => { clearTimeout(timer); reject(new Error(err.message || "Worker 出错")); }, { once: true });
  });
  workers.set(entry.id, rec);
  fetchScriptCode(entry.url).then((code) => worker.postMessage({ type: "load", code })).catch((err) => { worker.terminate(); workers.delete(entry.id); rec.ready = Promise.reject(err); });
  return rec.ready;
}
function requestMusicUrl(rec, platform, musicInfo, quality) {
  return new Promise((resolve, reject) => {
    const id = "req-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(() => { rec.worker.removeEventListener("message", onMsg); reject(new Error("解析超时")); }, 15000);
    const onMsg = (e) => { const d = e.data || {}; if (d.id !== id) return; clearTimeout(timer); rec.worker.removeEventListener("message", onMsg); if (d.type === "request-result") { const u = String(d.result || "").trim(); if (/^https?:\/\//i.test(u)) resolve(u); else reject(new Error("音源返回了无效地址")); } else reject(new Error(d.message || "解析失败")); };
    rec.worker.addEventListener("message", onMsg);
    rec.worker.postMessage({ type: "request", id, action: "musicUrl", source: platform, info: { musicInfo, type: quality } });
  });
}
function buildLxMusicInfo(song) {
  return { id: song.id, songmid: song.id, hash: song.id, name: song.name, singer: song.artist, artist: song.artist, albumName: song.album, album: song.album, duration: 0, pic: song.pic || "" };
}
async function resolveFromEntry(entry, song, quality) {
  const platform = LX_PLATFORM[song.source] || "wy";
  try {
    const rec = await ensureWorker(entry);
    const srcs = rec.config && rec.config.sources;
    if (srcs && typeof srcs === "object" && !srcs[platform]) return null;
    return await requestMusicUrl(rec, platform, buildLxMusicInfo(song), QUALITY_TO_LX[quality] || "320k");
  } catch (err) { console.warn("音源解析失败 [" + entry.name + "]:", err); return null; }
}

/* ---------- 试听片段探测 + 播放 ---------- */
function probeDuration(url, timeoutMs = 12000) {
  // 返回：秒数（可播且有元数据时长）、null（超时/无时长，未知）、-1（加载出错，地址不可播）。
  return new Promise((resolve) => {
    const a = new Audio(); let done = false;
    const finish = (v) => { if (done) return; done = true; try { a.src = ""; a.load(); } catch {} resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    a.preload = "metadata";
    a.onloadedmetadata = () => { clearTimeout(t); finish(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null); };
    a.onerror = () => { clearTimeout(t); finish(-1); };
    a.src = url;
  });
}
function isSnippet(song, gotSeconds) {
  return Number.isFinite(gotSeconds) && gotSeconds > 0 && song.duration > 30 && gotSeconds < song.duration * 0.7;
}
async function gdFallbackUrl(song, quality) {
  try {
    const params = new URLSearchParams({ types: "url", id: song.url_id || song.id, source: song.source, br: quality, s: Math.random().toString(36).slice(2) });
    const data = await fetchJson("/proxy?" + params.toString(), 15000);
    const u = data?.url || data?.data?.url || (Array.isArray(data) && data[0]?.url) || (typeof data === "string" ? data : null);
    return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
  } catch { return null; }
}
async function findSubstitute(song) {
  // 只对 QQ 歌试一次：同名 + 歌手匹配 + 时长接近的酷我 / 网易云完整版。
  if (song.source !== "tencent") return null;
  for (const src of ["kuwo", "netease"]) {
    try {
      const list = await searchOne(src, song.name);
      const hit = list.find((x) => x.name === song.name && song.artist && x.artist && (x.artist.includes(song.artist.split(" / ")[0]) || song.artist.includes(x.artist.split(" / ")[0])) && (!song.duration || !x.duration || Math.abs(x.duration - song.duration) <= 12));
      if (hit) return hit;
    } catch {}
  }
  return null;
}
async function resolvePlayable(song, quality, token, startIndex = 0, gdTried = false) {
  const enabled = sources.filter((e) => e.enabled);
  let sawSnippet = false;
  for (let i = startIndex; i < enabled.length; i++) {
    const entry = enabled[i];
    if (token !== playToken) return null;
    setStatus("正在解析：" + song.name + " · " + entry.name + "…");
    const url = await resolveFromEntry(entry, song, quality);
    if (!url) continue;
    const dur = await probeDuration(url);
    if (token !== playToken) return null;
    if (dur === -1) { setStatus("“" + entry.name + "”给的地址不可播，换下一个音源…"); continue; }
    if (isSnippet(song, dur)) { sawSnippet = true; setStatus("“" + entry.name + "”只给了 " + Math.round(dur) + " 秒试听片段，换下一个音源…"); continue; }
    return { url, via: entry.name, snippet: false, nextIndex: i + 1, gdTried: false };
  }
  if (gdTried) return { url: null, via: "", snippet: sawSnippet, nextIndex: enabled.length, gdTried: true };
  const fb = await gdFallbackUrl(song, quality);
  if (fb && token === playToken) {
    const dur = await probeDuration(fb);
    if (dur !== -1 && !isSnippet(song, dur)) return { url: fb, via: "默认上游", snippet: false, nextIndex: enabled.length, gdTried: true };
    sawSnippet = true;
  }
  return { url: null, via: "", snippet: sawSnippet, nextIndex: enabled.length, gdTried: true };
}
let activeAttempt = null; // { song, quality, nextIndex, gdTried }
let failoverRunning = false;
async function failoverToNextSource() {
  if (!activeAttempt || failoverRunning) return;
  const attempt = activeAttempt; const token = playToken;
  if (attempt.nextIndex >= sources.filter((e) => e.enabled).length && attempt.gdTried) { setStatus("所有音源都试过了，没有可播地址。"); $("#playBtn").textContent = "▶"; return; }
  failoverRunning = true;
  try {
    const got = await resolvePlayable(attempt.song, attempt.quality, token, attempt.nextIndex, attempt.gdTried);
    if (token !== playToken || !got) return;
    if (got.url) { activeAttempt = { song: attempt.song, quality: attempt.quality, nextIndex: got.nextIndex, gdTried: got.gdTried }; startAudio(got.url, attempt.song); setNote("音源：" + got.via + "（上一地址不可播，已自动切换）"); const link = $("#audioLink"); link.href = got.url; link.hidden = false; setStatus("正在播放：" + attempt.song.name + "（" + got.via + "）"); return; }
    await handleNoUrl(got, attempt.song, token);
  } finally { failoverRunning = false; }
}
async function handleNoUrl(got, song, token) {
  if (got.snippet) {
    setNote("只找到试听片段，尝试跨平台代播…"); setStatus("《" + song.name + "》只有试听片段，正在找同名完整版…");
    const sub = await findSubstitute(song);
    if (token !== playToken) return;
    if (sub) {
      const got2 = await resolvePlayable(sub, $("#qualitySelect").value, token);
      if (token !== playToken || !got2) return;
      if (got2.url) { currentSong = sub; $("#nowTitle").textContent = sub.name; $("#nowArtist").textContent = sub.artist + " · " + SOURCE_LABEL[sub.source]; setCover(sub); loadLyrics(sub); activeAttempt = { song: sub, quality: $("#qualitySelect").value, nextIndex: got2.nextIndex, gdTried: got2.gdTried }; startAudio(got2.url, sub); setNote("《" + song.name + "》QQ只有试听片段，已改播" + SOURCE_LABEL[sub.source] + "完整版（" + got2.via + "）"); setStatus("代播：" + sub.name + " · " + sub.artist); const link = $("#audioLink"); link.href = got2.url; link.hidden = false; return; }
    }
    setNote("全部音源都只有试听片段，已跳过。"); setStatus("《" + song.name + "》全部音源都只有试听片段。");
    await sleep(800); if (token === playToken) playNext(true); return;
  }
  setNote("没有可用的播放地址。"); setStatus("《" + song.name + "》解析失败：音源都没有返回可播地址，换个音质或音源再试。");
  $("#playBtn").textContent = "▶";
}

async function playSong(song, list, index) {
  if (!song) return;
  if (song.localId) { playLocalSong(song, list, index); return; }
  if (Array.isArray(list)) { queue = list.slice(); currentIndex = index; lsSet(LS.queue, queue); renderQueue(); }
  currentSong = song; playToken++;
  const token = playToken;
  activeAttempt = null;
  $("#nowTitle").textContent = song.name; $("#nowArtist").textContent = song.artist + (song.album ? " · " + song.album : "") + " · " + SOURCE_LABEL[song.source]; setNote(""); setCover(song); loadLyrics(song);
  $("#playBtn").textContent = "⏸"; renderResults(); renderFavs();
  const quality = $("#qualitySelect").value;
  const got = await resolvePlayable(song, quality, token);
  if (token !== playToken || !got) return;
  if (got.url) { activeAttempt = { song, quality, nextIndex: got.nextIndex, gdTried: got.gdTried }; startAudio(got.url, song); setNote("音源：" + got.via); const link = $("#audioLink"); link.href = got.url; link.hidden = false; setStatus("正在播放：" + song.name + "（" + got.via + "）"); return; }
  activeAttempt = null;
  await handleNoUrl(got, song, token);
}
function startAudio(url, song) {
  audio.src = url; audio.volume = $("#volume").value / 100;
  audio.play().then(() => { $("#playBtn").textContent = "⏸"; }).catch((e) => {
    $("#playBtn").textContent = "▶";
    const msg = String((e && e.message) || e || "");
    if (/no supported source|failed to load|notsupported|MEDIA_ELEMENT_SRC_NOT_SUPPORTED/i.test(msg) || (e && e.name === "NotSupportedError")) { setStatus("当前地址不可播，正在自动换下一个音源…"); void failoverToNextSource(); return; }
    setStatus("播放被浏览器拦截或地址不可用：" + msg);
  });
}
function playNext(auto) {
  if (!queue.length) return;
  if (playMode === "random") { let n; do { n = Math.floor(Math.random() * queue.length); } while (queue.length > 1 && n === currentIndex); currentIndex = n; }
  else if (playMode === "single" && !auto) { /* 单曲：手动下一首仍前进 */ currentIndex = (currentIndex + 1) % queue.length; }
  else { currentIndex = (currentIndex + 1) % queue.length; if (currentIndex === 0 && auto && queue.length === 1) { audio.pause(); return; } }
  playSong(queue[currentIndex], null, currentIndex);
}
function playPrev() { if (!queue.length) return; currentIndex = (currentIndex - 1 + queue.length) % queue.length; playSong(queue[currentIndex], null, currentIndex); }

/* ---------- 封面与歌词 ---------- */
async function setCover(song) {
  const cover = $("#cover"); cover.textContent = "♪"; cover.querySelector("img")?.remove();
  try {
    let url = "";
    if (song.source === "tencent" && song.pic_id) url = "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + song.pic_id + ".jpg";
    else {
      const params = new URLSearchParams({ types: "pic", id: song.pic_id || song.id, source: song.source, size: "300", s: Math.random().toString(36).slice(2) });
      const r = await fetch("/proxy?" + params.toString());
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("image")) { url = URL.createObjectURL(await r.blob()); }
      else { const d = await r.json().catch(() => null); url = d?.url || d?.data?.url || ""; }
    }
    if (url) { const img = document.createElement("img"); img.src = url; img.alt = ""; img.onerror = () => img.remove(); cover.textContent = ""; cover.appendChild(img); }
  } catch {}
}
function parseLrc(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/); if (!m) continue;
    out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}
async function loadLyrics(song) {
  lyricsData = []; lyricsSongKey = song.source + ":" + song.lyric_id; $("#lyricTitle").textContent = "歌词 · " + song.name;
  const body = $("#lyricsBody"); body.innerHTML = '<div class="hint">歌词加载中…</div>';
  try {
    const params = new URLSearchParams({ types: "lyric", id: song.lyric_id || song.id, source: song.source, s: Math.random().toString(36).slice(2) });
    const data = await fetchJson("/proxy?" + params.toString(), 15000);
    const text = data?.lyric || data?.lrc?.lyric || data?.data?.lyric || "";
    lyricsData = parseLrc(text);
    body.innerHTML = lyricsData.length ? lyricsData.map((l, i) => '<div data-i="' + i + '" data-time="' + l.t + '">' + esc(l.text || "♪") + "</div>").join("") : '<div class="hint">暂无歌词</div>';
  } catch { body.innerHTML = '<div class="hint">歌词加载失败</div>'; }
}
function syncLyrics() {
  if (!lyricsData.length) return;
  const t = audio.currentTime; let idx = -1;
  for (let i = 0; i < lyricsData.length; i++) if (lyricsData[i].t <= t) idx = i;
  const body = $("#lyricsBody"); const divs = body.querySelectorAll("div[data-i]");
  divs.forEach((d) => d.classList.toggle("current", Number(d.dataset.i) === idx));
  const cur = body.querySelector(".current"); if (cur) cur.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ---------- 列表渲染 ---------- */
function songRow(song, i, ctx) {
  const fav = favorites.some((f) => f.id === song.id && f.source === song.source);
  const playing = currentSong && currentSong.id === song.id && currentSong.source === song.source;
  return '<li class="' + (playing ? "playing" : "") + '"><div class="song-thumb t' + (i % 5) + '">' + (i + 1) + '</div><div><div class="song-name">' + esc(song.name) + '</div><div class="song-meta">' + esc(song.artist) + (song.album ? " · " + esc(song.album) : "") + " · " + (SOURCE_LABEL[song.source] || "本地") + (song.duration ? " · " + fmtTime(song.duration) : "") + "</div></div>" +
    '<div class="song-actions"><button type="button" data-act="play" data-ctx="' + ctx + '" data-i="' + i + '">▶ 播放</button><button type="button" data-act="queue" data-ctx="' + ctx + '" data-i="' + i + '">+ 队列</button><button type="button" data-act="fav" data-ctx="' + ctx + '" data-i="' + i + '">' + (fav ? "★ 已收藏" : "☆ 收藏") + '</button><button type="button" data-act="plist" data-ctx="' + ctx + '" data-i="' + i + '">＋歌单</button></div></li>';
}
function renderResults() { $("#resultList").innerHTML = results.map((s, i) => songRow(s, i, "results")).join(""); $("#queueCount").textContent = queue.length ? "(" + queue.length + ")" : ""; }
function renderQueue() { $("#queueList").innerHTML = queue.map((s, i) => songRow(s, i, "queue")).join("") || '<li class="hint">队列为空，先搜索并播放一首歌。</li>'; $("#queueCount").textContent = queue.length ? "(" + queue.length + ")" : ""; }
function renderFavs() { $("#favList").innerHTML = favorites.map((s, i) => songRow(s, i, "favs")).join("") || '<li class="hint">还没有收藏。</li>'; }
function listFor(ctx) { if (ctx === "results") return results; if (ctx === "queue") return queue; if (ctx === "charts") return chartSongs; if (ctx === "discover") return discoverSongs; if (ctx === "playlist") return activePlaylistSongs(); if (ctx === "local") return localSongs; if (ctx === "history") return historySongs; return favorites; }
function toggleFav(song) {
  const k = favorites.findIndex((f) => f.id === song.id && f.source === song.source);
  if (k >= 0) favorites.splice(k, 1); else favorites.push(song);
  lsSet(LS.favs, favorites); renderResults(); renderQueue(); renderFavs();
}
document.addEventListener("click", (e) => {
  const lyricLine = e.target.closest("#lyricsBody div[data-time]");
  if (lyricLine) { audio.currentTime = Number(lyricLine.dataset.time) || 0; if (audio.paused) audio.play().catch(() => {}); return; }
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const song = listFor(btn.dataset.ctx)[Number(btn.dataset.i)]; if (!song) return;
  if (btn.dataset.act === "play") playSong(song, listFor(btn.dataset.ctx), Number(btn.dataset.i));
  else if (btn.dataset.act === "queue") { queue.push(song); lsSet(LS.queue, queue); renderQueue(); setStatus("已加入队列：" + song.name); }
  else if (btn.dataset.act === "fav") toggleFav(song);
  else if (btn.dataset.act === "plist") addSongToActivePlaylist(song);
});

/* ---------- 音源管理 ---------- */
function renderSources() {
  $("#sourceList").innerHTML = sources.map((s, i) => '<li><input type="checkbox" data-src-toggle="' + i + '" ' + (s.enabled ? "checked" : "") + ' aria-label="启用"><div style="flex:1;min-width:200px"><div class="src-name">' + esc(s.name) + '</div><div class="src-url">' + esc(s.url) + "</div></div>" +
    '<button type="button" data-src-up="' + i + '">↑</button><button type="button" data-src-down="' + i + '">↓</button><button type="button" data-src-del="' + i + '">删除</button></li>').join("");
  $("#sourceStatus").textContent = "共 " + sources.length + " 条，已启用 " + sources.filter((s) => s.enabled).length + " 条。";
}
document.addEventListener("change", (e) => {
  const t = e.target.closest("[data-src-toggle]"); if (!t) return;
  sources[Number(t.dataset.srcToggle)].enabled = t.checked; lsSet(LS.sources, sources); renderSources();
});
document.addEventListener("click", (e) => {
  const up = e.target.closest("[data-src-up]"), down = e.target.closest("[data-src-down]"), del = e.target.closest("[data-src-del]");
  if (up) { const i = Number(up.dataset.srcUp); if (i > 0) { [sources[i - 1], sources[i]] = [sources[i], sources[i - 1]]; lsSet(LS.sources, sources); renderSources(); } }
  if (down) { const i = Number(down.dataset.srcDown); if (i < sources.length - 1) { [sources[i + 1], sources[i]] = [sources[i], sources[i + 1]]; lsSet(LS.sources, sources); renderSources(); } }
  if (del) { const s = sources[Number(del.dataset.srcDel)]; sources.splice(Number(del.dataset.srcDel), 1); const w = workers.get(s.id); if (w) { try { w.worker.terminate(); } catch {} workers.delete(s.id); } lsSet(LS.sources, sources); renderSources(); }
});
async function addSource() {
  const url = $("#newSourceUrl").value.trim();
  if (!/^https?:\/\//i.test(url)) { $("#sourceStatus").textContent = "先粘贴一个 http(s) 脚本地址。"; return; }
  if (sources.some((s) => s.url === url)) { $("#sourceStatus").textContent = "这条已经在列表里了。"; return; }
  $("#sourceStatus").textContent = "正在验证脚本…";
  try {
    const data = await fetchJson("/proxy-source?url=" + encodeURIComponent(url), 15000);
    if (!data || data.ok !== true) throw new Error(data?.error || "不是可识别的洛雪脚本");
    const entry = { id: "custom-" + Date.now().toString(36), name: data.name || data.meta?.name || "自定义音源", url, enabled: true, kind: "lx-script" };
    sources.push(entry); lsSet(LS.sources, sources); renderSources();
    $("#newSourceUrl").value = ""; $("#sourceStatus").textContent = "已添加：" + entry.name + "（只验证了它是洛雪脚本、能上报 musicUrl，不代表今天能解析出地址）。";
  } catch (err) { $("#sourceStatus").textContent = "添加失败：" + (err?.message || err); }
}

/* ---------- 视图 / 播放器事件 ---------- */
function showView(name) {
  document.querySelectorAll(".nav-btn").forEach((x) => x.classList.toggle("active", x.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
}
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => { showView(b.dataset.view); }));
$("#searchBtn").addEventListener("click", doSearch);
$("#keyword").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
$("#addSourceBtn").addEventListener("click", addSource);
$("#resetSourcesBtn").addEventListener("click", () => { sources = DEFAULT_SOURCES.map((s) => ({ ...s, enabled: true, kind: "lx-script" })); lsSet(LS.sources, sources); try { localStorage.setItem(LS.seeded, "1"); } catch {} renderSources(); $("#sourceStatus").textContent = "已恢复默认 15 条。"; });
$("#clearQueueBtn").addEventListener("click", () => { queue = []; lsSet(LS.queue, queue); renderQueue(); });
$("#playBtn").addEventListener("click", () => { if (!currentSong) { if (queue.length) playSong(queue[0], null, 0); return; } if (audio.paused) audio.play().catch(() => {}); else audio.pause(); });
$("#nextBtn").addEventListener("click", () => playNext(false));
$("#prevBtn").addEventListener("click", playPrev);
$("#modeBtn").addEventListener("click", () => { playMode = playMode === "order" ? "random" : playMode === "random" ? "single" : "order"; $("#modeBtn").textContent = playMode === "order" ? "🔁 顺序" : playMode === "random" ? "🔀 随机" : "🔂 单曲"; $("#modeBtn").title = "播放模式：" + $("#modeBtn").textContent; });
$("#lyricsBtn").addEventListener("click", () => $("#lyricsPanel").classList.toggle("hidden"));
$("#closeLyricsBtn").addEventListener("click", () => $("#lyricsPanel").classList.add("hidden"));
$("#favBtn").addEventListener("click", () => { if (currentSong) toggleFav(currentSong); });
$("#volume").addEventListener("input", (e) => { audio.volume = e.target.value / 100; });
$("#seek").addEventListener("input", (e) => { if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = (e.target.value / 1000) * audio.duration; });
audio.addEventListener("play", () => { $("#playBtn").textContent = "⏸"; });
audio.addEventListener("pause", () => { $("#playBtn").textContent = "▶"; });
audio.addEventListener("timeupdate", () => { $("#curTime").textContent = fmtTime(audio.currentTime); if (Number.isFinite(audio.duration) && audio.duration > 0) $("#seek").value = Math.round((audio.currentTime / audio.duration) * 1000); syncLyrics(); });
audio.addEventListener("loadedmetadata", () => { $("#totalTime").textContent = fmtTime(audio.duration); });
audio.addEventListener("ended", () => { if (playMode === "single") { audio.currentTime = 0; audio.play().catch(() => {}); } else playNext(true); });
audio.addEventListener("error", () => { if (currentSong && activeAttempt) { setStatus("音频加载失败，正在自动换下一个音源…"); void failoverToNextSource(); } else if (currentSong) { setStatus("音频加载失败（地址过期或被拦截），点下一首或换个音源再试。"); } });

renderResults(); renderQueue(); renderFavs(); renderSources();
setStatus("就绪。默认 15 条音源已载入（本浏览器），搜一首歌试试。");

/* ============ 新增功能：榜单 / 发现 / 歌单导入 / 多歌单 / 历史 / 本地音乐 / 主题 / 倍速 / 定时 / 全屏与弹出歌词 / 下载 / 音源检测 ============ */
let chartSongs = [];
let discoverSongs = [];
let historySongs = lsGet("lxweb.history.v1", []);
let playlists = lsGet("lxweb.playlists.v1", []);
let localSongs = [];
let localObjectUrl = "";

const CHARTS = {
  tencent: [["hot", "热歌榜"], ["new", "新歌榜"], ["soaring", "飙升榜"], ["pop", "流行指数榜"], ["mainland", "内地榜"], ["western", "欧美榜"], ["korea", "韩国榜"], ["japan", "日本榜"], ["hk", "香港地区榜"], ["tw", "台湾地区榜"], ["network", "网络歌曲榜"]],
  netease: [["hot", "热歌榜"], ["soaring", "飙升榜"], ["new", "新歌榜"], ["original", "原创榜"]],
  kuwo: [["hot", "酷我热歌榜"]],
};
function refreshChartSelect() {
  const p = $("#chartPlatform").value;
  $("#chartSelect").innerHTML = CHARTS[p].map(([v, n]) => '<option value="' + v + '">' + esc(n) + "</option>").join("");
}
async function loadChart() {
  const platform = $("#chartPlatform").value, chart = $("#chartSelect").value;
  $("#chartStatus").textContent = "榜单加载中…";
  try {
    const data = await fetchJson("/proxy?types=chart&platform=" + platform + "&chart=" + chart + "&limit=50", 25000);
    if (data.error) throw new Error(data.error);
    chartSongs = (data.songs || []).map((x) => normSong(x, platform)).filter(Boolean);
    $("#chartList").innerHTML = chartSongs.map((s, i) => songRow(s, i, "charts")).join("");
    $("#chartStatus").textContent = (data.name || chart) + " · " + (data.date || "") + " · 共 " + (data.total || chartSongs.length) + " 首（显示前 " + chartSongs.length + " 首）";
  } catch (e) { $("#chartStatus").textContent = "榜单加载失败：" + (e?.message || e); }
}
async function loadDiscover() {
  const platform = $("#discoverPlatform").value;
  $("#discoverStatus").textContent = "发现加载中…"; $("#discoverBody").innerHTML = ""; discoverSongs = [];
  try {
    const data = await fetchJson("/proxy?types=discover&platform=" + platform, 25000);
    if (data.error) throw new Error(data.error);
    let html = "";
    for (const sec of (data.sections || [])) {
      html += '<div class="discover-section"><h3>' + esc(sec.title || "") + "</h3>";
      if (sec.kind === "songs") {
        const start = discoverSongs.length;
        const songs = (sec.items || []).map((x) => normSong(x, platform)).filter(Boolean);
        discoverSongs.push(...songs);
        html += '<ol class="song-list">' + songs.map((s, j) => songRow(s, start + j, "discover")).join("") + "</ol>";
      } else {
        for (const p of (sec.items || [])) {
          html += '<div class="playlist-card">' + (p.pic ? '<img src="' + esc(p.pic) + '" alt="">' : "") + "<div><div><b>" + esc(p.name || "") + "</b></div><div class=\"hint\">" + (p.trackCount ? p.trackCount + " 首 · " : "") + (p.playCount ? "播放 " + p.playCount + " 次" : "") + " · 网易云推荐歌单暂未接入导入</div></div></div>";
        }
      }
      html += "</div>";
    }
    $("#discoverBody").innerHTML = html || '<p class="hint">暂无内容。</p>';
    $("#discoverStatus").textContent = "发现 · " + (data.date || "");
  } catch (e) { $("#discoverStatus").textContent = "发现加载失败：" + (e?.message || e); }
}
async function importPlaylist() {
  const platform = $("#importPlatform").value;
  const raw = $("#importId").value.trim();
  const nums = raw.match(/\d+/g);
  const id = nums ? nums[nums.length - 1] : "";
  if (!id) { $("#importStatus").textContent = "先填歌单 id 或含 id 的歌单链接。"; return; }
  $("#importStatus").textContent = "导入中…";
  try {
    const data = await fetchJson("/proxy?types=import&platform=" + platform + "&id=" + encodeURIComponent(id), 30000);
    if (data.error) throw new Error(data.error);
    const songs = (data.songs || []).map((x) => normSong(x, platform)).filter(Boolean);
    if (!songs.length) throw new Error("歌单没有取到歌曲");
    const pl = { id: "pl-" + Date.now().toString(36), name: data.name || ("歌单 " + id), songs };
    playlists.push(pl); lsSet("lxweb.playlists.v1", playlists); renderPlaylists();
    $("#importStatus").textContent = "已导入：" + pl.name + "（" + songs.length + " 首），见“我的歌单”。";
  } catch (e) { $("#importStatus").textContent = "导入失败：" + (e?.message || e); }
}

/* 多歌单 */
function activePlaylistSongs() {
  const sel = $("#activePlaylistSelect");
  const pl = playlists.find((p) => p.id === (sel ? sel.value : ""));
  return pl ? pl.songs : [];
}
function renderPlaylists() {
  const sel = $("#activePlaylistSelect");
  sel.innerHTML = playlists.map((p) => '<option value="' + p.id + '">' + esc(p.name) + "（" + p.songs.length + "）</option>").join("");
  if (!playlists.length) sel.innerHTML = '<option value="">（暂无歌单）</option>';
  const songs = activePlaylistSongs();
  $("#playlistSongs").innerHTML = songs.map((s, i) => songRow(s, i, "playlist")).join("") || '<li class="hint">歌单为空：用“＋歌单”从搜索结果加歌，或用上方按钮把搜索结果/队列全部加入。</li>';
  renderHistory();
}
function renderHistory() {
  $("#historyList").innerHTML = historySongs.map((s, i) => songRow(s, i, "history")).join("") || '<li class="hint">还没有播放记录。</li>';
}
function addSongToActivePlaylist(song) {
  if (!playlists.length) playlists.push({ id: "pl-" + Date.now().toString(36), name: "默认歌单", songs: [] });
  const pl = playlists.find((p) => p.id === $("#activePlaylistSelect").value) || playlists[0];
  if (!pl.songs.some((s) => s.id === song.id && s.source === song.source)) pl.songs.push(song);
  lsSet("lxweb.playlists.v1", playlists); renderPlaylists();
  setStatus("已加入歌单《" + pl.name + "》：" + song.name);
}
function addAllToActivePlaylist(list, label) {
  if (!playlists.length) playlists.push({ id: "pl-" + Date.now().toString(36), name: "默认歌单", songs: [] });
  const pl = playlists.find((p) => p.id === $("#activePlaylistSelect").value) || playlists[0];
  let added = 0;
  for (const s of list) if (!pl.songs.some((x) => x.id === s.id && x.source === s.source)) { pl.songs.push(s); added++; }
  lsSet("lxweb.playlists.v1", playlists); renderPlaylists();
  setStatus(label + "已加入《" + pl.name + "》" + added + " 首（去重后）。");
}

/* 本地音乐：IndexedDB 存文件 Blob */
function openLocalDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("lxweb-local", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("files", { keyPath: "localId" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(rec) { const db = await openLocalDb(); return new Promise((res, rej) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbAll() { const db = await openLocalDb(); return new Promise((res, rej) => { const tx = db.transaction("files", "readonly"); const q = tx.objectStore("files").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); }
async function idbGet(id) { const db = await openLocalDb(); return new Promise((res, rej) => { const tx = db.transaction("files", "readonly"); const q = tx.objectStore("files").get(id); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); }
async function idbDelete(id) { const db = await openLocalDb(); return new Promise((res, rej) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbClear() { const db = await openLocalDb(); return new Promise((res, rej) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
function fileDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file); const a = new Audio(); let done = false;
    const fin = (v) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(v); };
    const t = setTimeout(() => fin(0), 10000);
    a.preload = "metadata"; a.onloadedmetadata = () => { clearTimeout(t); fin(Number.isFinite(a.duration) ? a.duration : 0); }; a.onerror = () => { clearTimeout(t); fin(0); }; a.src = url;
  });
}
function renderLocal() {
  $("#localList").innerHTML = localSongs.map((s, i) => songRow(s, i, "local").replace("</div></li>", '<button type="button" data-local-del="' + s.localId + '">删除</button></div></li>')).join("") || '<li class="hint">本地库为空：点“选择音频文件”添加。文件只存在本浏览器，不上传。</li>';
  $("#localStatus").textContent = "共 " + localSongs.length + " 个本地文件。";
}
async function loadLocalSongs() {
  try { const recs = await idbAll(); localSongs = recs.map((r) => r.meta).sort((a, b) => String(a.name).localeCompare(String(b.name), "zh")); }
  catch { localSongs = []; }
  renderLocal();
}
async function addLocalFiles(files) {
  let added = 0;
  for (const file of files) {
    const base = file.name.replace(/\.[^.]+$/, "");
    const parts = base.split(/\s*-\s*/);
    const meta = { localId: "local-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6), id: "", name: parts.length > 1 ? parts.slice(1).join(" - ") : base, artist: parts.length > 1 ? parts[0] : "本地音乐", album: "", duration: 0, source: "local", pic_id: "", lyric_id: "", url_id: "" };
    meta.id = meta.localId;
    meta.duration = await fileDuration(file);
    await idbPut({ localId: meta.localId, meta, file });
    added++;
  }
  await loadLocalSongs();
  $("#localStatus").textContent = "已添加 " + added + " 个文件，共 " + localSongs.length + " 个。";
}
async function playLocalSong(song, list, index) {
  if (Array.isArray(list)) { queue = list.slice(); currentIndex = index; lsSet(LS.queue, queue); renderQueue(); }
  currentSong = song; playToken++; activeAttempt = null;
  $("#nowTitle").textContent = song.name; $("#nowArtist").textContent = song.artist + " · 本地音乐"; setNote("本地文件"); $("#cover").textContent = "♪"; $("#cover").querySelector("img")?.remove();
  $("#lyricsBody").innerHTML = '<div class="hint">本地歌曲暂无歌词</div>'; lyricsData = [];
  setStatus("正在播放本地文件：" + song.name);
  const rec = await idbGet(song.localId);
  if (!rec) { setStatus("本地文件找不到了，可能已被浏览器清理，请重新添加。"); return; }
  if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
  localObjectUrl = URL.createObjectURL(rec.file);
  startAudio(localObjectUrl, song);
  const link = $("#audioLink"); link.href = localObjectUrl; link.hidden = true;
  renderResults(); renderFavs(); renderLocal();
}

/* 主题 / 倍速 / 定时 / 下载 / 歌词窗 */
function applyTheme(t) { if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else document.documentElement.removeAttribute("data-theme"); try { localStorage.setItem("lxweb.theme.v1", t); } catch {} }
let sleepTimer = null;
function currentLyricLine(t) { let line = ""; for (const l of lyricsData) if (l.t <= t) line = l.text; return line; }
let lastNowWrite = 0;
function writeNowPlaying() {
  const now = Date.now(); if (now - lastNowWrite < 1000) return; lastNowWrite = now;
  try { localStorage.setItem("lxweb.now.v1", JSON.stringify({ title: currentSong ? currentSong.name : "", artist: currentSong ? currentSong.artist : "", line: currentLyricLine(audio.currentTime), cur: Math.floor(audio.currentTime || 0), dur: Math.floor(audio.duration || 0), playing: !audio.paused })); } catch {}
}
function syncOverlay() {
  if ($("#lyricOverlay").classList.contains("hidden")) return;
  $("#overlayTitle").textContent = currentSong ? currentSong.name + " · " + currentSong.artist : "";
  $("#overlayLine").textContent = currentLyricLine(audio.currentTime) || "—";
  const divs = $("#overlayList").querySelectorAll("div[data-time]");
  let idx = -1; for (let i = 0; i < lyricsData.length; i++) if (lyricsData[i].t <= audio.currentTime) idx = i;
  divs.forEach((d, i) => d.classList.toggle("current", i === idx));
}
function openOverlay() {
  $("#overlayList").innerHTML = lyricsData.map((l) => '<div data-time="' + l.t + '">' + esc(l.text || "♪") + "</div>").join("") || '<div class="hint">暂无歌词</div>';
  $("#lyricOverlay").classList.remove("hidden"); syncOverlay();
}
function openLyricPopup() {
  const w = window.open("", "_blank", "width=520,height=360");
  if (!w) { setStatus("弹出窗口被浏览器拦截了，请允许本站弹出窗口后再试。"); return; }
  w.document.write('<!doctype html><meta charset="utf-8"><title>LX 歌词窗</title><body style="background:#0b0d10;color:#f2f3f5;font-family:system-ui;text-align:center;padding:24px"><h2 id="t" style="font-size:18px"></h2><div id="l" style="font-size:26px;font-weight:800;color:#7db4ff;margin:20px 0"></div><div id="p" style="color:#999"></div><script>setInterval(function(){try{var d=JSON.parse(localStorage.getItem("lxweb.now.v1")||"{}");document.getElementById("t").textContent=(d.title||"未在播放")+(d.artist?" · "+d.artist:"");document.getElementById("l").textContent=d.line||"—";document.getElementById("p").textContent=(d.playing?"▶ ":"⏸ ")+Math.floor((d.cur||0)/60)+":"+String((d.cur||0)%60).padStart(2,"0")+" / "+Math.floor((d.dur||0)/60)+":"+String((d.dur||0)%60).padStart(2,"0");}catch(e){}},500);<\/script>');
  w.document.close();
  setStatus("歌词窗已弹出（跟随当前播放，每秒刷新；关掉主页面歌词窗就停了）。");
}

/* 音源检测：只证明“能返回地址”，不验时长 */
async function testAllSources() {
  const enabled = sources.filter((e) => e.enabled);
  if (!enabled.length) { $("#sourceStatus").textContent = "没有已启用的音源。"; return; }
  $("#sourceStatus").textContent = "检测中（QQ《稻香》探针，并行 " + enabled.length + " 条）…";
  const probe = { id: "003aAYrm3GE0Ac", name: "稻香", artist: "周杰伦", album: "魔杰座", duration: 223, source: "tencent" };
  const results = await Promise.allSettled(enabled.map(async (entry) => {
    const url = await resolveFromEntry(entry, probe, "320");
    return { name: entry.name, ok: !!url };
  }));
  const ok = [], bad = [];
  results.forEach((r, i) => {
    const entry = enabled[i];
    if (r.status === "fulfilled" && r.value.ok) ok.push(entry.name);
    else bad.push(entry.name);
  });
  $("#sourceStatus").textContent = "检测完成（只代表能返回地址，不验是不是整首）：通过 " + ok.length + " 条（" + ok.join("、") + "）；失败 " + bad.length + " 条（" + bad.join("、") + "）。";
}

/* 事件绑定 */
$("#chartPlatform").addEventListener("change", refreshChartSelect);
$("#loadChartBtn").addEventListener("click", loadChart);
$("#loadDiscoverBtn").addEventListener("click", loadDiscover);
$("#importBtn").addEventListener("click", importPlaylist);
$("#createPlaylistBtn").addEventListener("click", () => { const name = $("#newPlaylistName").value.trim(); if (!name) return; playlists.push({ id: "pl-" + Date.now().toString(36), name, songs: [] }); lsSet("lxweb.playlists.v1", playlists); $("#newPlaylistName").value = ""; renderPlaylists(); });
$("#activePlaylistSelect").addEventListener("change", renderPlaylists);
$("#addResultsToPlaylistBtn").addEventListener("click", () => addAllToActivePlaylist(results, "搜索结果"));
$("#addQueueToPlaylistBtn").addEventListener("click", () => addAllToActivePlaylist(queue, "播放队列"));
$("#playPlaylistBtn").addEventListener("click", () => { const songs = activePlaylistSongs(); if (songs.length) playSong(songs[0], songs, 0); });
$("#deletePlaylistBtn").addEventListener("click", () => { const id = $("#activePlaylistSelect").value; playlists = playlists.filter((p) => p.id !== id); lsSet("lxweb.playlists.v1", playlists); renderPlaylists(); });
$("#exportPlaylistsBtn").addEventListener("click", () => { const blob = new Blob([JSON.stringify(playlists, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "lx-music-web-playlists.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
$("#importPlaylistsFile").addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { const data = JSON.parse(await f.text()); if (!Array.isArray(data)) throw new Error("格式不对"); playlists = data.filter((p) => p && typeof p.name === "string" && Array.isArray(p.songs)).map((p) => ({ id: p.id || ("pl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)), name: p.name, songs: p.songs })); lsSet("lxweb.playlists.v1", playlists); renderPlaylists(); setStatus("已导入 " + playlists.length + " 个歌单。"); } catch (err) { setStatus("导入失败：" + (err?.message || err)); } e.target.value = ""; });
$("#localFiles").addEventListener("change", (e) => { if (e.target.files.length) void addLocalFiles(Array.from(e.target.files)); e.target.value = ""; });
$("#playAllLocalBtn").addEventListener("click", () => { if (localSongs.length) playSong(localSongs[0], localSongs, 0); });
$("#clearLocalBtn").addEventListener("click", async () => { await idbClear(); localSongs = []; renderLocal(); setStatus("本地库已清空。"); });
document.addEventListener("click", async (e) => { const del = e.target.closest("[data-local-del]"); if (!del) return; const id = del.dataset.localDel; await idbDelete(id); localSongs = localSongs.filter((s) => s.localId !== id); renderLocal(); });
$("#themeBtn").addEventListener("click", () => { const cur = document.documentElement.dataset.theme; applyTheme(cur === "dark" ? "light" : "dark"); });
$("#rateSelect").addEventListener("change", (e) => { audio.playbackRate = Number(e.target.value) || 1; });
$("#sleepSelect").addEventListener("change", (e) => { if (sleepTimer) clearTimeout(sleepTimer); const m = Number(e.target.value); if (m > 0) { sleepTimer = setTimeout(() => { audio.pause(); setStatus("睡眠定时到了，已暂停。"); e.target.value = "0"; }, m * 60000); setStatus("睡眠定时：" + m + " 分钟后暂停。"); } });
$("#downloadBtn").addEventListener("click", () => {
  if (!currentSong) { setStatus("先播放一首歌，拿到地址后才能下载。"); return; }
  const filename = ((currentSong.artist ? currentSong.artist + " - " : "") + currentSong.name).replace(/[\\/:*?"<>|]/g, "_");
  const link = $("#audioLink");
  if (!link.href || link.href === "#") { setStatus("先播放一首歌，拿到地址后才能下载。"); return; }
  if (currentSong.localId) {
    const a = document.createElement("a"); a.href = link.href; a.download = filename + ".mp3"; document.body.appendChild(a); a.click(); a.remove();
    setStatus("本地文件直接保存：" + filename); return;
  }
  if (link.hidden) { setStatus("先播放一首歌，拿到地址后才能下载。"); return; }
  const quality = $("#qualitySelect").value;
  const params = new URLSearchParams({ url: link.href, title: currentSong.name, artist: currentSong.artist || "", format: quality === "flac" ? "flac" : "mp3" });
  const a = document.createElement("a"); a.href = "/download?" + params.toString(); a.download = filename + (quality === "flac" ? ".flac" : ".mp3"); document.body.appendChild(a); a.click(); a.remove();
  setStatus("开始下载（经本站中转，文件名带歌名）：" + filename);
});
$("#fullLyricBtn").addEventListener("click", openOverlay);
$("#closeOverlayBtn").addEventListener("click", () => $("#lyricOverlay").classList.add("hidden"));
$("#overlayList").addEventListener("click", (e) => { const d = e.target.closest("div[data-time]"); if (d) { audio.currentTime = Number(d.dataset.time) || 0; if (audio.paused) audio.play().catch(() => {}); } });
$("#popLyricBtn").addEventListener("click", openLyricPopup);
$("#testAllSourcesBtn").addEventListener("click", () => { void testAllSources(); });
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.view === "charts" && !chartSongs.length) void loadChart();
  if (b.dataset.view === "discover") void loadDiscover();
  if (b.dataset.view === "playlists") renderPlaylists();
  if (b.dataset.view === "local") void loadLocalSongs();
}));
audio.addEventListener("timeupdate", () => { syncOverlay(); writeNowPlaying(); });
audio.addEventListener("play", () => { if (currentSong && !currentSong.localId) { if (historySongs[0]?.id !== currentSong.id || historySongs[0]?.source !== currentSong.source) { historySongs.unshift(currentSong); historySongs = historySongs.slice(0, 50); lsSet("lxweb.history.v1", historySongs); renderHistory(); } } });

/* 初始化新增部分 */
refreshChartSelect();
applyTheme((() => { try { return localStorage.getItem("lxweb.theme.v1") || ""; } catch { return ""; } })());
renderPlaylists();
renderHistory();
void loadLocalSongs();
