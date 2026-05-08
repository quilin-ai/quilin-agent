import { describe, expect, it, vi } from "vitest";
import {
	createDockerProposalSandboxPolicyGate,
	DockerProposalSandboxPolicyGate,
} from "./sandbox-policy-gate.js";

describe("DockerProposalSandboxPolicyGate", () => {
	const baseInput = {
		tool: "self_evolution_patch_apply",
		riskLevel: "critical" as const,
		proposalKind: "scaffold_patch" as const,
		proposalId: "proposal:test",
	};

	it("returns docker decision when Docker is available for scaffold_patch", async () => {
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => true,
		});

		await expect(gate.decide(baseInput)).resolves.toEqual({
			kind: "docker",
			provider: "docker",
		});
	});

	it("returns native decision with warning when Docker is unavailable", async () => {
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => false,
		});

		const decision = await gate.decide(baseInput);
		expect(decision.kind).toBe("native");
		if (decision.kind === "native") {
			expect(decision.warning).toMatch(/Docker sandbox unavailable/iu);
		}
	});

	it("honors explicit deny override before probing Docker", async () => {
		const isDockerAvailable = vi.fn(async () => true);
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable,
			denyOverride: () => "policy override",
		});

		const decision = await gate.decide(baseInput);
		expect(decision).toEqual({ kind: "deny", reason: "policy override" });
		// Deny short-circuits before the availability probe runs.
		expect(isDockerAvailable).not.toHaveBeenCalled();
	});

	it("short-circuits to native (no warning) for non scaffold_patch kinds", async () => {
		const isDockerAvailable = vi.fn(async () => true);
		const gate = createDockerProposalSandboxPolicyGate({
			isDockerAvailable,
		});

		const decision = await gate.decide({
			...baseInput,
			proposalKind: "artifact_only",
		});
		expect(decision).toEqual({ kind: "native", warning: "" });
		// Non-scaffold kinds bypass the probe entirely.
		expect(isDockerAvailable).not.toHaveBeenCalled();
	});

	it("ignores blank deny override reasons and falls through to docker probe", async () => {
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => true,
			denyOverride: () => "   ",
		});

		const decision = await gate.decide(baseInput);
		expect(decision).toEqual({ kind: "docker", provider: "docker" });
	});

	it("supports a custom native fallback warning", async () => {
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => false,
			nativeFallbackWarning: "audit-id=42 docker offline",
		});

		const decision = await gate.decide(baseInput);
		expect(decision).toEqual({
			kind: "native",
			warning: "audit-id=42 docker offline",
		});
	});
});
