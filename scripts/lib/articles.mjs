import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const dir = new URL("../../content/articles/", import.meta.url);

/** content/articles/*.md -> [{ slug, meta, body }], newest first. The only reader of article sources. */
export function readArticles() {
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
			if (Boolean(meta.series) !== Number.isInteger(meta.seriesOrder)) {
				throw new Error(`${f}: series and seriesOrder (integer) must be set together`);
			}
			const date = String(meta.date);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
				throw new Error(`${f}: frontmatter.date must be a valid YYYY-MM-DD, got ${JSON.stringify(date)}`);
			}
			return { slug: f.replace(/\.md$/, ""), meta: { ...meta, date }, body: m[2].trim() };
		})
		.sort((a, b) => b.meta.date.localeCompare(a.meta.date));
}
