export function formatDate(date: Date | string) {
	return new Date(date).toLocaleDateString("zh-CN", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}
