import { toHTML, uriLooksSafe, escapeHTML } from "@portabletext/to-html";
import type { PortableTextBlock } from "emdash";

type Cell = { content: { text: string }[]; isHeader?: boolean };
type Table = { rows: { cells: Cell[] }[] };

/** Feed-grade HTML for an article body (standard blocks, images, code, tables). */
export function portableTextToHtml(blocks: PortableTextBlock[]): string {
	return toHTML(blocks as never, {
		components: {
			types: {
				image: ({ value }) => (value.asset?.url ? `<img src="${escapeHTML(value.asset.url)}" alt="${escapeHTML(value.alt ?? "")}" />` : ""),
				code: ({ value }) => `<pre><code>${escapeHTML(value.code)}</code></pre>`,
				break: () => "<hr/>",
				table: ({ value }: { value: Table }) =>
					`<table>${value.rows
						.map(
							(r) =>
								`<tr>${r.cells
									.map((c) => `<${c.isHeader ? "th" : "td"}>${escapeHTML(c.content.map((s) => s.text).join(""))}</${c.isHeader ? "th" : "td"}>`)
									.join("")}</tr>`,
						)
						.join("")}</table>`,
			},
			marks: {
				link: ({ children, value }) => (uriLooksSafe(value?.href ?? "") ? `<a href="${escapeHTML(value.href)}">${children}</a>` : children),
			},
		},
	});
}
