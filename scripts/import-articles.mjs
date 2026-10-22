// Idempotent import of content/articles/*.md into a running EmDash instance over its REST API.
// Needed for remote sites: the setup wizard applies the seed's schema/menus but not its sample content.
// Usage: node scripts/import-articles.mjs <baseUrl>
//   auth: EMDASH_TOKEN, else the token saved by `npx emdash login --url <baseUrl>`.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { EmDashClient } from "emdash/client";
import { markdownToPortableText } from "./lib/md-to-pt.mjs";
import { readArticles } from "./lib/articles.mjs";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("usage: import-articles.mjs <baseUrl>");
const authFile = `${homedir()}/.config/emdash/auth.json`;
const key = baseUrl.replace(/\/$/, "");
const saved = (() => {
	try {
		return JSON.parse(readFileSync(authFile, "utf8"));
	} catch {
		return {};
	}
})();
const stored = saved[key];
const token = process.env.EMDASH_TOKEN ?? stored?.accessToken;
if (!token) throw new Error(`no token for ${baseUrl}: run \`npx emdash login --url ${baseUrl}\``);

const client = new EmDashClient({
	baseUrl,
	token,
	// the saved access token is short-lived: refresh with the stored refresh token and persist the result
	...(!process.env.EMDASH_TOKEN && stored?.refreshToken
		? {
				refreshToken: stored.refreshToken,
				onTokenRefresh: (accessToken, expiresIn) => {
					saved[key] = { ...stored, accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
					writeFileSync(authFile, JSON.stringify(saved, null, 2));
				},
			}
		: {}),
});
const schema = JSON.parse(readFileSync(new URL("../seed/schema.json", import.meta.url), "utf8"));
const articles = readArticles();

// schema drift: add fields the seed schema declares but the live collection lacks (never removes or alters)
const live = await client.collection("articles");
const have_fields = new Set(live.fields.map((f) => f.slug));
for (const f of schema.collections.find((c) => c.slug === "articles").fields) {
	if (!have_fields.has(f.slug)) await client.createField("articles", { slug: f.slug, type: f.type, label: f.label, ...(f.required ? { required: true } : {}) });
}

// byline
const byline = schema.bylines[0];
const unwrap = (r) => r?.data ?? r;
const existingBylines = unwrap(await client.request("GET", "/admin/bylines"))?.items ?? [];
const bylineId =
	existingBylines.find((b) => b.slug === byline.slug)?.id ??
	unwrap(await client.request("POST", "/admin/bylines", { slug: byline.slug, displayName: byline.displayName })).id;

// taxonomy terms: the schema's categories plus every tag used by an article (sample-data terms aren't seeded remotely)
const wanted = {
	category: schema.taxonomies.find((t) => t.name === "category").terms,
	tag: [...new Set(articles.flatMap((a) => a.meta.tags ?? []))].map((slug) => ({ slug, label: slug })),
};
for (const [taxonomy, terms] of Object.entries(wanted)) {
	const have = new Set((await client.terms(taxonomy, { limit: 200 })).items.map((t) => t.slug));
	for (const { slug, label } of terms) if (!have.has(slug)) await client.createTerm(taxonomy, { slug, label });
}

const publish = (id, date) =>
	client.request("POST", `/content/articles/${encodeURIComponent(id)}/publish`, { publishedAt: `${date}T00:00:00Z` });

// existing articles: only the publish date is synced from frontmatter (body edits made in the admin are never overwritten)
const existing = new Set();
const dates = new Map(articles.map((a) => [a.slug, a.meta.date]));
let redated = 0;
for await (const item of client.listAll("articles")) {
	existing.add(item.slug);
	const date = dates.get(item.slug);
	if (date && item.status === "published" && !item.publishedAt?.startsWith(date)) {
		await publish(item.id, date);
		redated++;
	}
}

let created = 0;
for (const [i, a] of articles.entries()) {
	if (existing.has(a.slug)) continue;
	const item = await client.create("articles", {
		slug: a.slug,
		status: "draft",
		data: {
			title: a.meta.title,
			excerpt: a.meta.description,
			...(a.meta.series ? { series: a.meta.series, series_order: a.meta.seriesOrder } : {}),
			content: markdownToPortableText(a.body, `a${i}k`),
		},
		bylines: [{ bylineId }],
		taxonomies: { category: [a.meta.category], tag: a.meta.tags ?? [] },
	});
	await publish(item.id, a.meta.date);
	created++;
}
console.log(`imported ${created}/${articles.length} articles (${articles.length - created} already present, ${redated} re-dated)`);
