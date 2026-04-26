import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BfclStatefulRuntimeSpawnOptions {
	readonly checkerRoot: string;
	readonly initialConfig?: Readonly<Record<string, unknown>>;
	readonly longContext?: boolean;
	readonly workerScriptPath?: string;
	readonly pythonExecutable?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly forwardSignals?: boolean;
	readonly commandTimeoutMs?: number;
	readonly idleTimeoutMs?: number;
	readonly maxOutputBytes?: number;
}

export interface BfclStatefulToolCall {
	readonly function: string;
	readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface BfclStatefulToolResult {
	readonly class: string;
	readonly function: string;
	readonly returnValue: unknown;
	readonly stateSnapshot: unknown;
}

export interface BfclStatefulSession {
	readonly taskId: string;
	readonly involvedClasses: readonly string[];
	callTool(
		name: string,
		args?: Readonly<Record<string, unknown>>,
	): Promise<BfclStatefulToolResult>;
	snapshot(): Promise<unknown>;
	close(): Promise<void>;
}

export class BfclStatefulRuntimeError extends Error {
	readonly errorType: string;
	readonly details: unknown;

	constructor(message: string, errorType: string, details?: unknown) {
		super(message);
		this.name = "BfclStatefulRuntimeError";
		this.errorType = errorType;
		this.details = details;
	}
}

type WorkerMessage = Readonly<Record<string, unknown>>;

interface PendingRequest {
	readonly resolve: (message: WorkerMessage) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

const defaultCommandTimeoutMs = 10_000;
const defaultIdleTimeoutMs = 60_000;
const defaultMaxOutputBytes = 1024 * 1024;

export const StatefulRuntime = {
	spawn: spawnBfclStatefulRuntime,
} as const;

export async function spawnBfclStatefulRuntime(
	taskId: string,
	involvedClasses: readonly string[],
	options: BfclStatefulRuntimeSpawnOptions,
): Promise<BfclStatefulSession> {
	const session = new BfclStatefulRuntimeSession(
		taskId,
		involvedClasses,
		options,
	);
	await session.start();
	return session;
}

class BfclStatefulRuntimeSession implements BfclStatefulSession {
	readonly taskId: string;
	readonly involvedClasses: readonly string[];
	private readonly options: Required<
		Pick<
			BfclStatefulRuntimeSpawnOptions,
			"commandTimeoutMs" | "idleTimeoutMs" | "maxOutputBytes"
		>
	> &
		BfclStatefulRuntimeSpawnOptions;
	private child: ChildProcessWithoutNullStreams | undefined;
	private stdoutBuffer = "";
	private stdoutBytes = 0;
	private nextId = 1;
	private pending = new Map<string, PendingRequest>();
	private startupReady:
		| {
				readonly promise: Promise<void>;
				readonly resolve: () => void;
				readonly reject: (error: Error) => void;
		  }
		| undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(
		taskId: string,
		involvedClasses: readonly string[],
		options: BfclStatefulRuntimeSpawnOptions,
	) {
		this.taskId = requireNonEmpty(taskId, "taskId");
		this.involvedClasses = [...involvedClasses];
		this.options = {
			...options,
			commandTimeoutMs: options.commandTimeoutMs ?? defaultCommandTimeoutMs,
			idleTimeoutMs: options.idleTimeoutMs ?? defaultIdleTimeoutMs,
			maxOutputBytes: options.maxOutputBytes ?? defaultMaxOutputBytes,
		};
	}

