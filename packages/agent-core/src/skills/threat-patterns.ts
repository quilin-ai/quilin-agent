import type {
	GuardSeverity,
	GuardThreatCategory,
} from "./types.js";

export interface ThreatPattern {
	readonly id: string;
	readonly category: GuardThreatCategory;
	readonly severity: GuardSeverity;
	readonly regex: RegExp;
	readonly rationale: string;
	readonly references: readonly string[];
}

const OWASP_LLM01 =
	"https://genai.owasp.org/llmrisk/llm01-prompt-injection/";
const OWASP_LLM02 =
	"https://genai.owasp.org/llmrisk/llm02-sensitive-information-disclosure/";
const OWASP_LLM05 =
	"https://genai.owasp.org/llmrisk/llm05-improper-output-handling/";
const OWASP_LLM06 =
	"https://genai.owasp.org/llmrisk/llm06-excessive-agency/";
const MITRE_T1059 =
	"https://attack.mitre.org/techniques/T1059/";
const MITRE_T1547 =
	"https://attack.mitre.org/techniques/T1547/";
const MITRE_T1005 =
	"https://attack.mitre.org/techniques/T1005/";
const MITRE_T1027 =
	"https://attack.mitre.org/techniques/T1027/";

export const THREAT_PATTERNS: readonly ThreatPattern[] = [
	{
		id: "DATA-EXFIL-001",
		category: "data_exfiltration",
		severity: "high",
		regex: /~\/\.ssh\b|\.ssh\/authorized_keys\b/giu,
		rationale: "SSH keys and authorized_keys are sensitive local secrets.",
		references: [OWASP_LLM02, MITRE_T1005],
	},
	{
		id: "DATA-EXFIL-002",
		category: "data_exfiltration",
		severity: "high",
		regex: /~\/\.aws\/credentials\b|aws configure get/giu,
		rationale: "Cloud credentials are a common exfiltration target.",
		references: [OWASP_LLM02, MITRE_T1005],
	},
	{
		id: "DATA-EXFIL-003",
		category: "data_exfiltration",
		severity: "high",
		regex: /\/etc\/(?:shadow|passwd|sudoers)\b/giu,
		rationale: "Reading system credential files indicates direct secret theft.",
		references: [OWASP_LLM02, MITRE_T1005],
	},
	{
		id: "DATA-EXFIL-004",
		category: "data_exfiltration",
		severity: "medium",
		regex: /\bcurl\b[^\n]*https?:\/\/[^\s]+|wget\s+https?:\/\/[^\s]+/giu,
		rationale: "Outbound HTTP transfer can be used to exfiltrate captured data.",
		references: [OWASP_LLM02, OWASP_LLM06],
	},
	{
		id: "DATA-EXFIL-005",
		category: "data_exfiltration",
		severity: "medium",
		regex: /\b(?:nslookup|dig)\b[^\n]*\.[a-z0-9-]+\.[a-z]{2,}\b/giu,
		rationale: "DNS lookups can be repurposed as low-bandwidth exfil channels.",
		references: [OWASP_LLM02, MITRE_T1005],
	},
	{
		id: "PROMPT-INJECT-001",
		category: "prompt_injection",
		severity: "medium",
		regex: /ignore (?:all |any |the )?(?:previous|prior|above) instructions/giu,
		rationale: "Instruction override language is the canonical prompt injection form.",
		references: [OWASP_LLM01],
	},
	{
		id: "PROMPT-INJECT-002",
		category: "prompt_injection",
		severity: "medium",
		regex: /you are now (?:in )?(?:developer mode|dan|jailbroken|system mode)/giu,
		rationale: "Role-reassignment language attempts to subvert system behavior.",
		references: [OWASP_LLM01],
	},
	{
		id: "PROMPT-INJECT-003",
		category: "prompt_injection",
		severity: "high",
		regex: /<\|\s*(?:im_start|endoftext|system)\s*\|>/giu,
		rationale: "Control tokens attempt direct prompt boundary injection.",
		references: [OWASP_LLM01],
	},
	{
		id: "PROMPT-INJECT-004",
		category: "prompt_injection",
		severity: "medium",
		regex: /\[\[\s*system prompt\s*\]\]|\[\[\s*override\s*\]\]/giu,
		rationale: "Explicit system-prompt targeting suggests prompt extraction or override.",
		references: [OWASP_LLM01],
	},
	{
		id: "PROMPT-INJECT-005",
		category: "prompt_injection",
		severity: "medium",
		regex: /do not mention this instruction|reveal (?:the )?system prompt/giu,
		rationale: "Stealth or prompt-reveal requests are common injection indicators.",
		references: [OWASP_LLM01],
	},
	{
		id: "DESTRUCT-001",
		category: "destructive_ops",
		severity: "critical",
		regex: /(?:^|[\n;|&])\s*rm\s+-rf\s+\/(?:\s|$)/giu,
		rationale: "Recursive root deletion is an obvious destructive payload.",
		references: [OWASP_LLM05, MITRE_T1059],
	},
	{
		id: "DESTRUCT-002",
		category: "destructive_ops",
		severity: "critical",
		regex: /\bdd\s+if=.*\s+of=\/dev\/(?:sd[a-z]|disk\d|nvme\d+n\d+)/giu,
		rationale: "Raw disk overwrite is a direct destructive operation.",
		references: [OWASP_LLM05, MITRE_T1059],
	},
	{
		id: "DESTRUCT-003",
		category: "destructive_ops",
		severity: "critical",
		regex: /(?:^|[\n;])\s*(?:DROP\s+TABLE|TRUNCATE\s+TABLE)\b/giu,
		rationale: "DDL destruction can cause irreversible data loss.",
		references: [OWASP_LLM05],
	},
	{
		id: "DESTRUCT-004",
		category: "destructive_ops",
		severity: "critical",
		regex: /:\(\)\s*\{\s*:\|:&\s*\};:/gu,
		rationale: "Fork bombs are classic resource-destruction payloads.",
		references: [OWASP_LLM05, MITRE_T1059],
	},
	{
		id: "DESTRUCT-005",
		category: "destructive_ops",
		severity: "high",
		regex: /\b(?:shutdown|reboot)\b\s+(?:-h|\/r|now)/giu,
		rationale: "Host shutdown and reboot commands are destructive service actions.",
		references: [OWASP_LLM05, MITRE_T1059],
	},
	{
		id: "PERSIST-001",
		category: "persistence",
		severity: "high",
		regex: /\bcrontab\b[^\n]*\s-e\b|\/etc\/cron\.(?:d|daily|hourly)\b/giu,
		rationale: "Cron installation is a persistence technique.",
		references: [OWASP_LLM06, MITRE_T1547],
	},
	{
		id: "PERSIST-002",
		category: "persistence",
		severity: "high",
		regex: /\blaunchctl\b[^\n]*(?:load|bootstrap)|LaunchAgents\//giu,
		rationale: "LaunchAgents and launchctl are macOS persistence mechanisms.",
		references: [OWASP_LLM06, MITRE_T1547],
	},
	{
		id: "PERSIST-003",
		category: "persistence",
		severity: "high",
		regex: /\bsystemctl\b[^\n]*(?:enable|link)|\/etc\/systemd\/system\//giu,
		rationale: "Systemd service installation creates persistent execution.",
		references: [OWASP_LLM06, MITRE_T1547],
	},
	{
		id: "PERSIST-004",
		category: "persistence",
		severity: "medium",
		regex: />>\s*~\/\.(?:bashrc|zshrc|profile|bash_profile)\b/giu,
		rationale: "Shell init file modification persists command execution.",
		references: [OWASP_LLM06, MITRE_T1547],
	},
	{
		id: "PERSIST-005",
		category: "persistence",
		severity: "medium",
		regex: /\breg(?:\.exe)?\b[^\n]*\\Run\b|\bHKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\b/giu,
		rationale: "Windows Run keys are a standard persistence location.",
		references: [OWASP_LLM06, MITRE_T1547],
	},
	{
		id: "OBFUSC-001",
		category: "obfuscation",
		severity: "medium",
		regex: /\bbase64\s+-d\b[^\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/giu,
		rationale: "Decoded-and-piped execution hides intent behind encoded payloads.",
		references: [OWASP_LLM05, MITRE_T1027],
	},
	{
		id: "OBFUSC-002",
		category: "obfuscation",
		severity: "medium",
		regex: /\beval\s*\(\s*(?:atob|Buffer\.from)\b/giu,
		rationale: "Runtime decoding followed by eval is a common obfuscation chain.",
		references: [OWASP_LLM05, MITRE_T1027],
	},
	{
		id: "OBFUSC-003",
		category: "obfuscation",
		severity: "medium",
		regex: /(?:\\x[0-9a-f]{2}){6,}/giu,
		rationale: "Long hex-escaped strings often hide commands or payloads.",
		references: [OWASP_LLM05, MITRE_T1027],
	},
	{
		id: "OBFUSC-004",
		category: "obfuscation",
		severity: "medium",
		regex: /[\u200b-\u200f\u202a-\u202e]+/gu,
		rationale: "Zero-width and bidi control characters can conceal malicious text.",
		references: [OWASP_LLM01, MITRE_T1027],
	},
	{
		id: "OBFUSC-005",
		category: "obfuscation",
		severity: "high",
		regex: /\bfromcharcode\b|\bcharcodeat\b|\bpowershell\b[^\n]*-enc\b/giu,
		rationale: "Encoded PowerShell and charcode reconstruction are high-signal obfuscation patterns.",
		references: [OWASP_LLM05, MITRE_T1027],
	},
];

export const CATEGORY_INDEX = new Map<
	GuardThreatCategory,
	readonly ThreatPattern[]
>(
	([
		"data_exfiltration",
		"prompt_injection",
		"destructive_ops",
		"persistence",
		"obfuscation",
	] as const).map((category) => [
		category,
		THREAT_PATTERNS.filter((pattern) => pattern.category === category),
	]),
);
