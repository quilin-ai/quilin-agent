import { describe, expect, it, vi } from "vitest";
import {
	createDockerProposalSandboxPolicyGate,
	DockerProposalSandboxPolicyGate,
} from "./sandbox-policy-gate.js";

// Control-character literals composed via String.fromCharCode so the source
// file stays free of stray bytes that would confuse editors / diff tools.
const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);

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

	// HIGH-2 (round-2 cross-review): requireDocker: true → Docker unavailable
	// must hard-fail with deny instead of falling back to native.
	it("denies scaffold_patch apply when requireDocker=true and Docker is unavailable", async () => {
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => false,
			requireDocker: true,
		});

		const decision = await gate.decide(baseInput);
		expect(decision.kind).toBe("deny");
		if (decision.kind === "deny") {
			expect(decision.reason).toMatch(/Docker required/iu);
			expect(decision.reason.length).toBeLessThanOrEqual(200);
		}
	});

	// HIGH-2: requireDocker: true + Docker available still returns docker.
	it("still returns docker when requireDocker=true and Docker is available", async () => {
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => true,
			requireDocker: true,
		});

		await expect(gate.decide(baseInput)).resolves.toEqual({
			kind: "docker",
			provider: "docker",
		});
	});

	// MEDIUM-3 (round-2 cross-review): a thrown probe must be caught and
	// converted to a deny outcome with a sanitized reason — never crash the
	// apply path.
	it("returns deny with a sanitized reason when isDockerAvailable throws", async () => {
		const dirtyMessage = `docker socket${NUL} ${BEL} connection refused${DEL}`;
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => {
				throw new Error(dirtyMessage);
			},
		});

		const decision = await gate.decide(baseInput);
		expect(decision.kind).toBe("deny");
		if (decision.kind === "deny") {
			expect(decision.reason).toMatch(/sandbox probe failed/iu);
			// Sanitization strips C0 controls + DEL from the propagated error
			// message before it enters the decision payload.
			expect(decision.reason).not.toContain(NUL);
			expect(decision.reason).not.toContain(BEL);
			expect(decision.reason).not.toContain(DEL);
		}
	});

	// MEDIUM-3: synchronous (non-async) probe throw is also caught.
	it("treats a synchronous probe error the same as an async one", async () => {
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: () => {
				throw new Error("EACCES /var/run/docker.sock");
			},
		});

		const decision = await gate.decide(baseInput);
		expect(decision.kind).toBe("deny");
		if (decision.kind === "deny") {
			expect(decision.reason).toMatch(/sandbox probe failed/iu);
			expect(decision.reason).toMatch(/EACCES/u);
		}
	});

	// MEDIUM-7 (round-2 cross-review): denyOverride reasons must be sanitized
	// and length-capped so adversarial overrides cannot inject control chars,
	// secrets, or oversized blobs into the gate's audit trail.
	it("sanitizes and length-caps oversized denyOverride reasons", async () => {
		const oversized =
			`${"A".repeat(400)}${BEL}${NUL} secret token sk-${"X".repeat(40)}`;
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => true,
			denyOverride: () => oversized,
		});

		const decision = await gate.decide(baseInput);
		expect(decision.kind).toBe("deny");
		if (decision.kind === "deny") {
			// 200 chars + "...[truncated]" suffix (14 chars) = 214 max.
			expect(decision.reason.length).toBeLessThanOrEqual(214);
			expect(decision.reason).not.toContain(NUL);
			expect(decision.reason).not.toContain(BEL);
			expect(decision.reason).not.toContain(DEL);
			// Truncation marker present whenever original exceeded the cap.
			expect(decision.reason).toMatch(/truncated/u);
		}
	});

	// MEDIUM-7: denyOverride that sanitizes to all-controls falls back to
	// the stable placeholder reason rather than returning an empty string.
	it("falls back to the placeholder reason when denyOverride sanitizes to empty", async () => {
		const gate = new DockerProposalSandboxPolicyGate({
			isDockerAvailable: async () => true,
			denyOverride: () => `${BEL}${BEL}${BEL}`,
		});

		// All-control-char input has trim().length > 0 (control chars are not
		// whitespace), so the gate enters the deny branch and the sanitizer
		// converts the now-empty string to the stable placeholder.
		const decision = await gate.decide(baseInput);
		expect(decision.kind).toBe("deny");
		if (decision.kind === "deny") {
			expect(decision.reason).toBe("policy override");
		}
	});
});
