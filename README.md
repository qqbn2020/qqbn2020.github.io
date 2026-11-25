# 美剧日历 · tv-date

线上地址：https://qqbn2020.github.io/tv-date/

剧集更新与电影上映的静态日历站，托管在 GitHub Pages，由 GitHub Actions 定时抓取 TMDB 并重新生成整站。

## 结构

```
scripts/tmdb.js      TMDB v4 客户端（串行限速、429 退避、响应缓存）
scripts/fetch.js     抓取 US 剧集剧集播出日期 + 美国院线电影 → data/raw.json
scripts/build.js     归一化 + 预渲染整站 → dist/
scripts/serve.js     本地预览（dist 静态服务）
assets/              styles.css / app.js / favicon.svg
.github/workflows/   deploy.yml 定时构建部署；keepalive.yml 防 60 天停用
site.config.json     站点名、窗口长度、归属声明
```

## 本地开发

```powershell
# 不需要网络、不需要 key 的版式预览
node scripts/fetch.js --demo
node scripts/build.js
node scripts/serve.js 8080   # http://localhost:8080

# 走真实数据（需要能访问 api.themoviedb.org 的网络）
# 在 .env 里填 TMDB_TOKEN=...
node scripts/fetch.js
node scripts/build.js
```

`.env` 已被 `.gitignore` 忽略，Token 不会进仓库。

## 首次发布清单

1. 新建仓库（如 `tv-date`），推送到 `main`。
2. 仓库 Settings → Secrets and variables → Actions，新增 `TMDB_TOKEN`（TMDB v4 Read Access Token）。
3. Settings → Pages → Source 选择 **GitHub Actions**。
4. Actions 页手动运行一次 `Build & Deploy`，确认抓取与部署成功。
5. 之后每天 6 次（北京时间 00:15 / 04:15 / 08:15 / 12:15 / 16:15 / 20:15）自动更新。

可选变量 `SITE_URL`（自定义域名时设置，用于 canonical / sitemap）；可选密钥 `LARK_WEBHOOK`（构建失败告警）。

## 抓取策略

- 剧集候选：`/tv/on_the_air`（未来 7 天）+ `/tv/airing_today` + `/tv/popular` + 按美国主要电视网（ABC/CBS/NBC/Fox/HBO/Netflix/Apple TV+/Hulu 等 30 个 network id）逐个 `discover/tv`，按播出日期窗口过滤。
- 只保留美国出品、英语原声的剧集；脱口秀、新闻、肥皂剧、竞猜节目（`genreBlock`）直接排除；窗口内集数超过 `maxEpisodesPerWindow`（默认 12）的每日栏目剧也排除。
- 逐剧取 `/tv/{id}` 与相关季度的 `/tv/{id}/season/{n}`，先用 `next_episode_to_air` / `last_episode_to_air` 预筛，只保留窗口内（默认 今天-3 ~ 今天+42）有播出日的集；同一天同一部剧的多集合并成一张卡片（`S01E01–E08`）。
- 电影：`/discover/movie`（region=US，release_type=2|3）+ `/movie/now_playing` + `/movie/upcoming`。
- 请求串行、约 4 req/s，命中 429 按 `Retry-After` 退避；响应缓存 2 小时，CI 用 `actions/cache` 复用，避免同一时段重复抓取。

## 中文优先

- 抓取时统一带 `language=zh-CN`，TMDB 有简体中文译名就显示中文标题、简介、集名与类型名；无译名时 TMDB 自动回落英文原名。
- 中文标题为主标题，英文原名在详情页与索引行里以次级样式保留（`titleAlt`），搜索框中英都能命中。
- URL slug 固定用英文原名生成，避免中文标题变化导致链接失效。
- 类型屏蔽（`genreBlock`）改按 TMDB genre id 判断：类型名会本地化，按名字比对会失效。

## 公众号推广

`site.config.json` 的 `promo` 段控制文案、二维码与开关：

```json
"promo": { "enabled": true, "label": "微信公众号", "slogan": "...", "hint": "...", "qr": "assets/wechat-qr.jpg" }
```

二维码图片放 `assets/`，构建时随资源一起拷进 `dist/`。所有页面统一在页脚右侧显示一张推广卡（二维码与文案垂直居中），页面正文里不再重复出现。

## 可调参数

- `site.config.json`：`window.back/forward`（窗口天数）、`genreBlock`（排除类型）、`maxEpisodesPerWindow`（栏目剧阈值）、`feeds.rssItemDays`。
- 环境变量：`MAX_SHOWS`（候选上限，默认 280）、`TMDB_GAP_MS`（请求间隔）、`TMDB_CACHE_TTL_HOURS`。
- 仓库变量 `SITE_URL`：换成自定义域名时设置，用于 canonical / sitemap / 订阅链接。

## 许可与声明

数据与海报来自 TMDB。本产品使用 TMDB API，但未获 TMDB 认可，也不存在认证关系。
