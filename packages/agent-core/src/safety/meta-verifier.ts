import type { ActionVerificationResult } from "./action-verifier.js";
import { findSecretPatterns } from "./redaction.js";

export type MetaVerificationCode =
	| "ok"
	| "raw_secret_remaining"
	| "blocked_action_produced_result"
	| "blocked_layer1_marked_trusted";

export type MetaVerificationResult =
	| {
			readonly layer: 4;
			readonly ok: true;
			readonly code: "ok";
	  }
	| {
			readonly layer: 4;
			readonly ok: false;
			readonly code: Exclude<MetaVerificationCode, "ok">;
			readonly reason: string;
	  };

export interface Layer1VerificationMetadata {
	readonly trustedToolOutput: boolean;
	readonly hasBlockedThreat: boolean;
}

export interface MetaVerificationInput {
	readonly sanitizedRedactedContent: string;
	readonly action: ActionVerificationResult;
	readonly toolResultProduced: boolean;
	readonly layer1: Layer1VerificationMetadata;
}

function ok(): MetaVerificationResult {
	return {
		layer: 4,
		ok: true,
		code: "ok",
	};
}

function fail(
	code: Exclude<MetaVerificationCode, "ok">,
	reason: string,
): MetaVerificationResult {
	return {
		layer: 4,
		ok: false,
		code,
		reason,
	};
}

export function verifyMetaInvariant(
	input: MetaVerificationInput,
): MetaVerificationResult {
	const rawSecretMatches = findSecretPatterns(input.sanitizedRedactedContent);
	if (rawSecretMatches.length > 0) {
		return fail(
			"raw_secret_remaining",
			`Raw secret-like output remains after sanitization/redaction: ${rawSecretMatches
				.map((match) => match.kind)
				.join(", ")}`,
		);
	}

	if (input.action.decision === "block" && input.toolResultProduced) {
		return fail(
			"blocked_action_produced_result",
			"Layer 2 blocked the action but an executed tool result was produced",
		);
	}

	if (input.layer1.hasBlockedThreat && input.layer1.trustedToolOutput) {
		return fail(
			"blocked_layer1_marked_trusted",
			"Layer 1 blocked tool output cannot be marked trusted",
		);
	}

	return ok();
}
