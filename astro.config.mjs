import { readdirSync, readFileSync } from "node:fs";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

const articlesDir = new URL("./content/articles/", import.meta.url);

// Legacy URLs (`redirectFrom` in an article's frontmatter) -> /articles/<slug>, plus affiliate short links.
const legacyRedirects = Object.fromEntries(
	readdirSync(articlesDir)
		.filter((f) => f.endsWith(".md"))
		.flatMap((f) => {
			const from = readFileSync(new URL(f, articlesDir), "utf8").match(/^redirectFrom: (\S+)$/m)?.[1];
			return from ? [[from, { status: 301, destination: `/articles/${f.replace(/\.md$/, "")}` }]] : [];
		}),
);

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	site: "https://www.xunpanziyou.com",
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	redirects: {
		...legacyRedirects,
		"/specs101": {
			status: 302,
			destination:
				"https://www.hostg.xyz/aff_c?offer_id=517&aff_id=40495&url_id=3965&source=cloud_website",
		},
		"/vip": "/",
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto", coalesce: true }),
			storage: r2({ binding: "MEDIA" }),
		}),
	],
	vite: { plugins: [tailwindcss()] },
	devToolbar: { enabled: false },
});
