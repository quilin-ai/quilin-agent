import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const DEFAULT_DB_PATH =
	process.env.QUILIN_MEM_DB_PATH ?? join(homedir(), ".quilin", "memory.db");

export interface LocalMemoryItem {
	readonly id: string;
	readonly content: string;
	readonly layer: "working" | "episodic" | "semantic" | "skill";
	readonly score: number;
	readonly timestamp: number;
	readonly metadata_json: string;
}

export interface LocalMemoryRecallOptions {
	readonly limit?: number;
	readonly threshold?: number;
	readonly layer?: string;
}

export interface LocalMemoryListOptions {
	readonly layer?: string;
	readonly limit?: number;
}

interface FtsRow extends LocalMemoryItem {
	readonly bm25_rank: number;
}

function hasNonAscii(text: string): boolean {
	return /[^\x00-\x7F]/.test(text);
}

function safeFtsQuery(query: string): string {
	return `"${query.replace(/"/g, '""')}"`;
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

export class LocalMemoryBackend {
	private db: InstanceType<typeof Database>;
	private closed = false;

	constructor(dbPath?: string) {
		const resolvedPath = dbPath ?? DEFAULT_DB_PATH;

		if (resolvedPath !== ":memory:") {
			ensureDir(dirname(resolvedPath));
		}

		this.db = new Database(resolvedPath);
		this.db.exec("PRAGMA journal_mode=WAL;");
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				layer TEXT NOT NULL CHECK(layer IN ('working','episodic','semantic','skill')),
				score REAL NOT NULL DEFAULT 0,
				timestamp INTEGER NOT NULL,
				metadata_json TEXT NOT NULL DEFAULT '{}'
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
				content,
				content='memories',
				content_rowid='rowid'
			);

			CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
				INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			END;

			CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
			END;

			CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
				INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
		`);
	}

	private ensureOpen(): void {
		if (this.closed) {
			throw new Error("LocalMemoryBackend is closed and cannot be used.");
		}
	}

	store(item: Omit<LocalMemoryItem, "id"> & { readonly id?: string }): string {
		this.ensureOpen();
		const id = item.id ?? crypto.randomUUID();

		this.db
			.prepare(
				`INSERT INTO memories (id, content, layer, score, timestamp, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				item.content,
				item.layer,
				item.score,
				item.timestamp,
				item.metadata_json,
			);

		return id;
	}

	recall(
		query: string,
		opts: LocalMemoryRecallOptions = {},
	): LocalMemoryItem[] {
		this.ensureOpen();
		const limit = opts.limit ?? 10;
		const threshold = opts.threshold;
		const layerFilter = opts.layer ?? null;

		let rows: FtsRow[];

		if (hasNonAscii(query)) {
			// LIKE-based fallback for non-ASCII (e.g. Chinese) queries.
			// FTS5 default tokenizer does not handle CJK characters.
			const likePattern = `%${query}%`;
			const stmt = this.db.prepare(
				`SELECT id, content, layer, score, timestamp,
				        metadata_json, -1.0 as bm25_rank
				 FROM memories
				 WHERE content LIKE ?
				   AND (? IS NULL OR layer = ?)
				 ORDER BY timestamp DESC
				 LIMIT ?`,
			);
			rows = stmt.all(
				likePattern,
				layerFilter,
				layerFilter,
				limit,
			) as unknown as FtsRow[];
		} else {
			const ftsQuery = safeFtsQuery(query);
			const stmt = this.db.prepare(
				`SELECT m.id, m.content, m.layer, m.score, m.timestamp,
				        m.metadata_json, fts.rank as bm25_rank
				 FROM memories m
				 JOIN memories_fts fts ON m.rowid = fts.rowid
				 WHERE memories_fts MATCH ?
				   AND (? IS NULL OR m.layer = ?)
				 ORDER BY fts.rank
				 LIMIT ?`,
			);
			rows = stmt.all(
				ftsQuery,
				layerFilter,
				layerFilter,
				limit,
			) as unknown as FtsRow[];
		}

		const items = rows.map(
			(row: FtsRow): LocalMemoryItem => ({
				id: row.id,
				content: row.content,
				layer: row.layer,
				score: row.score,
				timestamp: row.timestamp,
				metadata_json: row.metadata_json,
			}),
		);

		if (threshold == null) {
			return items;
		}

		return items.filter((_item: LocalMemoryItem, index: number) => {
			const row = rows[index];
			if (row == null) {
				return false;
			}
			const normalized = Math.max(0, Math.min(1, 1 + row.bm25_rank / 20));
			return normalized >= threshold;
		});
	}

	delete(id: string): void {
		this.ensureOpen();
		this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
	}

	list(opts: LocalMemoryListOptions = {}): LocalMemoryItem[] {
		this.ensureOpen();
		const limit = opts.limit ?? 100;
		const layer = opts.layer ?? null;

		const listStmt = this.db.prepare(
			`SELECT id, content, layer, score, timestamp, metadata_json
			 FROM memories
			 WHERE (? IS NULL OR layer = ?)
			 ORDER BY timestamp DESC
			 LIMIT ?`,
		);
		const rows = listStmt.all(
			layer,
			layer,
			limit,
		) as unknown as LocalMemoryItem[];

		return rows;
	}

	/**
	 * Returns a count of stored memories grouped by tier. Always returns
	 * all four tiers (working / episodic / semantic / skill) — tiers with
	 * zero entries report `0` rather than being omitted, so callers (e.g.
	 * the dashboard memory panel) can render a stable shape.
	 *
	 * 按 tier 返回存储记忆条数。固定返回 4 层（working / episodic /
	 * semantic / skill），空层返回 0 而不是省略，便于上层（例如
	 * dashboard 记忆面板）渲染稳定结构。
	 */
	countByTier(): Readonly<Record<LocalMemoryItem["layer"], number>> {
		this.ensureOpen();
		const rows = this.db
			.prepare("SELECT layer, COUNT(*) as count FROM memories GROUP BY layer")
			.all() as ReadonlyArray<{
			readonly layer: LocalMemoryItem["layer"];
			readonly count: number;
		}>;

		const counts: Record<LocalMemoryItem["layer"], number> = {
			working: 0,
			episodic: 0,
			semantic: 0,
			skill: 0,
		};

		for (const row of rows) {
			counts[row.layer] = row.count;
		}

		return counts;
	}

	close(): void {
		this.db.close();
		this.closed = true;
	}
}
