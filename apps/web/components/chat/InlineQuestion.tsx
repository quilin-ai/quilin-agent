"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * `<InlineQuestion>` — Iter F 交互 primitives 单选 / 多选 / 自由文本提问
 * inline 组件。渲染在 assistant turn 内 `data-ask` part 出现的位置。
 *
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §5.1.
 *
 * Slice 2 deliverable: standalone component with submit → POST
 * `/api/chat/answer`. On 200 the component flips to read-only "已回答 ·
 * answered" mode showing the selection. On 410 it shows "已失效 ·
 * expired" (ask timed out or server restarted). Self-resolving timer
 * counts down to the deadline locally.
 *
 * 提交后翻成只读 "已回答";410 表示 ask 已失效;超时本地计数。
 */

export interface InlineQuestionData {
	readonly askId: string;
	/** Per-ask capability token sent with the SSE event; component must
	 *  echo this in the POST body to /api/chat/answer (task #15). */
	readonly askToken: string;
	readonly question: string;
	readonly mode: "single" | "multi" | "free_text";
	readonly options?: ReadonlyArray<{
		readonly id: string;
		readonly label: string;
		readonly description?: string;
	}>;
	readonly defaultId?: string;
	readonly timeoutMs?: number;
}

interface InlineQuestionProps {
	readonly sessionId: string;
	readonly data: InlineQuestionData;
	readonly epoch?: string;
}

type Status = "idle" | "submitting" | "answered" | "expired" | "error";

