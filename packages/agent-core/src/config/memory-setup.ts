import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger.js";
import { LocalMemoryBackend } from "../memory/local-backend.js";

const DEFAULT_MEMORY_DIR = join(homedir(), ".quilin");
const DEFAULT_MEMORY_PATH = join(DEFAULT_MEMORY_DIR, "memory.db");

export interface MemoryBackendStatus {
	readonly created: boolean;
	readonly path: string;
}

/**
 * Ensures the local memory backend (~/.quilin/memory.db) exists and has the
 * schema initialized.  Creates both the directory and the database file (with
 * tables, FTS5 index, and triggers) when the file is missing; otherwise the
 * call is a no-op.
 *
 * The underlying {@link LocalMemoryBackend} constructor opens the database in
 * WAL mode and runs CREATE TABLE IF NOT EXISTS / CREATE VIRTUAL TABLE IF NOT
 * EXISTS, so this function is safe to call repeatedly.
 */
export function ensureMemoryBackend(): MemoryBackendStatus {
	const dbPath = DEFAULT_MEMORY_PATH;
	const alreadyExists = existsSync(dbPath);

	if (alreadyExists) {
		if (process.env.NODE_ENV !== "test") {
			logger.info({ db_path: dbPath }, "Memory backend already present");
		}
		return { created: false, path: dbPath };
	}

	const backend = new LocalMemoryBackend(dbPath);
	backend.close();

	if (process.env.NODE_ENV !== "test") {
		logger.info({ db_path: dbPath }, "Memory backend created and initialized");
	}
	return { created: true, path: dbPath };
}
