import type { ReactNode } from "react";

export interface TurnProps {
	readonly role: "user" | "assistant" | "system";
	readonly agentId?: string;
	readonly children: ReactNode;
}

function labelFor(role: TurnProps["role"], agentId?: string): ReactNode {
	if (role === "user") {
		return (
			<>
				<span>you</span>
				<span className="dot">·</span>
				<span className="cjk-tag">你</span>
			</>
		);
	}
	if (role === "assistant") {
		return (
			<>
				<span className="cjk-mark">麒麟</span>
				<span className="dot">·</span>
				<span>assistant{agentId && agentId !== "main" ? ` · ${agentId}` : ""}</span>
			</>
		);
	}
	return (
		<>
			<span>system</span>
			<span className="dot">·</span>
			<span className="cjk-tag">派遣</span>
		</>
	);
}

/**
 * Single conversation turn shell — header label + body slot. Per-role styling
 * (user vs assistant vs system) mirrors demo lines 1176–1183 / 1424–1426.
 */
export function Turn({ role, agentId, children }: TurnProps) {
	return (
		<article className="q-turn" data-role={role} data-testid={`turn-${role}`}>
			<div className="q-turn-label">{labelFor(role, agentId)}</div>
			<div className="q-turn-body">{children}</div>
		</article>
	);
}