function formatRemaining(ms: number): string {
	if (ms <= 0) return "0:00";
	const totalSec = Math.ceil(ms / 1000);
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function InlineQuestion({ sessionId, data, epoch }: InlineQuestionProps) {
	const { askId, askToken, question, mode, options, defaultId, timeoutMs } = data;

	const [status, setStatus] = useState<Status>("idle");
	const [singleSelection, setSingleSelection] = useState<string | null>(defaultId ?? null);
	const [multiSelection, setMultiSelection] = useState<Set<string>>(() => new Set());
	const [freeText, setFreeText] = useState("");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const [submittedSummary, setSubmittedSummary] = useState<string | null>(null);

	const deadline = useMemo(
		() => (timeoutMs != null && timeoutMs > 0 ? Date.now() + timeoutMs : null),
		[timeoutMs],
	);
	const [remainingMs, setRemainingMs] = useState(() =>
		deadline != null ? Math.max(0, deadline - Date.now()) : -1,
	);

	useEffect(() => {
		if (deadline == null) return;
		const tick = (): void => {
			const rem = Math.max(0, deadline - Date.now());
			setRemainingMs(rem);
			if (rem <= 0 && status === "idle") setStatus("expired");
		};
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, [deadline, status]);

	const canSubmit =
		status === "idle" &&
		((mode === "single" && singleSelection != null) ||
			(mode === "multi" && multiSelection.size > 0) ||
			(mode === "free_text" && freeText.trim().length > 0));

	const onSubmit = useCallback(async () => {
		if (!canSubmit) return;
		setStatus("submitting");
		setErrorMsg(null);
		const answer =
			mode === "single"
				? { mode: "single" as const, selectedId: singleSelection! }
				: mode === "multi"
					? { mode: "multi" as const, selectedIds: [...multiSelection] }
					: { mode: "free_text" as const, text: freeText.trim() };
		try {
			const res = await fetch("/api/chat/answer", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId,
					askToken,
					...(epoch == null ? {} : { epoch }),
					reply: { kind: "user_answered_question", askId, answer },
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
			// Summarize what was answered for the read-only display.
			let summary: string;
			if (answer.mode === "single") {
				const opt = options?.find((o) => o.id === answer.selectedId);
				summary = opt?.label ?? answer.selectedId;
			} else if (answer.mode === "multi") {
				summary = answer.selectedIds
					.map((id) => options?.find((o) => o.id === id)?.label ?? id)
					.join(" · ");
			} else {
				summary = answer.text;
			}
			setSubmittedSummary(summary);
			setStatus("answered");
		} catch (e) {
			setErrorMsg(e instanceof Error ? e.message : String(e));
			setStatus("error");
		}
	}, [
		canSubmit,
		mode,
		singleSelection,
		multiSelection,
		freeText,
		askId,
		askToken,
		sessionId,
		epoch,
		options,
	]);

	return (
		<div
			className="q-inline-question"
			data-testid="inline-question"
			data-ask-id={askId}
			data-status={status}
			style={{
				border: "1px solid var(--border)",
				borderLeft: "3px solid var(--accent-vermillion)",
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
					麒麟 · 提问 · question
				</span>
				{deadline != null && status === "idle" ? (
					<span
						style={{
							fontFamily: '"JetBrains Mono", monospace',
							fontSize: 10,
							color: remainingMs < 60_000 ? "var(--destructive)" : "var(--fg-muted)",
						}}
						data-testid="inline-question-countdown"
					>
						倒计时 · {formatRemaining(remainingMs)}
					</span>
				) : null}
			</div>
			<div
				style={{
					marginBottom: 10,
					whiteSpace: "pre-wrap",
					fontFamily: '"Noto Sans SC", sans-serif',
					color: "var(--fg)",
				}}
			>
				{question}
			</div>
			{status === "answered" ? (
				<div
					data-testid="inline-question-answered"
					style={{ color: "var(--fg-muted)", fontStyle: "italic" }}
				>
					✓ 已回答 · answered:{" "}
					<strong style={{ color: "var(--fg)", fontStyle: "normal" }}>{submittedSummary}</strong>
				</div>
			) : status === "expired" ? (
				<div data-testid="inline-question-expired" style={{ color: "var(--destructive)" }}>
					⏱ 已失效 · expired
				</div>
			) : (
				<>
					{mode === "single" && options != null
						? options.map((opt) => (
								<label
									key={opt.id}
									style={{
										display: "block",
										padding: "6px 10px",
										marginBottom: 4,
										borderRadius: 4,
										cursor: status === "idle" ? "pointer" : "not-allowed",
										background: singleSelection === opt.id ? "var(--bg)" : "transparent",
										border:
											singleSelection === opt.id
												? "1px solid var(--accent-vermillion)"
												: "1px solid transparent",
									}}
								>
									<input
										type="radio"
										name={`q-${askId}`}
										value={opt.id}
										checked={singleSelection === opt.id}
										onChange={() => setSingleSelection(opt.id)}
										disabled={status !== "idle"}
										style={{ marginRight: 8 }}
									/>
									<span>{opt.label}</span>
									{opt.description ? (
										<div
											style={{
												marginLeft: 22,
												fontSize: 11,
												color: "var(--fg-muted)",
												fontStyle: "italic",
											}}
										>
											{opt.description}
										</div>
									) : null}
								</label>
							))
						: null}
					{mode === "multi" && options != null
						? options.map((opt) => {
								const checked = multiSelection.has(opt.id);
								return (
									<label
										key={opt.id}
										style={{
											display: "block",
											padding: "6px 10px",
											marginBottom: 4,
											borderRadius: 4,
											cursor: status === "idle" ? "pointer" : "not-allowed",
											background: checked ? "var(--bg)" : "transparent",
											border: checked
												? "1px solid var(--accent-vermillion)"
												: "1px solid transparent",
										}}
									>
										<input
											type="checkbox"
											checked={checked}
											onChange={() => {
												setMultiSelection((prev) => {
													const next = new Set(prev);
													if (next.has(opt.id)) next.delete(opt.id);
													else next.add(opt.id);
													return next;
												});
											}}
											disabled={status !== "idle"}
											style={{ marginRight: 8 }}
										/>
										<span>{opt.label}</span>
										{opt.description ? (
											<div
												style={{
													marginLeft: 22,
													fontSize: 11,
													color: "var(--fg-muted)",
													fontStyle: "italic",
												}}
											>
												{opt.description}
											</div>
										) : null}
									</label>
								);
							})
						: null}
					{mode === "free_text" ? (
						<textarea
							data-testid="inline-question-textarea"
							value={freeText}
							onChange={(e) => setFreeText(e.target.value)}
							disabled={status !== "idle"}
							rows={3}
							style={{
								width: "100%",
								padding: 8,
								fontSize: 13,
								fontFamily: '"Noto Sans SC", sans-serif',
								background: "var(--bg)",
								color: "var(--fg)",
								border: "1px solid var(--border)",
								borderRadius: 4,
								resize: "vertical",
							}}
						/>
					) : null}
					<div
						style={{
							display: "flex",
							gap: 8,
							marginTop: 10,
							alignItems: "center",
						}}
					>
						<button
							type="button"
							onClick={onSubmit}
							disabled={!canSubmit}
							data-testid="inline-question-submit"
							style={{
								padding: "6px 16px",
								fontSize: 12,
								background: canSubmit ? "var(--accent-vermillion)" : "var(--border)",
								color: canSubmit ? "var(--bg)" : "var(--fg-muted)",
								border: "none",
								borderRadius: 4,
								cursor: canSubmit ? "pointer" : "not-allowed",
								fontFamily: '"Noto Sans SC", sans-serif',
							}}
						>
							{status === "submitting" ? "提交中…" : "提交 · submit"}
						</button>
						{errorMsg ? (
							<span style={{ color: "var(--destructive)", fontSize: 11 }}>{errorMsg}</span>
						) : null}
					</div>
				</>
			)}
		</div>
	);
}
