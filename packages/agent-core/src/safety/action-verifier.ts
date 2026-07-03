import type { ToolCall } from "../tools/types.js";

export type ActionVerificationCode =
	| "allowed"
	| "sensitive_file_read"
	| "shell_credential_exfiltration"
	| "destructive_shell_intent"
	| "risky_file_write"
	| "risky_file_delete";

export type ActionVerificationResult =
	| {
			readonly layer: 2;
			readonly decision: "allow";
			readonly code: "allowed";
			readonly reason: string;
	  }
	| {
			readonly layer: 2;
			readonly decision: "block";
			readonly code: Exclude<ActionVerificationCode, "allowed">;
			readonly reason: string;
	  };

const READ_ONLY_TOOL_NAMES = new Set([
	"file_list",
	"file_read",
	"memory_recall",
	"skill_view",
	"web_fetch",
]);

const SENSITIVE_PATH_PATTERNS = [
	/(?:^|\/)\.env(?:\..*)?$/i,
	/(?:^|\/)\.npmrc$/i,
	/(?:^|\/)\.netrc$/i,
	/(?:^|\/)\.pypirc$/i,
	/(?:^|\/)\.(?:aws|azure|gcloud|kube|ssh)(?:\/|$)/i,
	/(?:^|\/)\.config\/gcloud(?:\/|$)/i,
	/(?:^|\/)\.aws\/(?:credentials|config)$/i,
	/(?:^|\/)\.kube\/config$/i,
	/(?:^|\/)\.gitconfig$/i,
	/(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
	/(?:^|\/)\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
	/\.(?:pem|key)$/i,
	/^\/etc\/ssh(?:\/|$)/i,
	/^\/etc\/(?:passwd|shadow|sudoers)$/i,
	/^\/root(?:\/|$)/i,
];

const DESTRUCTIVE_SHELL_PATTERNS = [
	/\brm\s+(?:-[^\s]*[rf][^\s]*\s+){0,2}(?:\/|~|\$HOME)(?:\s|$)/i,
	/\brm\s+-[^\s]*r[^\s]*f[^\s]*/i,
	/\bdd\s+if=\/dev\/(?:zero|random|urandom)\s+of=\/dev\//i,
	/\bmkfs(?:\.[a-z0-9]+)?\b/i,
	/\bshutdown\b/i,
	/\breboot\b/i,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
];

// Word boundaries (\b) treat a hyphen as a boundary, so /\benv\b/ matches the
// "env" inside "cross-env" / "dotenv-cli" and blocks legitimate commands like
// `npx cross-env NODE_ENV=production next build`. Exclude hyphen and word chars
// on both sides so only standalone `env` / `printenv` commands match.
const SHELL_CREDENTIAL_EXFILTRATION_PATTERNS = [
	/(?<![\w-])(?:env|printenv)(?![\w-])/i,
];
const SHELL_FILE_READ_PATTERN =
	/\b(?:cat|grep|rg|sed|awk|tail|head|less|more|strings|xxd|od)\b[^\n;&|<>]*/gi;
const SHELL_STDIN_READ_PATTERN =
	/\b(?:cat|grep|rg|sed|awk|tail|head|less|more|strings|xxd|od)\b[^\n;&|]*<\s*(?!<)([^\s;&|<>]+)/gi;

function shortToolName(name: string): string {
	const slashIndex = name.lastIndexOf("/");
	return slashIndex === -1 ? name : name.slice(slashIndex + 1);
}

function allow(
	reason = "No risky pre-execution pattern detected",
): ActionVerificationResult {
	return {
		layer: 2,
		decision: "allow",
		code: "allowed",
		reason,
	};
}

function block(
	code: Exclude<ActionVerificationCode, "allowed">,
	reason: string,
): ActionVerificationResult {
	return {
		layer: 2,
		decision: "block",
		code,
		reason,
	};
}

function getStringArg(
	args: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

function hasSensitivePath(value: string): boolean {
	const normalized = value.trim().replaceAll("\\", "/");
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function cleanShellToken(token: string): string {
	return token.replace(/^[`"'([{<]+|[`"',)\]}>]+$/g, "");
}

function shellReadsSensitivePath(command: string): boolean {
	for (const match of command.matchAll(SHELL_FILE_READ_PATTERN)) {
		const tokens = match[0].split(/\s+/).map(cleanShellToken);
		if (tokens.some((token) => hasSensitivePath(token))) {
			return true;
		}
	}
	for (const match of command.matchAll(SHELL_STDIN_READ_PATTERN)) {
		const redirectTarget = match[1];
		if (
			redirectTarget != null &&
			hasSensitivePath(cleanShellToken(redirectTarget))
		) {
			return true;
		}
	}
	return false;
}

function hasDangerousDeleteTarget(value: string): boolean {
	const normalized = value.trim().replaceAll("\\", "/");
	return (
		normalized === "/" ||
		normalized === "~" ||
		normalized === "$HOME" ||
		normalized.startsWith("/etc/") ||
		normalized.startsWith("/root/") ||
		hasSensitivePath(normalized)
	);
}

function verifyShellCall(command: string): ActionVerificationResult {
	if (
		SHELL_CREDENTIAL_EXFILTRATION_PATTERNS.some((pattern) =>
			pattern.test(command),
		) ||
		shellReadsSensitivePath(command)
	) {
		return block(
			"shell_credential_exfiltration",
			"Shell command appears to read or print credential-bearing files or environment variables",
		);
	}

	if (DESTRUCTIVE_SHELL_PATTERNS.some((pattern) => pattern.test(command))) {
		return block(
			"destructive_shell_intent",
			"Shell command contains destructive filesystem or host-control intent",
		);
	}

	return allow("Shell command passed narrow pre-execution checks");
}

export function verifyAction(toolCall: ToolCall): ActionVerificationResult {
	const name = shortToolName(toolCall.name);

	if (name === "shell_exec") {
		const command = getStringArg(toolCall.arguments, [
			"command",
			"cmd",
			"script",
		]);
		return command == null
			? allow("Shell tool call has no string command to inspect")
			: verifyShellCall(command);
	}

	const path = getStringArg(toolCall.arguments, [
		"path",
		"file",
		"filePath",
		"target",
	]);

	if (name === "file_read") {
		if (path != null && hasSensitivePath(path)) {
			return block(
				"sensitive_file_read",
				"File read targets a credential-bearing or otherwise sensitive path",
			);
		}
		return allow("Read-only tool call allowed");
	}

	if (READ_ONLY_TOOL_NAMES.has(name)) {
		return allow("Read-only tool call allowed");
	}

	if (/(?:^|_)write$|write_file|file_write/i.test(name)) {
		if (path != null && hasSensitivePath(path)) {
			return block(
				"risky_file_write",
				"File write targets a credential-bearing or otherwise sensitive path",
			);
		}
		return allow("File write has no narrow pre-execution blocker");
	}

	if (/(?:^|_)(?:delete|remove|unlink)$|delete_file|file_delete/i.test(name)) {
		if (path != null && hasDangerousDeleteTarget(path)) {
			return block(
				"risky_file_delete",
				"File delete targets a sensitive path or dangerous root",
			);
		}
		return allow("File delete has no narrow pre-execution blocker");
	}

	return allow();
}
