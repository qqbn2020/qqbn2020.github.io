# 美剧日历 · tv-date

美国电视剧播出与电影上映的静态日历站，托管在 GitHub Pages，由 GitHub Actions 定时抓取 TMDB 并重新生成整站。

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
5. 之后每天 08:30 / 14:30 / 20:30（北京时间）自动更新。

可选变量 `SITE_URL`（自定义域名时设置，用于 canonical / sitemap）；可选密钥 `LARK_WEBHOOK`（构建失败告警）。

## 抓取策略

- 剧集候选：`/tv/on_the_air`（未来 7 天）+ `/tv/airing_today` + `/tv/popular` + `/discover/tv`（按播出日期窗口，接口不支持时自动跳过）。
- 逐剧取 `/tv/{id}` 与相关季度的 `/tv/{id}/season/{n}`，只保留窗口内（默认 今天-3 ~ 今天+42）且有播出日的集。
- 电影：`/discover/movie`（region=US，release_type=2|3）+ `/movie/now_playing` + `/movie/upcoming`。
- 请求串行、约 4 req/s，命中 429 按 `Retry-After` 退避；响应缓存 6 小时，CI 用 `actions/cache` 复用。

## 许可与声明

数据与海报来自 TMDB。本产品使用 TMDB API，但未获 TMDB 认可，也不存在认证关系。
