import { isSensitiveObjectKey, redactString } from "../safety/redaction.js";
import type { JsonValue } from "./types.js";

const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 8_192;
const SELF_EVOLUTION_SENSITIVE_KEY_PATTERN =
	/(api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|token)/iu;
const SELF_EVOLUTION_SENSITIVE_VALUE_PATTERNS = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gu,
	/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/gu,
	/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}/gu,
	/\bxox[abprs]-[A-Za-z0-9-]{16,}/gu,
];

function isSensitiveSelfEvolutionKey(key: string): boolean {
	return (
		isSensitiveObjectKey(key) || SELF_EVOLUTION_SENSITIVE_KEY_PATTERN.test(key)
	);
}

function sanitizeString(value: string): string {
	const selfEvolutionRedacted = SELF_EVOLUTION_SENSITIVE_VALUE_PATTERNS.reduce(
		(current, pattern) => current.replace(pattern, REDACTED),
		value,
	);
	const redacted = redactString(selfEvolutionRedacted);

	if (redacted.length <= MAX_STRING_LENGTH) {
		return redacted;
	}

	return `${redacted.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`;
}

export function sanitizeSelfEvolutionString(value: string): string {
	return sanitizeString(value);
}

export function normalizeEvidenceRefs(
	evidenceRefs: readonly unknown[] | undefined,
): readonly string[] {
	const normalized = new Set<string>();
	for (const evidenceRef of evidenceRefs ?? []) {
		if (typeof evidenceRef !== "string") {
			continue;
		}

		const trimmed = evidenceRef.trim();
		if (trimmed.length === 0) {
			continue;
		}

		const sanitized = sanitizeSelfEvolutionString(trimmed).trim();
		if (sanitized.length > 0) {
			normalized.add(sanitized);
		}
	}

	return [...normalized];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeForSelfEvolution(value: unknown): JsonValue {
	if (value == null) {
		return null;
	}

	if (typeof value === "string") {
		return sanitizeString(value);
	}

	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}

	if (typeof value === "boolean") {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeForSelfEvolution(item));
	}

	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entryValue]) => {
				const sanitizedKey = sanitizeString(key);
				const sensitiveKey = isSensitiveSelfEvolutionKey(key);
				return [
					sensitiveKey ? REDACTED : sanitizedKey,
					sensitiveKey ? REDACTED : sanitizeForSelfEvolution(entryValue),
				];
			}),
		);
	}

	return String(value);
}
