export type LiveInputKind = "message" | "slash_command";

export interface QueuedLiveInput {
	readonly id: string;
	readonly turnId: string;
	readonly input: string;
	readonly kind: LiveInputKind;
	readonly receivedAt: string;
}

export interface LiveInputQueueOptions {
	readonly createId?: () => string;
	readonly now?: () => Date;
}

let fallbackSequence = 0;

function createFallbackId(): string {
	fallbackSequence += 1;
	return `live-input-${fallbackSequence}`;
}

export class LiveInputQueue {
	readonly #createId: () => string;
	readonly #now: () => Date;
	#activeTurnId: string | undefined;
	#suspendDepth = 0;

	constructor(options: LiveInputQueueOptions = {}) {
		this.#createId = options.createId ?? createFallbackId;
		this.#now = options.now ?? (() => new Date());
	}

	beginTurn(turnId: string): void {
		this.#activeTurnId = turnId;
	}

	finishTurn(): void {
		this.#activeTurnId = undefined;
		this.#suspendDepth = 0;
	}

	suspend(): () => void {
		this.#suspendDepth += 1;
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.#suspendDepth = Math.max(0, this.#suspendDepth - 1);
		};
	}

	append(input: string): QueuedLiveInput | undefined {
		const trimmed = input.trim();
		if (
			this.#activeTurnId == null ||
			this.#suspendDepth > 0 ||
			trimmed.length === 0
		) {
			return undefined;
		}

		return {
			id: this.#createId(),
			turnId: this.#activeTurnId,
			input: trimmed,
			kind: trimmed.startsWith("/") ? "slash_command" : "message",
			receivedAt: this.#now().toISOString(),
		};
	}
}
