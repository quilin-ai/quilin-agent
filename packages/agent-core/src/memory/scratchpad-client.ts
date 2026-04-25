import { getUserConfig, UserRuntimeNotBootedError } from "../config/runtime.js";
import type { MCPClientManager } from "../tools/mcp-client.js";

export const DEFAULT_SCRATCHPAD_TTL_SEC = 3600;
export const DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK = 1024;

export interface ScratchpadDefaults {
	readonly ttlSec: number;
	readonly capacityPerTask: number;
}

export interface ScratchpadWriteInput {
	readonly taskId: string;
	readonly sessionId: string;
	readonly key: string;
	readonly value: string;
	readonly ttlSec?: number;
	readonly capacityPerTask?: number;
}

export interface ScratchpadReadInput {
	readonly taskId: string;
	readonly sessionId: string;
	readonly key: string;
}

export interface ScratchpadClearInput {
	readonly taskId: string;
	readonly sessionId: string;
	readonly key?: string;
}

export interface ScratchpadClient {
	write(input: ScratchpadWriteInput): Promise<void>;
	read(input: ScratchpadReadInput): Promise<string | null>;
	clear(input: ScratchpadClearInput): Promise<number>;
}

export type ScratchpadMCPTransport = Pick<MCPClientManager, "callTool">;

export class ScratchpadClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScratchpadClientError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, field: string): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${field} must be a positive integer`);
	}
	return value;
}

export function getScratchpadDefaults(): ScratchpadDefaults {
	try {
		const config = getUserConfig().memory.scratchpad;
		return {
			ttlSec: positiveInteger(config.ttl_sec, "memory.scratchpad.ttl_sec"),
			capacityPerTask: positiveInteger(
				config.capacity_per_task,
				"memory.scratchpad.capacity_per_task",
			),
		};
	} catch (error) {
		if (error instanceof UserRuntimeNotBootedError) {
			return {
				ttlSec: DEFAULT_SCRATCHPAD_TTL_SEC,
				capacityPerTask: DEFAULT_SCRATCHPAD_CAPACITY_PER_TASK,
			};
		}
		throw error;
	}
}

function parseToolResponse(
	toolName: string,
	content: string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new ScratchpadClientError(
			`${toolName} returned non-JSON response: ${(error as Error).message}`,
		);
	}

	if (!isRecord(parsed)) {
		throw new ScratchpadClientError(`${toolName} returned non-object response`);
	}

	if (parsed.error != null) {
		throw new ScratchpadClientError(
			`${toolName} failed: ${String(parsed.error)}`,
		);
	}

	return parsed;
}

function wireBase(input: ScratchpadReadInput): Record<string, unknown> {
	return {
		task_id: input.taskId,
		session_id: input.sessionId,
		key: input.key,
	};
}

export class MCPScratchpadClient implements ScratchpadClient {
	constructor(
		private readonly transport: ScratchpadMCPTransport,
		private readonly defaults: () => ScratchpadDefaults = getScratchpadDefaults,
	) {}

	async write(input: ScratchpadWriteInput): Promise<void> {
		const defaults = this.defaults();
		const content = await this.transport.callTool("scratchpad_write", {
			...wireBase(input),
			value: input.value,
			ttl_sec: positiveInteger(
				input.ttlSec ?? defaults.ttlSec,
				"scratchpad ttlSec",
			),
			capacity_per_task: positiveInteger(
				input.capacityPerTask ?? defaults.capacityPerTask,
				"scratchpad capacityPerTask",
			),
		});
		parseToolResponse("scratchpad_write", content);
	}

	async read(input: ScratchpadReadInput): Promise<string | null> {
		const content = await this.transport.callTool(
			"scratchpad_read",
			wireBase(input),
		);
		const response = parseToolResponse("scratchpad_read", content);
		const value = response.value;
		if (value == null) {
			return null;
		}
		if (typeof value !== "string") {
			throw new ScratchpadClientError("scratchpad_read value must be a string");
		}
		return value;
	}

	async clear(input: ScratchpadClearInput): Promise<number> {
		const content = await this.transport.callTool("scratchpad_clear", {
			task_id: input.taskId,
			session_id: input.sessionId,
			...(input.key == null ? {} : { key: input.key }),
		});
		const response = parseToolResponse("scratchpad_clear", content);
		const cleared = response.cleared ?? response.count;
		if (
			typeof cleared !== "number" ||
			!Number.isInteger(cleared) ||
			cleared < 0
		) {
			throw new ScratchpadClientError(
				"scratchpad_clear cleared count must be a non-negative integer",
			);
		}
		return cleared;
	}
}

export class NullScratchpadClient implements ScratchpadClient {
	async write(_input: ScratchpadWriteInput): Promise<void> {}

	async read(_input: ScratchpadReadInput): Promise<string | null> {
		return null;
	}

	async clear(_input: ScratchpadClearInput): Promise<number> {
		return 0;
	}
}
