export function estimateTokens(text: string): number {
	// Phase 0 heuristic: undercounts CJK by ~4x. Replace with tiktoken in Phase 1.
	return Math.ceil(text.length / 4);
}
