// seed/schema.json (structure) + content/articles/*.md (content) -> seed/seed.json (generated, gitignored).
import { readFileSync, writeFileSync } from "node:fs";
import { markdownToPortableText } from "./lib/md-to-pt.mjs";
import { readArticles } from "./lib/articles.mjs";

const schema = JSON.parse(readFileSync(new URL("../seed/schema.json", import.meta.url), "utf8"));
const articles = readArticles();

const tagSlugs = [...new Set(articles.flatMap((a) => a.meta.tags ?? []))].sort();
const taxonomies = schema.taxonomies.map((t) =>
	t.name === "tag" ? { ...t, terms: tagSlugs.map((slug) => ({ slug, label: slug })) } : t,
);

const content = {
	articles: articles.map((a, i) => ({
		id: `article-${a.slug}`,
		slug: a.slug,
		status: "published",
		data: {
			title: a.meta.title,
			excerpt: a.meta.description,
			...(a.meta.series ? { series: a.meta.series, series_order: a.meta.seriesOrder } : {}),
			content: markdownToPortableText(a.body, `a${i}k`),
		},
		bylines: [{ byline: "byline-yansir" }],
		taxonomies: { category: [a.meta.category], tag: a.meta.tags ?? [] },
	})),
};

writeFileSync(new URL("../seed/seed.json", import.meta.url), `${JSON.stringify({ ...schema, taxonomies, content }, null, "\t")}\n`);
console.log(`seed.json: ${articles.length} articles`);
