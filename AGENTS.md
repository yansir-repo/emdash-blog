# AGENTS.md

EmDash（Astro）博客。内容模型、命令与部署见 [README.md](./README.md)。

- 站点结构改 `seed/schema.json`；文章改 `content/articles/*.md`；`seed/seed.json` 是生成物，勿手改。
- 页面全部服务端渲染（`output: "server"`）；文章集合 slug 是 `articles`，URL `/articles/{slug}`（与旧站一致）。
- 样式：Tailwind v4 + `src/styles/global.css`，暗色靠 `<html class="dark">`（`Base.astro` 内联脚本 + localStorage `theme`）。
- Portable Text 渲染覆盖：`image`→`ArticleImage`，`code`→`ArticleCode`，h2–h6→`Heading`（带 `_headingId`，见 `src/lib/headings.ts`）。
- EmDash API 以 `.agents/skills/` 和 https://docs.emdashcms.com/mcp 为准，不要凭记忆。
- 并行跑 `astro build` 与 `astro dev` 会破坏 vite 依赖缓存，改完先停 dev 再 build。
