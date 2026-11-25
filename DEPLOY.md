# 在 Cloudflare 上部署 LX Music 网页版

本项目是纯静态单页 + Cloudflare Pages Functions（TypeScript），**不需要构建步骤、不需要 KV / D1 / R2、不需要绑卡**，免费档即可跑。部署目录就是仓库根目录（含 `functions/`）。

## 方法 A：控制台直接上传（本次实际用的方式）

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/) → Workers & Pages → Create → Pages → **Upload assets（直接上传）**。
2. 项目名填 `lx-music-web`，把仓库整个目录（`index.html`、`styles.css`、`app.js`、`lx-worker.js`、`functions/`）上传。
3. 生产分支填 `main`，点 Deploy。完成后得到 `https://<项目名>.pages.dev`（如 `lx-music-web-2wu.pages.dev`）。
4. 以后每次改代码，重新上传整个目录即可；旧部署不会自动更新。

## 方法 B：Wrangler 命令行

```bash
# 首次需登录：npx wrangler login
npx wrangler pages deploy . --project-name lx-music-web
```

`.` 即仓库根目录；`functions/` 会被 Pages 自动识别为 Functions，不用另外配置。

## 方法 C：接 GitHub 自动部署（推荐长期维护）

1. Pages → Create → Pages → **Connect to Git**，选本仓库，分支 `main`。
2. 构建设置：框架预设选 None（或不选），**构建命令留空**，**构建输出目录填 `.`**（根目录，因为 `index.html` 就在根目录）。
3. 保存后每次 push 到 `main` 都会自动重新部署。

## 环境变量（可选，无必填）

在 Pages 项目 → Settings → Environment variables 里设置，改完要重新部署：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `API_BASE_URL` | 覆盖网易云搜索 / 歌词 / 封面的上游地址 | `https://music-api.gdstudio.xyz/api.php` |

QQ / 酷我 / 酷狗 / 咪咕的搜索走 Worker 内置适配器，不走这个上游。

## 自定义域名

1. Pages 项目 → Custom domains → Set up a custom domain，输入域名（如 `lx.ilove.de5.net`）。
2. 如果该域名的 DNS 区就在同一个 Cloudflare 账号里托管（Full setup），一般会自动配好记录，等验证与证书签发完成（状态从 `pending` 变成 `active`）即可访问。
3. 如果状态一直是 `pending` 并提示 CNAME 未设置，手动加一条 DNS 记录：类型 **CNAME**，名称填子域名部分（如 `lx`），目标填 `<项目名>.pages.dev`，代理状态 **Proxied**。保存后验证与证书会自动完成。
4. 生效前原 `*.pages.dev` 地址不受影响，照常可用。

## 上线后验证清单

```text
首页 200：                                    GET /
搜索可用：                                   GET /proxy?types=search&source=tencent&name=%E7%A8%BB%E9%A6%99&count=3&pages=1
榜单可用：                                   GET /proxy?types=chart&platform=tencent&chart=hot&limit=3
音源脚本校验可用：                           GET /proxy-source?url=<脚本地址的 URL 编码>
下载接口拒绝非法域名（应返回 400）：         GET /download?url=https://example.com/x.mp3&title=xx
```

最后在浏览器里实际播一首歌：应能自动换源播出整首、进度正常推进、歌词正常显示。

## 限制与注意事项

- Worker 免费档：每请求 10ms CPU、每天 10 万次请求；脚本解析超时（加载 20 秒 / 解析 15 秒）属平台限制。
- `/download` 是流式中转，不落盘、不缓存；只放行已知音乐 CDN 域名（清单在 `functions/download.ts` 的 `DOWNLOAD_HOST_SUFFIXES`），上游没返回音频内容时会报 502，绝不把网页存成假音频文件。
- 自定义音源脚本在隔离 Worker 里运行，隔离的是 DOM/凭证，不是代码本身——只添加信任来源的脚本（见 `README.md` 的安全边界说明）。
- 本地调试搜索代理可用 `npx wrangler pages dev .`（需安装 wrangler 并登录）。

## 常见问题

- **搜不到 / 播放失败**：先看是不是上游（GD）波动或音源脚本后端变了；站内“音源管理 → 全部检测”只代表“能返回地址”，不验是不是整首，播放时以实际出声和时长为准。
- **自定义域名一直 pending**：先查 DNS 里有没有指向 `<项目名>.pages.dev` 的 CNAME；没有就按上面手动加一条，再等证书签发。
- **改了代码线上没变**：直接上传方式必须重新上传；Git 方式检查 Deployments 里最新一次部署是不是成功，失败时点开看构建日志。
