/** 标准化 prompt section，确保相同语义产生相同 token 序列 */
export function normalizeSection(content: string): string {
	return content
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/** 对结构化标识符列表去重并排序（仅限 capability IDs、tool names 等） */
export function normalizeSortedList(items: readonly string[]): string[] {
	return [...new Set(items)].sort();
}

/** 比较两个 section 是否语义等价 */
export function sectionSemanticEqual(a: string, b: string): boolean {
	return normalizeSection(a) === normalizeSection(b);
}
