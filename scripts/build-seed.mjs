// Build step. Sources: seed/schema.json (structure), content/{articles/*.md,tags.yaml,collections.yaml}.
// Outputs (both generated, gitignored):
//   seed/seed.json              — EmDash seed (schema + content as Portable Text)
//   src/generated/site-index.json — listing metadata for pages (no article bodies): articles, tags, collections
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { markdownToPortableText } from "./lib/md-to-pt.mjs";
import { readArticles, readCollections, readTags } from "./lib/articles.mjs";

const path = (p) => new URL(p, import.meta.url);
const schema = JSON.parse(readFileSync(path("../seed/schema.json"), "utf8"));
const articles = readArticles();
const vocabulary = readTags();
const collections = readCollections(articles);

const taxonomies = schema.taxonomies.map((t) =>
	t.name === "tag" ? { ...t, terms: Object.entries(vocabulary).map(([slug, label]) => ({ slug, label })) } : t,
);

const content = {
	articles: articles.map((a, i) => ({
		id: `article-${a.slug}`,
		slug: a.slug,
		status: "published",
		data: {
			title: a.meta.title,
			excerpt: a.meta.description,
			content: markdownToPortableText(a.body, `a${i}k`),
		},
		bylines: [{ byline: "byline-yansir" }],
		taxonomies: { category: [a.meta.category], tag: a.meta.tags },
	})),
};
writeFileSync(path("../seed/seed.json"), `${JSON.stringify({ ...schema, taxonomies, content }, null, "\t")}\n`);

mkdirSync(path("../src/generated/"), { recursive: true });
const index = {
	tags: vocabulary,
	articles: articles.map((a) => ({
		slug: a.slug,
		title: a.meta.title,
		description: a.meta.description,
		date: a.meta.date,
		category: a.meta.category,
		tags: a.meta.tags,
		...(a.meta.chapter !== undefined ? { chapter: a.meta.chapter } : {}),
	})),
	collections,
};
writeFileSync(path("../src/generated/site-index.json"), `${JSON.stringify(index)}\n`);
console.log(`built: ${articles.length} articles, ${collections.length} collections, ${Object.keys(vocabulary).length} tags`);
