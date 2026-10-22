// Listing metadata generated at build time by scripts/build-seed.mjs from content/**.
// Pages list/filter/paginate from this index (no article bodies, no DB); article detail pages read the CMS.
// Removal condition: articles authored only in the admin UI won't appear here — if that workflow is adopted,
// back this module with a cachedQuery over the CMS instead.
import index from "../generated/site-index.json";

export interface ArticleMeta {
	slug: string;
	title: string;
	description: string;
	date: string;
	category: string;
	tags: string[];
	chapter?: number;
}

export interface Collection {
	slug: string;
	title: string;
	description: string;
	sort: "date-desc" | "chapter";
	menu: boolean;
	featured: boolean;
	members: string[];
}

export const tags: Record<string, string> = index.tags;
export const articles = index.articles as ArticleMeta[];
export const collections = index.collections as Collection[];

const bySlug = new Map(articles.map((a) => [a.slug, a]));
export const getArticle = (slug: string) => bySlug.get(slug);
export const membersOf = (c: Collection) => c.members.map((s) => bySlug.get(s)!);
export const getCollection = (slug: string) => collections.find((c) => c.slug === slug);
export const articlesWithTag = (tag: string) => articles.filter((a) => a.tags.includes(tag));

/** The sequential (chapter-sorted) collection an article belongs to, with its neighbours. */
export function sequenceOf(slug: string) {
	for (const c of collections) {
		if (c.sort !== "chapter") continue;
		const i = c.members.indexOf(slug);
		if (i === -1) continue;
		return { collection: c, index: i + 1, total: c.members.length, prev: bySlug.get(c.members[i - 1] ?? ""), next: bySlug.get(c.members[i + 1] ?? "") };
	}
	return null;
}

export const PER_PAGE = 20;

/** Slice one page; `page` is the clamped page (redirect when it differs from the request). */
export function paginate<T>(items: T[], requested: number) {
	const totalPages = Math.max(1, Math.ceil(items.length / PER_PAGE));
	const page = Math.min(Math.max(Number.isFinite(requested) ? requested : 1, 1), totalPages);
	return { items: items.slice((page - 1) * PER_PAGE, page * PER_PAGE), page, totalPages };
}

/** Parse `?page=` and return either the page or the canonical URL to redirect to. */
export function pageFromUrl<T>(url: URL, items: T[]) {
	const raw = url.searchParams.get("page");
	const result = paginate(items, Number.parseInt(raw ?? "1", 10));
	const canonical = result.page === 1 ? url.pathname : `${url.pathname}?page=${result.page}`;
	return { ...result, redirect: raw !== null && String(result.page) !== raw ? canonical : null };
}
