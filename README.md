# 美剧日历 · tv-date

线上地址：https://qqbn2020.github.io

剧集更新与电影上映的静态日历站，托管在 GitHub Pages，由 GitHub Actions 定时抓取 TMDB 并重新生成整站。

## 结构

```
scripts/tmdb.js      TMDB v4 客户端（串行限速、429 退避、响应缓存）
scripts/tvmaze.js    TVMaze 客户端（排期补充源，限 20 请求/10 秒）
scripts/fetch.js     抓取 US 剧集剧集播出日期 + 美国院线电影 → data/raw.json
scripts/build.js     归一化 + 预渲染整站 → dist/
scripts/indexnow.js  部署后向 IndexNow（Bing 等）提交 sitemap URL
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

- 剧集候选：`/tv/on_the_air`（未来 7 天）+ `/tv/airing_today` + `/tv/popular` + 不限电视网的 `discover/tv`（按播出日期窗口、美区美语，10 页）+ 按美国主要电视网（ABC/CBS/NBC/Fox/HBO/Netflix/Apple TV+/Hulu/Paramount+ with Showtime 等 31 个 network id）逐个 `discover/tv` 补充长尾。网络清单仅为补充——窗口内美剧由全局 discover 兜底，不依赖清单完整性。
- **TVMaze 补充源**（`site.config.json` → `tvmaze.enabled`，`TVMAZE_OFF=1` 可关）：对窗口内每天发一次 `/schedule?country=US`，覆盖全部美国线性频道，无电视网枚举问题。TVMaze **只提供排期证据，不产生独立条目**：通过 IMDb id 反查回 TMDB（`/find?external_source=imdb_id` + 详情页 `append_to_response=external_ids`），同一部剧最多只有一个 TMDB id 条目——已收录的剧做日期交叉校验（TMDB 日期为准，冲突记录进诊断）；TMDB 漏收的剧经完整管线（类型/国家/语言过滤照常）补录。TVMaze 排期中的重播因与 TMDB 首播日期对不上而被自然过滤，"已 Ended"重播剧会因窗口内无首播集自动落选。
- 只保留美国出品、英语原声的剧集；脱口秀、新闻、肥皂剧、竞猜节目（`genreBlock`）直接排除；窗口内占用超过 `maxDaysPerWindow`（默认 18）个不同日期的每日栏目剧也排除（按占用日期数而非集数判断，全季 binge 上线不受影响）。
- 逐剧取 `/tv/{id}` 与相关季度的 `/tv/{id}/season/{n}`。对非 discover 命中的剧，先用 `next_episode_to_air` / `last_episode_to_air` 预筛，避免为停播剧浪费请求；由窗口 discover 直接命中的剧**跳过预筛**——TMDB 的集指针常有滞后，不能以此否决已确认在窗口内播出的剧。季选择保留最近 3 季 + 集指针引用的季，并容忍新季缺失 `season.air_date`。窗口内（默认 今天-3 ~ 今天+42）的集保留，同一天同一部剧的多集合并成一张卡片（`S01E01–E08`）。
- 电影：`/discover/movie`（region=US，release_type=2|3）+ `/movie/now_playing` + `/movie/upcoming`。
- 请求串行、约 4 req/s（TVMaze 客户端约 2 req/s，各自独立限速），命中 429 按 `Retry-After` 退避；响应缓存默认 6 小时（CI 环境变量设为 2 小时），`actions/cache` 复用 `.cache/tmdb` 与 `.cache/tvmaze`，避免同一时段重复抓取。

## 运行诊断

每次真实抓取都会生成 `data/dropped.json`（部署后可通过 `https://<域名>/data/dropped.json` 访问），记录每部剧被过滤的确切位置，用于排查"某剧为什么没收录"：

- `candidates`：进入候选池的全部剧，含 `wh`（是否由播出窗口 discover 命中）与 `src`（候选来源列表，如 `discover:6631`、`discover:global`、`on_the_air`）。**剧不在这里 = 连候选都没进**，说明候选来源没覆盖到它。
- `tvmaze`：TVMaze 补充源的运行报告——`matched`（与已收录剧对齐数）、`validated`（日期交叉验证一致数）、`conflicts`（两源日期不一致，TMDB 为准）、`added`（从 TVMaze 补进的集）、`respectedDrops`（有排期证据但被 TMDB 管线政策性排除的剧）、`stripRolledBack`（合并后触发栏目剧守卫回滚的剧）、`unmatched`（有排期但未进入 TMDB 管线的剧）、`find`（IMDb 反查计数：`found` / `notFound`）。
- `dropped`：被过滤的剧，`stage` 取值：`candidate-cap`（热度/优先级截断）、`origin-country` / `language`（非美区非英语）、`genre-block`（类型排除）、`prefilter`（集指针预筛）、`no-episodes`（季数据为空）、`strip-days`（每日栏目剧）、`error`（请求失败）。

排查口诀：先查 `candidates` 里有没有这部剧 → 有则看它被丢在哪个 `stage` → 没有则说明候选来源缺失（新增电视网 id 或调大 `GLOBAL_WINDOW_PAGES`）。抓取日志还会输出 `candidates by source` 各来源命中计数，可直接观察某条来源通道是否失效。

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

- `site.config.json`：`window.back/forward`（窗口天数）、`genreBlock`（排除类型）、`maxDaysPerWindow`（栏目剧阈值，按窗口内占用的不同日期数判断，全季 binge 上线不受影响）、`feeds.rssItemDays`。
- 环境变量：`MAX_SHOWS`（候选上限，默认 280）、`GLOBAL_WINDOW_PAGES`（全局窗口 discover 页数，默认 10）、`STRIP_MAX_DAYS`（覆盖栏目剧阈值）、`TVMAZE_OFF=1`（关闭 TVMaze 补充）、`TVMAZE_GAP_MS`（TVMaze 请求间隔，默认 550）、`TMDB_GAP_MS`（请求间隔）、`TMDB_CACHE_TTL_HOURS` / `TVMAZE_CACHE_TTL_HOURS`（缓存时长，默认 6）。
- IndexNow 收录推送：key 存在 `site.config.json` 的 `indexNow.key`，构建时在站点根目录生成 `<key>.txt` 验证文件，每日部署完成后 `scripts/indexnow.js` 自动提交 sitemap 全部 URL。
- 仓库变量 `SITE_URL`：换成自定义域名时设置，用于 canonical / sitemap / 订阅链接。

## 许可与声明

数据与海报来自 TMDB。本产品使用 TMDB API，但未获 TMDB 认可，也不存在认证关系。
