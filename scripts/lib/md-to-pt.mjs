// Markdown (GFM) -> Portable Text. Total over the node types the content uses;
// anything else throws, so unsupported syntax fails the build instead of rendering wrong.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const DECORATORS = { strong: "strong", emphasis: "em", inlineCode: "code", delete: "strike-through" };

export function markdownToPortableText(markdown, keyPrefix) {
	let n = 0;
	const key = () => `${keyPrefix}${(n++).toString(36)}`;
	const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);

	// Phrasing content -> { children: span[], markDefs }. Images are lifted out.
	function inline(nodes) {
		const children = [];
		const markDefs = [];
		const images = [];
		const walk = (node, marks) => {
			switch (node.type) {
				case "text":
					children.push({ _type: "span", _key: key(), text: node.value, marks });
					return;
				case "break":
					children.push({ _type: "span", _key: key(), text: "\n", marks });
					return;
				case "strong":
				case "emphasis":
				case "delete":
					node.children.forEach((c) => walk(c, [...marks, DECORATORS[node.type]]));
					return;
				case "inlineCode":
					children.push({ _type: "span", _key: key(), text: node.value, marks: [...marks, "code"] });
					return;
				case "link": {
					const def = { _type: "link", _key: key(), href: node.url };
					markDefs.push(def);
					node.children.forEach((c) => walk(c, [...marks, def._key]));
					return;
				}
				case "image":
					images.push(image(node));
					return;
				default:
					throw new Error(`unsupported inline node: ${node.type}`);
			}
		};
		nodes.forEach((c) => walk(c, []));
		if (children.length === 0) children.push({ _type: "span", _key: key(), text: "", marks: [] });
		return { children, markDefs, images };
	}

	const image = (node) => ({ _type: "image", _key: key(), alt: node.alt ?? "", asset: { _ref: node.url, url: node.url } });

	const textBlock = (nodes, extra) => {
		const { children, markDefs, images } = inline(nodes);
		const hasText = children.some((c) => c.text.trim() !== "");
		return [...(hasText ? [{ _type: "block", _key: key(), style: "normal", markDefs, children, ...extra }] : []), ...images];
	};

	function list(node, level, out) {
		const listItem = node.ordered ? "number" : "bullet";
		for (const item of node.children) {
			let first = true;
			for (const child of item.children) {
				if (child.type === "paragraph") {
					const blocks = textBlock(child.children, first ? { listItem, level } : {});
					out.push(...blocks);
					first = false;
				} else if (child.type === "list") list(child, level + 1, out);
				else block(child, out);
			}
		}
	}

	function table(node) {
		const align = node.align ?? [];
		return {
			_type: "table",
			_key: key(),
			hasHeaderRow: true,
			rows: node.children.map((row, r) => ({
				_type: "tableRow",
				_key: key(),
				cells: row.children.map((cell, c) => {
					const { children, markDefs } = inline(cell.children);
					return {
						_type: "tableCell",
						_key: key(),
						isHeader: r === 0,
						content: children,
						...(markDefs.length ? { markDefs } : {}),
						...(align[c] ? { textAlign: align[c] } : {}),
					};
				}),
			})),
		};
	}

	function block(node, out) {
		switch (node.type) {
			case "heading": {
				const { children, markDefs } = inline(node.children);
				out.push({ _type: "block", _key: key(), style: `h${node.depth}`, markDefs, children });
				return;
			}
			case "paragraph":
				out.push(...textBlock(node.children));
				return;
			case "list":
				list(node, 1, out);
				return;
			case "blockquote":
				for (const child of node.children) {
					if (child.type !== "paragraph") throw new Error(`unsupported blockquote child: ${child.type}`);
					for (const b of textBlock(child.children)) out.push(b.style ? { ...b, style: "blockquote" } : b);
				}
				return;
			case "code":
				out.push({ _type: "code", _key: key(), ...(node.lang ? { language: node.lang } : {}), code: node.value });
				return;
			case "table":
				out.push(table(node));
				return;
			case "thematicBreak":
				out.push({ _type: "break", _key: key(), style: "lineBreak" });
				return;
			default:
				throw new Error(`unsupported block node: ${node.type}`);
		}
	}

	const out = [];
	tree.children.forEach((n) => block(n, out));
	return out;
}
