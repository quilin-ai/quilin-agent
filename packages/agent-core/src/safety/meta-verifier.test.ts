import { describe, expect, it } from "vitest";
import type { ActionVerificationResult } from "./action-verifier.js";
import { verifyMetaInvariant } from "./meta-verifier.js";

const allowedAction: ActionVerificationResult = {
	layer: 2,
	decision: "allow",
	code: "allowed",
	reason: "allowed",
};

const blockedAction: ActionVerificationResult = {
	layer: 2,
	decision: "block",
	code: "shell_credential_exfiltration",
	reason: "blocked",
};

describe("verifyMetaInvariant", () => {
	it("passes sanitized and redacted output with consistent metadata", () => {
		expect(
			verifyMetaInvariant({
				sanitizedRedactedContent: "safe [REDACTED:email]",
				action: allowedAction,
				toolResultProduced: true,
				layer1: {
					trustedToolOutput: false,
					hasBlockedThreat: false,
				},
			}),
		).toEqual({
			layer: 4,
			ok: true,
			code: "ok",
		});
	});

	it("fails when raw secret patterns remain", () => {
		const result = verifyMetaInvariant({
			sanitizedRedactedContent: "leaked alpha@example.com",
			action: allowedAction,
			toolResultProduced: true,
			layer1: {
				trustedToolOutput: false,
				hasBlockedThreat: false,
			},
		});

		expect(result).toMatchObject({
			layer: 4,
			ok: false,
			code: "raw_secret_remaining",
		});
	});

	it("fails when .env-style raw secrets remain", () => {
		const result = verifyMetaInvariant({
			sanitizedRedactedContent:
				"JWT_SECRET_KEY=jwt-secret-key-value\nSSH_PRIVATE_KEY=ssh-private-key-value",
			action: allowedAction,
			toolResultProduced: true,
			layer1: {
				trustedToolOutput: false,
				hasBlockedThreat: false,
			},
		});

		expect(result).toMatchObject({
			layer: 4,
			ok: false,
			code: "raw_secret_remaining",
		});
	});

	it("fails when a blocked action produced an executed tool result", () => {
		const result = verifyMetaInvariant({
			sanitizedRedactedContent: "blocked",
			action: blockedAction,
			toolResultProduced: true,
			layer1: {
				trustedToolOutput: false,
				hasBlockedThreat: false,
			},
		});

		expect(result).toMatchObject({
			ok: false,
			code: "blocked_action_produced_result",
		});
	});

	it("fails when blocked Layer 1 output is marked trusted", () => {
		const result = verifyMetaInvariant({
			sanitizedRedactedContent: "[REDACTED: instruction_override]",
			action: allowedAction,
			toolResultProduced: true,
			layer1: {
				trustedToolOutput: true,
				hasBlockedThreat: true,
			},
		});

		expect(result).toMatchObject({
			ok: false,
			code: "blocked_layer1_marked_trusted",
		});
	});
});
