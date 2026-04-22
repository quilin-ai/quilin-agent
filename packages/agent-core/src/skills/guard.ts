import { THREAT_PATTERNS, type ThreatPattern } from "./threat-patterns.js";
import type {
	GuardDecision,
	GuardFinding,
	GuardSeverity,
	SkillsGuard,
	SkillTrustLevel,
} from "./types.js";

const MAX_MATCH_CHARS = 120;
const DEFAULT_MAX_FINDINGS = 50;
const SEVERITY_RANK: Record<GuardSeverity, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

type PolicyDecision = GuardDecision["kind"];

type PolicyMatrix = Readonly<
	Record<SkillTrustLevel, Readonly<Record<GuardSeverity, PolicyDecision>>>
>;

const DEFAULT_POLICY_MATRIX: PolicyMatrix = {
	builtin: {
		low: "pass",
		medium: "pass",
		high: "pass",
		critical: "pass",
	},
	trusted: {
		low: "pass",
		medium: "warn",
		high: "warn",
		critical: "warn",
	},
	community: {
		low: "pass",
		medium: "ask",
		high: "ask",
		critical: "deny",
	},
	"agent-created": {
		low: "pass",
		medium: "ask",
		high: "deny",
		critical: "deny",
	},
};

export interface CreateSkillsGuardOptions {
	readonly patterns?: readonly ThreatPattern[];
	readonly policyMatrix?: PolicyMatrix;
	readonly maxFindings?: number;
}

function truncateMatch(text: string): string {
	if (text.length <= MAX_MATCH_CHARS) {
		return text;
	}

	return `${text.slice(0, MAX_MATCH_CHARS - 1)}…`;
}

function getLineNumber(text: string, index: number): number {
	return text.slice(0, index).split("\n").length;
}

function getMeaningfulMatchOffset(text: string): number {
	const offset = text.search(/\S/u);
	return offset === -1 ? 0 : offset;
}

function highestSeverity(findings: readonly GuardFinding[]): GuardSeverity {
	return findings.reduce<GuardSeverity>(
		(current, finding) =>
			SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current]
				? finding.severity
				: current,
		"low",
	);
}

function createDecision(
	kind: PolicyDecision,
	findings: readonly GuardFinding[],
	skillName: string,
): GuardDecision {
	switch (kind) {
		case "pass":
			return { kind: "pass" };
		case "warn":
			return { kind: "warn", findings };
		case "ask":
			return { kind: "ask", findings };
		case "deny":
			return {
				kind: "deny",
				findings,
				detail: `skills_guard denied ${skillName} due to matched threat patterns`,
			};
	}
}

export function createSkillsGuard(
	options: CreateSkillsGuardOptions = {},
): SkillsGuard {
	const patterns = options.patterns ?? THREAT_PATTERNS;
	const policyMatrix = options.policyMatrix ?? DEFAULT_POLICY_MATRIX;
	const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;

	return {
		scan(body, ctx) {
			if (ctx.trust === "builtin") {
				return { kind: "pass" };
			}

			const findings: GuardFinding[] = [];
			for (const pattern of patterns) {
				const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
				let match = regex.exec(body);
				while (match != null) {
					const meaningfulOffset = getMeaningfulMatchOffset(match[0]);
					findings.push({
						category: pattern.category,
						severity: pattern.severity,
						pattern_id: pattern.id,
						match: truncateMatch(match[0].trim()),
						line: getLineNumber(body, match.index + meaningfulOffset),
					});
					if (findings.length >= maxFindings) {
						const severity = highestSeverity(findings);
						return createDecision(
							policyMatrix[ctx.trust][severity],
							findings,
							ctx.skillName,
						);
					}
					match = regex.exec(body);
				}
			}

			if (findings.length === 0) {
				return { kind: "pass" };
			}

			const severity = highestSeverity(findings);
			return createDecision(
				policyMatrix[ctx.trust][severity],
				findings,
				ctx.skillName,
			);
		},
	};
}

export { DEFAULT_POLICY_MATRIX };