	async start(): Promise<void> {
		if (this.child != null) {
			return;
		}
		const workerScriptPath =
			this.options.workerScriptPath ?? defaultWorkerScriptPath();
		const child = spawn(
			this.options.pythonExecutable ?? "python3",
			[workerScriptPath],
			{
				env: {
					...process.env,
					...this.options.env,
					BFCL_CHECKER_ROOT: this.options.checkerRoot,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.child = child;
		this.startupReady = promiseWithResolvers();
		if (this.options.forwardSignals !== false) {
			this.installProcessSignalForwarding();
		}
		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
		child.on("error", (error) => this.rejectAll(error));
		child.on("close", (code) => {
			this.cleanup();
			if (!this.closed) {
				this.rejectAll(
					new BfclStatefulRuntimeError(
						`BFCL stateful worker exited with code ${code}`,
						"worker_exit",
					),
				);
			}
		});
		this.refreshIdleTimer();
		try {
			await this.startupReady.promise;
			await this.sendCommand({
				initial_config: this.options.initialConfig ?? {},
				involved_classes: this.involvedClasses,
				long_context: this.options.longContext ?? false,
				task_id: this.taskId,
				type: "init_task",
			});
		} catch (error) {
			this.closed = true;
			this.cleanup();
			this.killChild("SIGKILL");
			throw error;
		}
	}

	async callTool(
		name: string,
		args: Readonly<Record<string, unknown>> = {},
	): Promise<BfclStatefulToolResult> {
		const message = await this.sendCommand({
			call: { arguments: args, function: name },
			type: "call_tool",
		});
		return {
			class: readString(message.class, "class"),
			function: readString(message.function, "function"),
			returnValue: message.return_value,
			stateSnapshot: message.state_snapshot,
		};
	}

	async snapshot(): Promise<unknown> {
		const message = await this.sendCommand({ type: "snapshot" });
		return message.state;
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		try {
			await this.sendCommand({ type: "close" });
		} finally {
			this.closed = true;
			this.cleanup();
			this.child?.kill("SIGTERM");
		}
	}

	private sendCommand(
		command: Record<string, unknown>,
	): Promise<WorkerMessage> {
		const child = this.requireChild();
		if (this.closed) {
			return Promise.reject(new Error("BFCL stateful session is closed"));
		}
		this.refreshIdleTimer();
		const id = String(this.nextId);
		this.nextId += 1;
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.killChild("SIGKILL");
				rejectPromise(
					new BfclStatefulRuntimeError(
						`BFCL stateful worker command timed out: ${command.type}`,
						"worker_timeout",
					),
				);
			}, this.options.commandTimeoutMs);
			this.pending.set(id, {
				reject: rejectPromise,
				resolve: resolvePromise,
				timer,
			});
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	private handleStdout(chunk: Buffer): void {
		this.stdoutBytes += chunk.byteLength;
		if (this.stdoutBytes > this.options.maxOutputBytes) {
			this.rejectAll(
				new BfclStatefulRuntimeError(
					"BFCL stateful worker exceeded stdout limit",
					"worker_output_limit",
				),
			);
			this.killChild("SIGKILL");
			return;
		}
		this.stdoutBuffer += chunk.toString("utf8");
		while (true) {
			const newlineIndex = this.stdoutBuffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}
			const line = this.stdoutBuffer.slice(0, newlineIndex);
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line.trim().length > 0) {
				this.handleWorkerLine(line);
			}
		}
	}

	private handleWorkerLine(line: string): void {
		let message: WorkerMessage;
		try {
			const parsed = JSON.parse(line);
			if (
				parsed == null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed)
			) {
				throw new Error("line is not an object");
			}
			message = parsed as WorkerMessage;
		} catch (error) {
			this.rejectAll(
				new BfclStatefulRuntimeError(
					`BFCL stateful worker emitted invalid JSON: ${error}`,
					"worker_protocol_error",
				),
			);
			this.killChild("SIGKILL");
			return;
		}

		if (message.type === "ready" && message.id == null) {
			this.startupReady?.resolve();
			return;
		}

		const id = typeof message.id === "string" ? message.id : undefined;
		if (id == null) {
			return;
		}
		const pending = this.pending.get(id);
		if (pending == null) {
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(id);
		if (message.type === "error") {
			pending.reject(
				new BfclStatefulRuntimeError(
					readString(message.message, "message"),
					readString(message.error_type, "error_type"),
					message.details,
				),
			);
			return;
		}
		pending.resolve(message);
	}

	private handleStderr(chunk: Buffer): void {
		if (chunk.byteLength > this.options.maxOutputBytes) {
			this.killChild("SIGKILL");
		}
	}

	private installProcessSignalForwarding(): void {
		process.on("SIGINT", this.forwardSigint);
		process.on("SIGTERM", this.forwardSigterm);
	}

	private readonly forwardSigint = () => {
		this.killChild("SIGINT");
	};

	private readonly forwardSigterm = () => {
		this.killChild("SIGTERM");
	};

	private refreshIdleTimer(): void {
		if (this.options.idleTimeoutMs <= 0) {
			return;
		}
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.rejectAll(
				new BfclStatefulRuntimeError(
					"BFCL stateful worker idle timeout",
					"worker_idle_timeout",
				),
			);
			this.killChild("SIGKILL");
		}, this.options.idleTimeoutMs);
		this.idleTimer.unref?.();
	}

	private requireChild(): ChildProcessWithoutNullStreams {
		if (this.child == null) {
			throw new Error("BFCL stateful worker has not started");
		}
		return this.child;
	}

	private killChild(signal: NodeJS.Signals): void {
		this.child?.kill(signal);
	}

	private rejectAll(error: Error): void {
		this.startupReady?.reject(error);
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}

	private cleanup(): void {
		clearTimeout(this.idleTimer);
		process.removeListener("SIGINT", this.forwardSigint);
		process.removeListener("SIGTERM", this.forwardSigterm);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
		}
	}
}

function promiseWithResolvers(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
} {
	let resolvePromise: () => void = () => undefined;
	let rejectPromise: (error: Error) => void = () => undefined;
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function readString(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`BFCL stateful worker response missing ${fieldName}`);
	}
	return value;
}

function requireNonEmpty(value: string, fieldName: string): string {
	if (value.trim().length === 0) {
		throw new TypeError(`BFCL stateful runtime requires ${fieldName}`);
	}
	return value;
}

function defaultWorkerScriptPath(): string {
	return resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../../scripts/bfcl-stateful-worker.py",
	);
}

export const __privateForTests = {
	defaultWorkerScriptPath,
} as const;
