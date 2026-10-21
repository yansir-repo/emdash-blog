# 询盘自由网 · emdash-blog

[颜sir](https://www.xunpanziyou.com) 的博客，从 Next.js + MDX 迁移到 [EmDash](https://emdashcms.com)（Astro + Cloudflare Workers/D1/R2）。
外观沿用原站（Tailwind UI Spotlight 风格，Tailwind v4，`.dark` 类切换暗色），文章与联盟链接原样搬运。

## 内容模型

| 事实 | 唯一来源 |
| --- | --- |
| 站点结构（collections / taxonomies / bylines / 菜单 / 站点设置） | `seed/schema.json` |
| 文章（frontmatter + Markdown） | `content/articles/*.md` |
| 联盟链接 | `src/consts/affiliates.ts` |
| 旧路径 301（`redirectFrom`）、`/specs101`、`/vip` | `astro.config.mjs` ← 文章 frontmatter |

`seed/seed.json` 是 `scripts/build-seed.mjs` 生成物（已 gitignore，`dev`/`build` 前自动生成）：Markdown → Portable Text。
只支持标题、段落、列表、引用、代码块、图片、表格、链接/粗斜体/行内代码；遇到其他语法会直接报错而不是静默渲染错。

文章 frontmatter：`title`、`description`（作为摘要）、`date`（`YYYY-MM-DD`，真实发布日期）、`category`（`marketing` | `effect`）、`tags`、可选 `redirectFrom`。

## 本地开发

```bash
pnpm install
pnpm dev                     # http://localhost:4321
curl localhost:4321/_emdash/api/setup/dev-bypass   # 仅首次：完成本地 setup，应用 seed
node scripts/backdate.mjs    # 把 published_at 改回文章 frontmatter 的 date
```

重置本地数据：停掉 dev server，`rm -rf .wrangler`，再按上面三步来一遍。后台：`/_emdash/admin`。

`seed` 只在空库首启时应用；改了 `content/articles` 后需要重置本地库（或在后台编辑）。
`backdate.mjs` 的存在原因：seed 把 `published_at` 记为"现在"，EmDash 的迁移路径是带 `publishedAt` 重新发布。

## 部署到 Cloudflare

```bash
npx wrangler d1 create emdash-blog          # 把 database_id 填进 wrangler.jsonc
npx wrangler r2 bucket create emdash-blog-media
npx emdash secrets generate                 # 生成 EMDASH_ENCRYPTION_KEY
npx wrangler secret put EMDASH_ENCRYPTION_KEY
pnpm deploy
```

首次访问 `/_emdash/admin` 走 setup 向导创建 owner（passkey）。导入文章：向导/seed 之后用 owner 生成 API token，
`EMDASH_TOKEN=<token> node scripts/backdate.mjs https://你的域名`。详见 [EmDash 部署文档](https://docs.emdashcms.com/deployment/cloudflare/)。

## 与原站的差异

- 构建时没有 prism；代码块用 Astro 内置 Shiki（`github-dark-default`）。
- 原站 `uses` / `speaking` 页是模板遗留且不在导航里，未迁移。
- 订阅表单 `/thank-you` 与原站一样仍是静态占位，尚未接邮件服务。
- RSS 地址保持 `/feed.xml`，并带全文。

## 关于 `cf` CLI

`cf migrate`（beta）能把 Wrangler 配置转成 `cloudflare.config.ts`，但 `cf deploy` 要求项目构建出 Build Output Specification
（`.cloudflare/output/v0/config.json`），而 Astro 的 Cloudflare adapter 目前只产出 `dist/server/wrangler.json`，
所以本项目继续用 `wrangler deploy`。当 adapter 支持该输出规范时再迁移。
