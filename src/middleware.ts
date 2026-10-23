import { defineMiddleware } from "astro:middleware";

// The apex hostname is served by the same Worker (wrangler.jsonc routes) but is not canonical:
// send it to `site` (astro.config.mjs), keeping path and query.
export const onRequest = defineMiddleware((context, next) => {
	const site = context.site;
	if (site && context.url.hostname === site.hostname.replace(/^www\./, "") && context.url.hostname !== site.hostname) {
		return context.redirect(new URL(`${context.url.pathname}${context.url.search}`, site).href, 301);
	}
	return next();
});
