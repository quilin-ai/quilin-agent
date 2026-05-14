"use client";

import { useCallback, useState } from "react";

/**
 * `<InlineApproval>` — Iter F 交互 primitives approval gate inline 组件.
 *
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §5.2.
 *
 * Renders an allow/deny prompt with optional "always allow at this
 * risk level for this session" toggle. POSTs the resulting decision
 * to `/api/chat/answer`. Status state machine mirrors `<InlineQuestion>`.
 */

export interface InlineApprovalData {
	readonly askId: string;
	/** Per-ask capability token; component must echo it in the POST
	 *  body to /api/chat/answer (task #15). */
	readonly askToken: string;
	readonly tool: string;
	readonly riskLevel: "low" | "medium" | "high" | "critical";
	readonly summary: string;
	readonly detail?: string;
	readonly origin: "user" | "agent" | "idle";
}

interface InlineApprovalProps {
	readonly sessionId: string;
	readonly data: InlineApprovalData;
	readonly epoch?: string;
}

type Status = "idle" | "submitting" | "decided" | "expired" | "error";

function riskColor(level: InlineApprovalData["riskLevel"]): string {
	switch (level) {
		case "low":
			return "var(--fg-muted)";
		case "medium":
			return "var(--accent-vermillion)";
		case "high":
		case "critical":
			return "var(--destructive)";
	}
}

export function InlineApproval({ sessionId, data, epoch }: InlineApprovalProps) {
	const { askId, askToken, tool, riskLevel, summary, detail, origin } = data;

	const [status, setStatus] = useState<Status>("idle");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [alwaysAllow, setAlwaysAllow] = useState(false);
	const [decision, setDecision] = useState<string | null>(null);

	const post = useCallback(
		async (
			decisionKind: "allow" | "deny" | "allow_always_low" | "allow_always_medium",
		): Promise<void> => {
			setStatus("submitting");
			setErrorMsg(null);
			try {
				const res = await fetch("/api/chat/answer", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sessionId,
						askToken,
						...(epoch == null ? {} : { epoch }),
						reply: { kind: "user_decision", askId, decision: decisionKind },
					}),
				});
				if (res.status === 410) {
					setStatus("expired");
					return;
				}
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					setErrorMsg(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
					setStatus("error");
					return;
				}
				setDecision(decisionKind);
				setStatus("decided");
			} catch (e) {
				setErrorMsg(e instanceof Error ? e.message : String(e));
				setStatus("error");
			}
		},
		[sessionId, epoch, askId, askToken],
	);

	const onAllow = useCallback((): void => {
		if (alwaysAllow && (riskLevel === "low" || riskLevel === "medium")) {
			void post(`allow_always_${riskLevel}` as const);
		} else {
			void post("allow");
		}
	}, [alwaysAllow, riskLevel, post]);

	return (
		<div
			className="q-inline-approval"
			data-testid="inline-approval"
			data-ask-id={askId}
			data-status={status}
			data-risk={riskLevel}
			style={{
				border: "1px solid var(--border)",
				borderLeft: `3px solid ${riskColor(riskLevel)}`,
				borderRadius: 6,
				padding: "12px 14px",
				margin: "10px 0",
				background: "var(--bg-soft)",
				fontSize: 13,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "baseline",
					justifyContent: "space-between",
					marginBottom: 8,
				}}
			>
				<span
					style={{
						fontFamily: '"Noto Sans SC", sans-serif',
						fontSize: 11,
						color: "var(--fg-muted)",
						letterSpacing: "0.05em",
					}}
				>
					麒麟 · 需要授权 · {riskLevel}
					{origin === "idle" ? " · idle" : ""}
				</span>
			</div>
			<div style={{ marginBottom: 6, fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
				<span style={{ color: "var(--fg-muted)" }}>tool:</span>{" "}
				<strong style={{ color: "var(--fg)" }}>{tool}</strong>
			</div>
			<div
				style={{
					marginBottom: 8,
					whiteSpace: "pre-wrap",
					fontFamily: '"Noto Sans SC", sans-serif',
					color: "var(--fg)",
				}}
			>
				{summary}
			</div>
			{detail ? (
				<div style={{ marginBottom: 8 }}>
					<button
						type="button"
						onClick={() => setDetailOpen((v) => !v)}
						data-testid="inline-approval-detail-toggle"
						style={{
							background: "none",
							border: "none",
							padding: 0,
							cursor: "pointer",
							fontSize: 11,
							color: "var(--fg-muted)",
							fontFamily: '"JetBrains Mono", monospace',
						}}
					>
						{detailOpen ? "▾ 详情" : "▸ 详情"}
					</button>
					{detailOpen ? (
						<pre
							style={{
								marginTop: 6,
								padding: 8,
								fontSize: 11,
								background: "var(--bg)",
								border: "1px solid var(--border)",
								borderRadius: 4,
								overflow: "auto",
								whiteSpace: "pre-wrap",
								color: "var(--fg)",
							}}
						>
							{detail}
						</pre>
					) : null}
				</div>
			) : null}
			{status === "decided" ? (
				<div
					data-testid="inline-approval-decided"
					style={{ color: "var(--fg-muted)", fontStyle: "italic" }}
				>
					{decision === "deny"
						? "✗ 已拒绝 · denied"
						: decision === "allow"
							? "✓ 已允许 · allowed (本次)"
							: `✓ 已允许 · allowed (本会话同等风险等级自动放行)`}
				</div>
			) : status === "expired" ? (
				<div data-testid="inline-approval-expired" style={{ color: "var(--destructive)" }}>
					⏱ 已失效 · expired
				</div>
			) : (
				<>
					<div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
						<button
							type="button"
							onClick={onAllow}
							disabled={status !== "idle"}
							data-testid="inline-approval-allow"
							style={{
								padding: "6px 16px",
								fontSize: 12,
								background: "var(--accent-vermillion)",
								color: "var(--bg)",
								border: "none",
								borderRadius: 4,
								cursor: status === "idle" ? "pointer" : "not-allowed",
								fontFamily: '"Noto Sans SC", sans-serif',
							}}
						>
							允许 · allow
						</button>
						<button
							type="button"
							onClick={() => void post("deny")}
							disabled={status !== "idle"}
							data-testid="inline-approval-deny"
							style={{
								padding: "6px 16px",
								fontSize: 12,
								background: "transparent",
								color: "var(--destructive)",
								border: `1px solid var(--destructive)`,
								borderRadius: 4,
								cursor: status === "idle" ? "pointer" : "not-allowed",
								fontFamily: '"Noto Sans SC", sans-serif',
							}}
						>
							拒绝 · deny
						</button>
						{errorMsg ? (
							<span style={{ color: "var(--destructive)", fontSize: 11 }}>{errorMsg}</span>
						) : null}
					</div>
					{(riskLevel === "low" || riskLevel === "medium") && status === "idle" ? (
						<label
							data-testid="inline-approval-always-allow"
							style={{
								display: "flex",
								alignItems: "center",
								gap: 6,
								marginTop: 8,
								fontSize: 11,
								color: "var(--fg-muted)",
								cursor: "pointer",
							}}
						>
							<input
								type="checkbox"
								checked={alwaysAllow}
								onChange={(e) => setAlwaysAllow(e.target.checked)}
							/>
							本会话同等风险等级({riskLevel})自动放行
						</label>
					) : null}
				</>
			)}
		</div>
	);
}
