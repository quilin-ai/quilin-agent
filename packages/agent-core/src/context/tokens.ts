/**
 * Phase 0 token estimator — heuristic, no tokenizer dependency.
 *
 * Strategy: walk the string by Unicode code point and assign a per-character
 * token weight by Unicode block. CJK ideographs, Hangul, and Japanese kana
 * are roughly 1 token per character for modern BPE tokenizers (cl100k_base /
 * o200k_base); Latin-style scripts compress to ~3-4 chars per token.
 *
 * This replaces the original `length / 4` heuristic that undercounted CJK
 * by ~4x (QUI-140 third-round audit, finding #2). Pure ASCII still maps to
 * `length / 4` so callers and existing fixtures keyed on Latin text are
 * preserved exactly.
 *
 * No npm dependency. Phase 1 may swap in tiktoken/o200k_base for accuracy.
 */

/** Per-character token weight by Unicode block. */
const WEIGHT_CJK = 1; // CJK ideograph ≈ 1 BPE token
const WEIGHT_KANA = 1; // Hiragana / Katakana ≈ 1 BPE token
const WEIGHT_HANGUL = 1; // Hangul syllable ≈ 1 BPE token
const WEIGHT_OTHER_NON_ASCII = 1 / 3; // Latin-extended, Cyrillic, Greek, etc.
const WEIGHT_ASCII = 1 / 4; // ASCII bytes — matches legacy length/4

function weightForCodePoint(codePoint: number): number {
	// ASCII fast path
	if (codePoint <= 0x7f) {
		return WEIGHT_ASCII;
	}

	// Hiragana (0x3040-0x309F) + Katakana (0x30A0-0x30FF)
	if (codePoint >= 0x3040 && codePoint <= 0x30ff) {
		return WEIGHT_KANA;
	}

	// CJK Unified Ideographs (0x4E00-0x9FFF)
	if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
		return WEIGHT_CJK;
	}

	// CJK Unified Ideographs Extension A (0x3400-0x4DBF)
	if (codePoint >= 0x3400 && codePoint <= 0x4dbf) {
		return WEIGHT_CJK;
	}

	// Hangul Syllables (0xAC00-0xD7AF) + Hangul Jamo (0x1100-0x11FF)
	if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
		return WEIGHT_HANGUL;
	}
	if (codePoint >= 0x1100 && codePoint <= 0x11ff) {
		return WEIGHT_HANGUL;
	}

	// CJK Compatibility Ideographs (0xF900-0xFAFF)
	if (codePoint >= 0xf900 && codePoint <= 0xfaff) {
		return WEIGHT_CJK;
	}

	// CJK Unified Ideographs Extension B and beyond (0x20000+) — supplementary plane
	if (codePoint >= 0x20000 && codePoint <= 0x2ffff) {
		return WEIGHT_CJK;
	}

	// Other non-ASCII (Latin extended, Cyrillic, Greek, emoji, symbols, etc.)
	return WEIGHT_OTHER_NON_ASCII;
}

export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}

	let total = 0;
	// `for...of` iterates by Unicode code point, handling surrogate pairs
	// (e.g. emoji in supplementary plane) without crashing.
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) {
			continue;
		}
		total += weightForCodePoint(cp);
	}

	return Math.ceil(total);
}
