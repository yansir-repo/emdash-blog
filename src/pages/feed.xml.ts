import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";
import { portableTextToHtml } from "../lib/pt-to-html";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cdata = (s: string) => `<![CDATA[${s.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

export const GET: APIRoute = async ({ url }) => {
	const origin = url.origin;
	const settings = await getSiteSettings();
	const { entries } = await getEmDashCollection("articles", { orderBy: { published_at: "desc" }, limit: 50 });

	const items = entries
		.filter((a) => a.data.publishedAt)
		.map((a) => {
			const link = `${origin}/articles/${a.id}`;
			return `<item><title>${esc(a.data.title)}</title><link>${link}</link><guid isPermaLink="true">${link}</guid><pubDate>${a.data.publishedAt!.toUTCString()}</pubDate><author>markyan@foxmail.com (颜sir)</author><description>${esc(a.data.excerpt ?? "")}</description><content:encoded>${cdata(portableTextToHtml(a.data.content ?? []))}</content:encoded></item>`;
		})
		.join("\n");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${esc(settings.title ?? "")}</title><link>${origin}</link><description>${esc(settings.tagline ?? "")}</description><language>zh-CN</language><atom:link href="${origin}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
</channel></rss>`;
	return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
};
