import type { FirstRunOnboardingPlan } from "../config/first-run.js";

function stepStatusIcon(status: string): string {
	if (status === "complete") {
		return "[OK]";
	}
	if (status === "required") {
		return "[REQUIRED]";
	}
	return "[recommended]";
}

export function formatFirstRunWelcome(plan: FirstRunOnboardingPlan): string {
	const lines: string[] = [];

	// Header
	lines.push("");
	lines.push(
		"╔══════════════════════════════════════════════════════════════╗",
	);
	lines.push(
		"║              QUILIN AGENT — First Run                        ║",
	);
	lines.push(
		"║          麒麟 (Qilin) Self-Evolving Agent                    ║",
	);
	lines.push(
		"╚══════════════════════════════════════════════════════════════╝",
	);
	lines.push("");

	// Welcome line
	lines.push("Welcome! This appears to be your first run.");
	lines.push("");

	// Config path
	if (plan.configPath != null) {
		lines.push(`Configuration file: ${plan.configPath}`);
	} else {
		lines.push("No configuration file found — using built-in defaults.");
	}
	lines.push("");

	// Step summary
	const requiredCount = plan.requiredStepIds.length;
	const recommendedCount = plan.recommendedStepIds.length;
	const completeCount = plan.steps.length - requiredCount - recommendedCount;
	lines.push(
		`Onboarding: ${completeCount} OK, ${requiredCount} required, ${recommendedCount} recommended`,
	);
	lines.push("");

	// Individual steps
	for (const step of plan.steps) {
		const icon = stepStatusIcon(step.status);
		lines.push(`  ${icon} ${step.title}: ${step.summary}`);
		for (const action of step.actions) {
			lines.push(`       - ${action}`);
		}
	}

	lines.push("");

	// Quick start guide
	if (requiredCount > 0) {
		lines.push("Quick start:");
		lines.push("  Run `quilin config init` to create your configuration file,");
		lines.push("  or set DEEPSEEK_API_KEY in your environment to get started.");
		lines.push("");
	}

	// Tip
	lines.push("Tip: Customize my personality in ~/.quilin/soul.md");
	lines.push("");

	return lines.join("\n");
}
