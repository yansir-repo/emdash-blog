import type { PortableTextBlock } from "emdash";

export interface Heading {
	depth: number;
	text: string;
	id: string;
}

type Block = PortableTextBlock & { style?: string; children?: { text?: string }[]; _headingId?: string };

const HEADING_STYLE = /^h([2-6])$/;

const slugify = (text: string) =>
	text
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-");

/** Stamps every h2–h6 block with a unique `_headingId` (read by Heading.astro) and returns the outline. */
export function annotateHeadings(blocks: PortableTextBlock[]): { blocks: PortableTextBlock[]; headings: Heading[] } {
	const seen = new Map<string, number>();
	const headings: Heading[] = [];
	const out = (blocks as Block[]).map((block) => {
		const depth = Number(block.style?.match(HEADING_STYLE)?.[1]);
		if (!depth) return block;
		const text = (block.children ?? []).map((c) => c.text ?? "").join("");
		const base = slugify(text) || "section";
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		const id = n === 0 ? base : `${base}-${n}`;
		headings.push({ depth, text, id });
		return { ...block, _headingId: id };
	});
	return { blocks: out, headings };
}

/** Index of the first h2 — where the table of contents is inserted. */
export function firstH2Index(blocks: PortableTextBlock[]) {
	return (blocks as Block[]).findIndex((b) => b.style === "h2");
}
