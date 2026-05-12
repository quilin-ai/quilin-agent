"use client";

import { useCallback, useState } from "react";

export interface AuthorityBarProps {
	readonly label?: string;
	readonly onAuthorize?: () => Promise<void> | void;
	readonly onDeny?: () => Promise<void> | void;
}

type Resolution = "pending" | "authorized" | "denied" | "resolving";

/**
 * Inline authorize / deny pair — dashed top border in destructive color so
 * users notice the gate (per demo lines 746–768). After click, the buttons
 * are replaced by a status label.
 */
export function AuthorityBar({
	label = "需要您的授权 · pending authorization",
	onAuthorize,
	onDeny,
}: AuthorityBarProps) {
	const [state, setState] = useState<Resolution>("pending");

	const handle = useCallback(
		async (decision: "approve" | "deny") => {
			if (state !== "pending") return;
			setState("resolving");
			try {
				if (decision === "approve") {
					await onAuthorize?.();
					setState("authorized");
				} else {
					await onDeny?.();
					setState("denied");
				}
			} catch {
				// fall back to pending so the user can retry
				setState("pending");
			}
		},
		[state, onAuthorize, onDeny],
	);

	if (state === "authorized") {
		return (
			<div className="q-authority-bar" data-resolution="authorized">
				<span className="label" style={{ color: "var(--accent-jade)" }}>
					已授权 · running
				</span>
			</div>
		);
	}
	if (state === "denied") {
		return (
			<div className="q-authority-bar" data-resolution="denied">
				<span className="label" style={{ color: "var(--destructive)" }}>
					已拒绝 · subagent terminated
				</span>
			</div>
		);
	}

	return (
		<div className="q-authority-bar" data-resolution={state}>
			<span className="label">{label}</span>
			<button
				type="button"
				className="authorize"
				disabled={state === "resolving"}
				onClick={() => handle("approve")}
				data-testid="authorize"
			>
				授权 · authorize
			</button>
			<button
				type="button"
				className="deny"
				disabled={state === "resolving"}
				onClick={() => handle("deny")}
				data-testid="deny"
			>
				拒绝 · deny
			</button>
		</div>
	);
}
