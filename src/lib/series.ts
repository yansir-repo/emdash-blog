import { getEmDashCollection } from "emdash";

export async function getSeriesChapters(slug: string) {
	const { entries, cacheHint } = await getEmDashCollection("articles", {
		where: { series: slug },
		orderBy: { series_order: "asc" },
	});
	return { chapters: entries, cacheHint };
}
