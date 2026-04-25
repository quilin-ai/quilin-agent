import type { BenchmarkTask } from "../wire/task.js";
import type { Scorer } from "./types.js";

export class ScorerRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScorerRegistryError";
	}
}

export class ScorerRegistry {
	readonly #scorers = new Map<string, Scorer>();

	register<T extends BenchmarkTask>(
		scorerType: string,
		scorer: Scorer<T>,
	): void {
		const normalizedType = normalizeScorerType(scorerType);

		if (this.#scorers.has(normalizedType)) {
			throw new ScorerRegistryError(
				`Scorer already registered: ${normalizedType}`,
			);
		}

		this.#scorers.set(normalizedType, scorer as Scorer);
	}

	get<T extends BenchmarkTask>(scorerType: string): Scorer<T> {
		const normalizedType = normalizeScorerType(scorerType);
		const scorer = this.#scorers.get(normalizedType);

		if (!scorer) {
			throw new ScorerRegistryError(`Scorer not registered: ${normalizedType}`);
		}

		return scorer as Scorer<T>;
	}

	has(scorerType: string): boolean {
		return this.#scorers.has(normalizeScorerType(scorerType));
	}
}

export function createScorerRegistry(): ScorerRegistry {
	return new ScorerRegistry();
}

function normalizeScorerType(scorerType: string): string {
	const normalizedType = scorerType.trim();

	if (normalizedType.length === 0) {
		throw new ScorerRegistryError("Scorer type must be a non-empty string");
	}

	return normalizedType;
}
