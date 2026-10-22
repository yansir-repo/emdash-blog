import { getEmDashCollection } from "emdash";

type Entries = Awaited<ReturnType<typeof getEmDashCollection<"articles">>>;

export interface Page {
	entries: Entries["entries"];
	page: number;
	totalPages: number;
	cacheHints: Entries["cacheHint"][];
}

/**
 * Numbered pages over EmDash's cursor-only listing: walk the cursor chain once, keep the
 * requested window. Cost is O(totalPages) tiny queries; revisit if a collection outgrows ~100 pages.
 */
export async function paginateArticles(requested: number, perPage: number): Promise<Page> {
	const cacheHints: Page["cacheHints"] = [];
	let window: Entries["entries"] = [];
	let cursor: string | undefined;
	let totalPages = 0;

	do {
		const { entries, nextCursor, cacheHint } = await getEmDashCollection("articles", {
			orderBy: { published_at: "desc" },
			limit: perPage,
			cursor,
		});
		cacheHints.push(cacheHint);
		if (entries.length > 0) totalPages++;
		if (totalPages === requested) window = entries;
		cursor = nextCursor;
	} while (cursor);

	const page = Math.min(Math.max(requested, 1), Math.max(totalPages, 1));
	return page === requested ? { entries: window, page, totalPages, cacheHints } : paginateArticles(page, perPage);
}
