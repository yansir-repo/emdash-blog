// Seeding stamps published_at = now; articles keep their authored date in frontmatter.
// This re-publishes each article with `publishedAt = frontmatter.date` (the documented migration path).
// Usage: node scripts/backdate.mjs [baseUrl]   (remote: set EMDASH_TOKEN; localhost: dev-bypass)
import { EmDashClient } from "emdash/client";
import { readArticles } from "./lib/articles.mjs";

const baseUrl = process.argv[2] ?? "http://localhost:4321";
const token = process.env.EMDASH_TOKEN;
const client = new EmDashClient({ baseUrl, ...(token ? { token } : { devBypass: true }) });

const dates = new Map(readArticles().map((a) => [a.slug, `${a.meta.date}T00:00:00Z`]));
let changed = 0;
for await (const item of client.listAll("articles", { status: "published" })) {
	const want = dates.get(item.slug);
	if (!want || item.publishedAt === want) continue;
	await client.request("POST", `/content/articles/${encodeURIComponent(item.id)}/publish`, { publishedAt: want });
	changed++;
}
console.log(`backdated ${changed}/${dates.size} articles`);
