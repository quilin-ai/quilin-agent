/**
 * memory-dedupe.ts
 *
 * Pure helpers for the /memory 一键去重 (one-click dedupe) flow.
 *
 * MVP scope: exact content-string match within the same tier. The
 * earliest record (by `createdAt`, falling back to original array
 * order when timestamps are missing or equal) is kept, the rest are
 * marked for deletion.
 *
 * 复杂的语义相似去重（向量距离 / 模糊匹配）留到后续 iter，先把
 * "用户叫小明 × 30 次" 这类精确重复清掉，覆盖 95% 的痛点。
 *
 * The route handler is a thin shell that resolves catalog tools and
 * applies these helpers; keeping the diff logic pure makes it
 * straightforward to unit-test without mocking the MCP layer.
 */

export interface DedupeCandidate {
	readonly id: string;
	readonly content: string;
	readonly tier: string;
	readonly createdAt: string | null;
}

export interface DedupeGroup {
	readonly tier: string;
	readonly content: string;
	/** Id we keep — earliest by createdAt, then earliest array index. */
	readonly keepId: string;
	/** Ids to delete (length >= 1). */
	readonly deleteIds: readonly string[];
}

export interface DedupePlan {
	readonly groups: readonly DedupeGroup[];
	readonly totalDelete: number;
	readonly totalKeep: number;
}

/**
 * Normalize a content string for exact-match comparison.
 *
 * Trims surrounding whitespace and collapses internal runs so that
 * "用户叫小明" and "用户叫小明 " (trailing space from a partial paste)
 * land in the same bucket. Case is preserved — Chinese text doesn't
 * care, and English casing is meaningful enough that we don't want to
 * fold "Hello" into "hello" by accident.
 */
export function normalizeContent(s: string): string {
	return s.trim().replace(/\s+/g, " ");
}

/**
 * Pick which record to keep within an exact-duplicate group.
 *
 * Priority:
 *   1. Earliest valid `createdAt` (ISO parseable).
 *   2. Falls back to earliest occurrence in the input array.
 *
 * Records with unparseable / null timestamps are treated as having
 * timestamp = +Infinity, so they lose to any record with a real
 * timestamp; among themselves, array order decides.
 */
function pickKeeper(records: readonly { record: DedupeCandidate; index: number }[]): {
	keep: { record: DedupeCandidate; index: number };
	rest: { record: DedupeCandidate; index: number }[];
} {
	const scored = records.map((r) => {
		const ts = r.record.createdAt;
		let score = Number.POSITIVE_INFINITY;
		if (ts != null) {
			const ms = Date.parse(ts);
			if (Number.isFinite(ms)) score = ms;
		}
		return { ...r, score };
	});
	// Stable sort: earliest score first, then earliest index.
	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return a.index - b.index;
	});
	const [keep, ...rest] = scored;
	if (keep == null) {
		throw new Error("pickKeeper called with empty group");
	}
	return { keep, rest };
}

/**
 * Compute the dedupe plan for a list of memory records.
 *
 * Records are grouped by `(tier, normalizeContent(content))`. Groups
 * with only one entry are skipped — nothing to dedupe. Empty content
 * is skipped (defensive — would never be a meaningful duplicate).
 *
 * The returned plan is purely descriptive; callers decide whether
 * to actually execute the deletes.
 */
export function buildDedupePlan(records: readonly DedupeCandidate[]): DedupePlan {
	const buckets = new Map<string, { record: DedupeCandidate; index: number }[]>();
	records.forEach((record, index) => {
		const normalized = normalizeContent(record.content);
		if (normalized.length === 0) return;
		const key = `${record.tier}::${normalized}`;
		const bucket = buckets.get(key);
		if (bucket == null) {
			buckets.set(key, [{ record, index }]);
		} else {
			bucket.push({ record, index });
		}
	});

	const groups: DedupeGroup[] = [];
	let totalDelete = 0;
	let totalKeep = 0;
	for (const bucket of buckets.values()) {
		if (bucket.length < 2) continue;
		const { keep, rest } = pickKeeper(bucket);
		const deleteIds = rest.map((r) => r.record.id);
		totalDelete += deleteIds.length;
		totalKeep += 1;
		groups.push({
			tier: keep.record.tier,
			content: normalizeContent(keep.record.content),
			keepId: keep.record.id,
			deleteIds,
		});
	}

	// Stable group order: largest dedupe first so the preview surfaces
	// the noisiest duplicates at the top.
	groups.sort((a, b) => b.deleteIds.length - a.deleteIds.length);

	return { groups, totalDelete, totalKeep };
}
