// Idempotent import of content/articles/*.md into a running EmDash instance over its REST API.
// Needed for remote sites: the setup wizard applies the seed's schema/menus but not its sample content.
// Usage: node scripts/import-articles.mjs <baseUrl>
//   auth: EMDASH_TOKEN, else the token saved by `npx emdash login --url <baseUrl>`.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { EmDashClient } from "emdash/client";
import { markdownToPortableText } from "./lib/md-to-pt.mjs";
import { readArticles, readTags } from "./lib/articles.mjs";

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
const unwrap = (r) => r?.data ?? r;
const live = await client.collection("articles");
const have_fields = new Set(live.fields.map((f) => f.slug));
for (const f of schema.collections.find((c) => c.slug === "articles").fields) {
	if (!have_fields.has(f.slug)) await client.createField("articles", { slug: f.slug, type: f.type, label: f.label, ...(f.required ? { required: true } : {}) });
}

// menus: add schema items the live menu lacks (matched by label), then apply the schema order. Never deletes.
for (const menu of schema.menus) {
	const live = unwrap(await client.request("GET", `/menus/${menu.name}`));
	const byLabel = new Map(live.items.map((i) => [i.label, i]));
	for (const item of menu.items) {
		if (byLabel.has(item.label)) continue;
		const created = unwrap(
			await client.request("POST", `/menus/${menu.name}/items`, {
				type: item.type,
				label: item.label,
				customUrl: item.url,
				...(item.target ? { target: item.target } : {}),
			}),
		);
		byLabel.set(item.label, created);
	}
	const wanted = menu.items.map((i, sortOrder) => ({ id: byLabel.get(i.label).id, parentId: null, sortOrder }));
	const extra = [...byLabel.values()].filter((i) => !menu.items.some((m) => m.label === i.label));
	await client.request("POST", `/menus/${menu.name}/reorder`, {
		items: [...wanted, ...extra.map((i, k) => ({ id: i.id, parentId: i.parentId ?? null, sortOrder: wanted.length + k }))],
	});
}

// byline
const byline = schema.bylines[0];
const existingBylines = unwrap(await client.request("GET", "/admin/bylines"))?.items ?? [];
const bylineId =
	existingBylines.find((b) => b.slug === byline.slug)?.id ??
	unwrap(await client.request("POST", "/admin/bylines", { slug: byline.slug, displayName: byline.displayName })).id;

// taxonomy terms: the schema's categories plus the tag vocabulary (content/tags.yaml); ids needed to assign terms
const wanted = {
	category: schema.taxonomies.find((t) => t.name === "category").terms,
	tag: Object.entries(readTags()).map(([slug, label]) => ({ slug, label })),
};
const termIds = {};
for (const [taxonomy, terms] of Object.entries(wanted)) {
	const live = (await client.terms(taxonomy, { limit: 200 })).items;
	const have = new Map(live.map((t) => [t.slug, t.id]));
	for (const { slug, label } of terms) {
		if (!have.has(slug)) have.set(slug, (await client.createTerm(taxonomy, { slug, label })).id);
	}
	termIds[taxonomy] = have;
}
const desiredTerms = (a) => ({ category: [a.meta.category], tag: a.meta.tags });
const setTerms = async (id, a) => {
	let changed = false;
	for (const [taxonomy, slugs] of Object.entries(desiredTerms(a))) {
		const cur = unwrap(await client.request("GET", `/content/articles/${encodeURIComponent(id)}/terms/${taxonomy}`));
		const curSlugs = (cur?.terms ?? cur?.items ?? cur ?? []).map((t) => t.slug).sort().join(",");
		if (curSlugs === [...slugs].sort().join(",")) continue;
		await client.request("POST", `/content/articles/${encodeURIComponent(id)}/terms/${taxonomy}`, {
			termIds: slugs.map((slug) => termIds[taxonomy].get(slug)),
		});
		changed = true;
	}
	return changed;
};

// existing articles: only frontmatter-owned metadata (publish date, category, tags) is synced; bodies edited in the admin are never overwritten
const existing = new Set();
const dates = new Map(articles.map((a) => [a.slug, a.meta.date]));
const bySlug = new Map(articles.map((a) => [a.slug, a]));
let redated = 0;
let retagged = 0;
for await (const item of client.listAll("articles")) {
	existing.add(item.slug);
	const date = dates.get(item.slug);
	if (date && item.status === "published" && !item.publishedAt?.startsWith(date)) {
		await publish(item.id, date);
		redated++;
	}
	const a = bySlug.get(item.slug);
	if (a && (await setTerms(item.id, a))) retagged++;
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
			content: markdownToPortableText(a.body, `a${i}k`),
		},
		bylines: [{ bylineId }],
		taxonomies: desiredTerms(a),
	});
	await publish(item.id, a.meta.date);
	created++;
}
console.log(`imported ${created}/${articles.length} articles (${articles.length - created} already present, ${redated} re-dated, ${retagged} re-tagged)`);
