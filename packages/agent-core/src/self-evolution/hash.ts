import { createHash } from "node:crypto";

function stableNormalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => stableNormalize(item));
	}

	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));

		return Object.fromEntries(
			entries.map(([key, entryValue]) => [key, stableNormalize(entryValue)]),
		);
	}

	return value;
}

export function stableStringify(value: unknown): string {
	return JSON.stringify(stableNormalize(value));
}

export function createStableHash(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function createArtifactHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function createStableRef(
	prefix: string,
	parts: readonly unknown[],
): string {
	const digest = createStableHash(parts).slice(0, 16);
	const safePrefix = prefix.replace(/[^a-z0-9:_-]+/giu, "-").toLowerCase();
	return `${safePrefix}:${digest}`;
}
