export const series = {
	"effect-tutorial": {
		title: "Effect 教程：由浅入深",
		description: "从 async/await 的三个盲区出发，逐步讲清 Effect 的类型、错误、依赖、并发、资源与工程化。每章只引入一类新概念。",
	},
} as const;

export type SeriesSlug = keyof typeof series;

export const isSeries = (s: unknown): s is SeriesSlug => typeof s === "string" && s in series;
