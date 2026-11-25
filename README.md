# LX Music 网页版（精简版）

洛雪音乐桌面版（`lovesummersky/lx-music-desktop`，上游 `lyswhut/lx-music-desktop` v2.12.6，Electron + Vue 3）的精简网页版，跑在 Cloudflare Pages + Functions（Worker）上。

## 为什么不是原样移植

桌面版原样跑不到 Worker 上：渲染进程直接调 Electron IPC、数据存在主进程 `better-sqlite3` 的 SQLite 里、自定义音源跑在隐藏 Electron 窗口的 `window.lx` 沙箱里，网络/文件/托盘/快捷键全是 Node/Electron 能力。Worker 免费档每请求 10ms CPU、128MB 内存、无磁盘、无常驻进程。

本项目是新写的单页前端 + 已实测的 Worker 代理层，不是 733 个文件的逐行移植。

## 结构

- `index.html` / `styles.css` / `app.js`：单页播放器，无构建步骤。搜索、队列、收藏、歌词、音源管理。
- `lx-worker.js`：洛雪脚本隔离 Worker（`globalThis.lx` 最小 shim，网络请求经 `/proxy-fetch` 转发，直接 `fetch` 被禁）。
- `functions/proxy.ts`：搜索适配器。QQ / 酷我 / 酷狗 / 咪咕按洛雪内置思路重写（QQ 带 zzc 签名），网易云搜索 / 歌词 / 封面走默认 GD 上游；另含榜单、歌单导入、音源状态代取。
- `functions/proxy-fetch.ts`：脚本通用请求代理，只放行公网 http(s)，拦内网/元数据地址，响应体上限 2MB。
- `functions/proxy-source.ts`：拉取并校验洛雪脚本（头部元数据 + `musicUrl` 能力），只返回元数据或原文，不存脚本。
- `functions/download.ts`：下载中转，流式取回音频并以“歌手 - 歌名”文件名直接保存，只放行音乐 CDN 域名。
- `DEPLOY.md`：Cloudflare 部署完整步骤（控制台上传 / Wrangler / 接 GitHub 自动部署 / 自定义域名 / 验证清单）。

## 功能与取舍

- 做：5 平台搜索、播放、队列/收藏（localStorage）、同步歌词、音质切换、自定义音源添加/排序/禁用、试听片段保护、QQ 只有片段时跨平台代播一次。
- 不做：本地歌曲、数据同步、服务端下载、桌面歌词窗、托盘、全局快捷键、登录。
- 试听片段保护：解析地址先看元数据时长，不到全长七成判片段，换下一个音源；元数据拿不到时长时无法判断。
- 安全边界：Worker 隔离的是 DOM/凭证，不是代码本身——脚本仍可执行任意计算并经其上游发包，只添加信任来源的脚本。

## 部署

Cloudflare Pages 直接上传部署（本目录即部署目录，含 `functions/`）：

```text
wrangler pages deploy . --project-name lx-music-web
```

或在 Pages 控制台选“直接上传”。生产分支 `main`。无环境变量必填；网易云上游默认 `https://music-api.gdstudio.xyz/api.php`，可在 Functions 环境变量 `API_BASE_URL` 覆盖。

完整部署步骤（含控制台上传、Wrangler、接 GitHub 自动部署、自定义域名、验证清单）见 [DEPLOY.md](DEPLOY.md)。

本地验证搜索代理可用 `wrangler pages dev .`（需安装 wrangler）。
