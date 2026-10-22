import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const root = new URL("../../content/", import.meta.url);
const dir = new URL("articles/", root);

export const MAX_TAGS = 3;

const readYaml = (name) => parse(readFileSync(new URL(name, root), "utf8"));

/** content/tags.yaml -> { slug: label }. The only tag vocabulary. */
export const readTags = () => readYaml("tags.yaml");

/** content/articles/*.md -> [{ slug, meta, body }], newest first. The only reader of article sources. */
export function readArticles() {
	const vocabulary = readTags();
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const raw = readFileSync(new URL(f, dir), "utf8");
			const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			if (!m) throw new Error(`${f}: missing frontmatter`);
			const meta = parse(m[1]);
			for (const k of ["title", "description", "date", "category"]) {
				if (!meta[k]) throw new Error(`${f}: frontmatter.${k} required`);
			}
			if (meta.chapter !== undefined && !Number.isInteger(meta.chapter)) throw new Error(`${f}: chapter must be an integer`);
			const date = String(meta.date);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
				throw new Error(`${f}: frontmatter.date must be a valid YYYY-MM-DD, got ${JSON.stringify(date)}`);
			}
			const tags = meta.tags ?? [];
			if (tags.length > MAX_TAGS) throw new Error(`${f}: at most ${MAX_TAGS} tags, got ${tags.length}`);
			for (const t of tags) if (!(t in vocabulary)) throw new Error(`${f}: unknown tag "${t}" (add it to content/tags.yaml)`);
			if (new Set(tags).size !== tags.length) throw new Error(`${f}: duplicate tags`);
			return { slug: f.replace(/\.md$/, ""), meta: { ...meta, date, tags }, body: m[2].trim() };
		})
		.sort((a, b) => b.meta.date.localeCompare(a.meta.date) || a.slug.localeCompare(b.slug));
}

/** Does the collection rule select this article? The single definition of collection membership. */
export function matches(rule, article) {
	const has = (t) => article.meta.tags.includes(t);
	const { all = [], any = [], none = [] } = rule;
	return all.every(has) && (any.length === 0 || any.some(has)) && !none.some(has);
}

/** content/collections.yaml, validated against the tag vocabulary and the articles, members resolved. */
export function readCollections(articles) {
	const vocabulary = readTags();
	const seen = new Set();
	return readYaml("collections.yaml").map((c) => {
		if (seen.has(c.slug)) throw new Error(`collections.yaml: duplicate slug ${c.slug}`);
		seen.add(c.slug);
		for (const k of ["title", "description", "rule"]) if (!c[k]) throw new Error(`collections.yaml: ${c.slug}.${k} required`);
		const rule = c.rule;
		for (const t of [...(rule.all ?? []), ...(rule.any ?? []), ...(rule.none ?? [])]) {
			if (!(t in vocabulary)) throw new Error(`collections.yaml: ${c.slug} uses unknown tag "${t}"`);
		}
		const sort = c.sort ?? "date-desc";
		if (!["date-desc", "chapter"].includes(sort)) throw new Error(`collections.yaml: ${c.slug}.sort invalid`);
		let members = articles.filter((a) => matches(rule, a));
		if (members.length === 0) throw new Error(`collections.yaml: ${c.slug} is empty`);
		if (sort === "chapter") {
			if (members.some((a) => a.meta.chapter === undefined)) throw new Error(`collections.yaml: ${c.slug} sorts by chapter but a member lacks one`);
			members = [...members].sort((a, b) => a.meta.chapter - b.meta.chapter);
		}
		return { slug: c.slug, title: c.title, description: c.description, sort, menu: Boolean(c.menu), featured: Boolean(c.featured), members: members.map((a) => a.slug) };
	});
}
