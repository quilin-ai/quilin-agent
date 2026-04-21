import { isAbsolute, relative, resolve } from "node:path";

export interface ThreatMatch {
	readonly pattern: string;
	readonly location: string;
	readonly severity: "warn" | "block";
	readonly matchedText: string;
}

export interface ScanResult {
	readonly safe: boolean;
	readonly threats: readonly ThreatMatch[];
	readonly sanitizedContent: string;
}

export interface ScanExternalContextOptions {
	readonly trustedSource?: boolean;
}

export function isWithinWorkspace(filePath: string): boolean {
	const resolvedWorkspace = resolve(process.cwd());
	const resolvedPath = resolve(filePath);
	const relativePath = relative(resolvedWorkspace, resolvedPath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

export function shouldTrustToolOutput(
	toolName: string,
	toolArgs: Record<string, unknown>,
): boolean {
	return (
		toolName === "file_read" &&
		typeof toolArgs.path === "string" &&
		isWithinWorkspace(toolArgs.path)
	);
}

const THREAT_PATTERNS: ReadonlyArray<{
	readonly name: string;
	readonly regex: RegExp;
	readonly severity: "warn" | "block";
}> = [
	{
		name: "invisible_unicode",
		regex: /(?:\u200B|\u200C|\u200D|\uFEFF|\u200E|\u200F|\u00AD)/g,
		severity: "warn",
	},
	{
		name: "instruction_override",
		regex:
			/\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|constraints?)/gi,
		severity: "block",
	},
	{
		name: "credential_exfiltration",
		regex:
			/\b(print|show|reveal|output|display)\s+(your\s+)?(system\s+prompt|instructions?|api\s*key|secret|password|token)/gi,
		severity: "block",
	},
	{
		name: "hidden_html",
		regex: /<[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>/gi,
		severity: "warn",
	},
	{
		name: "base64_suspicious",
		regex: /[A-Za-z0-9+/]{40,}={0,2}/g,
		severity: "warn",
	},
];

/**
 * 扫描外部来源内容，检测 prompt injection 威胁。
 * 纯函数，不嵌入 builder，由 source collector 调用。
 * 只扫描 isExternal=true 的来源，不扫描内置静态段。
 */
export function scanExternalContext(
	content: string,
	source: string,
	options: ScanExternalContextOptions = {},
): ScanResult {
	if (options.trustedSource) {
		return {
			safe: true,
			threats: [],
			sanitizedContent: content,
		};
	}

	const threats: ThreatMatch[] = [];
	let sanitized = content;

	for (const pattern of THREAT_PATTERNS) {
		const matches = content.matchAll(pattern.regex);
		for (const match of matches) {
			threats.push({
				pattern: pattern.name,
				location: source,
				severity: pattern.severity,
				matchedText: match[0].slice(0, 100),
			});
		}

		if (pattern.severity === "warn" && pattern.name === "invisible_unicode") {
			sanitized = sanitized.replace(pattern.regex, "");
		}

		if (pattern.severity === "block") {
			sanitized = sanitized.replace(
				pattern.regex,
				`[REDACTED: ${pattern.name}]`,
			);
		}
	}

	return {
		safe: threats.length === 0,
		threats,
		sanitizedContent: sanitized,
	};
}
