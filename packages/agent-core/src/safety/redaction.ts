export type JsonLike =
	| null
	| boolean
	| number
	| string
	| readonly JsonLike[]
	| { readonly [key: string]: JsonLike };

export interface SecretPatternMatch {
	readonly kind: string;
	readonly matchedText: string;
}

const REDACTED_VALUE = "[REDACTED]";
const REDACTED_ENV_SECRET = "[REDACTED:env_secret]";

const SECRET_PATTERNS: ReadonlyArray<{
	readonly kind: string;
	readonly regex: RegExp;
	readonly replacement: string | ((...args: string[]) => string);
}> = [
	{
		kind: "pem_private_key",
		regex:
			/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
		replacement: "[REDACTED:pem_private_key]",
	},
	{
		kind: "aws_access_key",
		regex: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g,
		replacement: "[REDACTED:aws_access_key]",
	},
	{
		kind: "google_api_key",
		regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
		replacement: "[REDACTED:google_api_key]",
	},
	{
		kind: "jwt",
		regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		replacement: "[REDACTED:jwt]",
	},
	{
		kind: "bearer_token",
		regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
		replacement: "Bearer [REDACTED:bearer_token]",
	},
	{
		kind: "openai_key",
		regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
		replacement: "[REDACTED:openai_key]",
	},
	{
		kind: "github_token",
		regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
		replacement: "[REDACTED:github_token]",
	},
	{
		kind: "slack_token",
		regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
		replacement: "[REDACTED:slack_token]",
	},
	{
		kind: "database_url",
		regex:
			/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:[^@\s]+@[^\s"'<>]+/gi,
		replacement: "[REDACTED:database_url]",
	},
	{
		kind: "email",
		regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
		replacement: "[REDACTED:email]",
	},
	{
		kind: "sensitive_path",
		regex:
			/(^|[\s"'=:(])((?:~|\/Users\/[^/\s"'<>]+|\/home\/[^/\s"'<>]+)\/(?:\.aws|\.azure|\.config\/gcloud|\.gcloud|\.kube|\.ssh)(?:\/[^\s"'<>]*)?)/gi,
		replacement: "$1[REDACTED:sensitive_path]",
	},
];

const SENSITIVE_KEY_NAMES = new Set([
	"accesstoken",
	"apikey",
	"authorization",
	"authtoken",
	"bearertoken",
	"clientsecret",
	"credential",
	"credentials",
	"databaseurl",
	"deepseekapikey",
	"githubtoken",
	"openaiapikey",
	"password",
	"privatekey",
	"secret",
	"secretkey",
	"sessiontoken",
	"slacktoken",
	"token",
]);
const SENSITIVE_KEY_SUFFIXES = [
	"apikey",
	"privatekey",
	"secretkey",
	"token",
	"secret",
	"password",
];
const ENV_ASSIGNMENT_PATTERN =
	/^([ \t]*(?:\d+:[ \t]*)?(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gm;
const INLINE_ENV_ASSIGNMENT_PATTERN =
	/\b([A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'<>),;]+)/g;

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKeyName(key: string): boolean {
	const normalized = normalizeKey(key);
	return (
		SENSITIVE_KEY_NAMES.has(normalized) ||
		SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
	);
}

export function isSensitiveObjectKey(key: string): boolean {
	return isSensitiveKeyName(key);
}

function redactEnvSecretLines(value: string): string {
	return value.replace(ENV_ASSIGNMENT_PATTERN, (match, prefix, key) =>
		isSensitiveKeyName(key) ? `${prefix}${REDACTED_ENV_SECRET}` : match,
	);
}

function redactInlineEnvSecrets(value: string): string {
	return value.replace(INLINE_ENV_ASSIGNMENT_PATTERN, (match, prefix) => {
		const key = prefix.split("=")[0]?.trim() ?? "";
		const envValue = envValueFromMatch(match, prefix);
		if (
			isSensitiveKeyName(key) &&
			envValue !== "" &&
			!envValue.startsWith("[REDACTED")
		) {
			return `${prefix}${REDACTED_ENV_SECRET}`;
		}
		return match;
	});
}

function envValueFromMatch(match: string, prefix: string): string {
	return match
		.slice(prefix.length)
		.trim()
		.replace(/^["']|["']$/g, "");
}

function findEnvSecretLines(value: string): readonly SecretPatternMatch[] {
	const matches: SecretPatternMatch[] = [];
	for (const match of value.matchAll(ENV_ASSIGNMENT_PATTERN)) {
		const key = match[2];
		const prefix = match[1] ?? "";
		const envValue = envValueFromMatch(match[0], prefix);
		if (
			key != null &&
			isSensitiveKeyName(key) &&
			envValue !== "" &&
			!envValue.startsWith("[REDACTED")
		) {
			matches.push({
				kind: "env_secret",
				matchedText: match[0].slice(0, 100),
			});
		}
	}
	return matches;
}

function findInlineEnvSecrets(value: string): readonly SecretPatternMatch[] {
	const matches: SecretPatternMatch[] = [];
	for (const match of value.matchAll(INLINE_ENV_ASSIGNMENT_PATTERN)) {
		const index = match.index ?? 0;
		if (index === 0 || value[index - 1] === "\n") {
			continue;
		}

		const prefix = match[1] ?? "";
		const key = prefix.split("=")[0]?.trim() ?? "";
		const envValue = envValueFromMatch(match[0], prefix);
		if (
			isSensitiveKeyName(key) &&
			envValue !== "" &&
			!envValue.startsWith("[REDACTED")
		) {
			matches.push({
				kind: "env_secret",
				matchedText: match[0].slice(0, 100),
			});
		}
	}
	return matches;
}

export function redactString(value: string): string {
	return SECRET_PATTERNS.reduce(
		(redacted, pattern) => {
			if (typeof pattern.replacement === "string") {
				return redacted.replace(pattern.regex, pattern.replacement);
			}
			return redacted.replace(pattern.regex, pattern.replacement);
		},
		redactInlineEnvSecrets(redactEnvSecretLines(value)),
	);
}

export function findSecretPatterns(
	value: string,
): readonly SecretPatternMatch[] {
	const matches: SecretPatternMatch[] = [
		...findEnvSecretLines(value),
		...findInlineEnvSecrets(value),
	];
	for (const pattern of SECRET_PATTERNS) {
		for (const match of value.matchAll(pattern.regex)) {
			matches.push({
				kind: pattern.kind,
				matchedText: match[0].slice(0, 100),
			});
		}
	}
	return matches;
}

export function hasSecretPattern(value: string): boolean {
	return findSecretPatterns(value).length > 0;
}

export function redactJsonLikeValue<T>(value: T): T {
	return redactUnknown(value, new WeakSet<object>()) as T;
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") {
		return redactString(value);
	}

	if (value == null || typeof value !== "object") {
		return value;
	}

	if (seen.has(value)) {
		return REDACTED_VALUE;
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => redactUnknown(item, seen));
	}

	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		output[key] = isSensitiveObjectKey(key)
			? REDACTED_VALUE
			: redactUnknown(item, seen);
	}
	return output;
}

export function redactToolOutput(content: string): string {
	const redacted = redactString(content);
	try {
		return JSON.stringify(redactJsonLikeValue(JSON.parse(redacted)));
	} catch {
		return redacted;
	}
}
