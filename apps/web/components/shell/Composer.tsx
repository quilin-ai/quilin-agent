"use client";

import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { AgentSummary } from "@/lib/schemas";

import { AgentSwitcher } from "./AgentSwitcher";

const MAX_HEIGHT_PX = 200;
const PLACEHOLDER_DEFAULT = "继续提问,或 / 开启命令…  (Shift+↵ 换行)";
const PLACEHOLDER_INTRO = "开始一次对话…";

export interface ComposerProps {
	readonly agents: readonly AgentSummary[];
	readonly currentAgentId: string | null;
	/** Scopes the AgentSwitcher popover to subagents belonging to this chat session. */
	readonly sessionId?: string;
	readonly hidden?: boolean;
	readonly intro?: boolean;
	readonly onSubmit?: (text: string) => void;
	readonly onSelectAgent?: (agentId: string) => void;
	/**
	 * QUI-182 follow-up: 当上一轮 chat 还在 server-side pump(浏览器流可能 ready
	 * 但 AgentService.session.status === "running")或排队中 → button disabled,
	 * 输入框仍可继续打字。配合 ConversationView 的 drain probe 实现客户端背压,
	 * 减少 `evicted: user input changed` 触发。
	 */
	readonly sendDisabled?: boolean;
	/** disable 状态下显示给用户的提示文案。默认"思考中…"。 */
	readonly sendBusyLabel?: string;
}

/**
 * Floating composer pinned to the bottom of the workspace. Auto-grow textarea,
 * Enter submits, Shift+Enter newline (matches demo lines 2389–2403). The
 * `intro` flag widens it to 640px and centers vertically (handled via CSS).
 */
export function Composer({
	agents,
	currentAgentId,
	sessionId,
	hidden = false,
	intro = false,
	onSubmit,
	onSelectAgent,
	sendDisabled = false,
	sendBusyLabel = "思考中…",
}: ComposerProps) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [value, setValue] = useState("");
	const [attachments, setAttachments] = useState<readonly File[]>([]);

	const onAttachClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);
	const onFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
		const files = event.target.files;
		if (!files) return;
		setAttachments((prev) => [...prev, ...Array.from(files)]);
		event.target.value = "";
	}, []);
	const removeAttachment = useCallback((idx: number) => {
		setAttachments((prev) => prev.filter((_, i) => i !== idx));
	}, []);

	const autosize = useCallback(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		const next = Math.min(el.scrollHeight, MAX_HEIGHT_PX);
		el.style.height = `${next}px`;
	}, []);

	useEffect(() => {
		autosize();
	}, [autosize]);

	const submit = useCallback(() => {
		const text = value.trim();
		if (!text) {
			// intro state may still want to advance even on empty submit (per demo),
			// but the production flow always requires content.
			return;
		}
		onSubmit?.(text);
		setValue("");
		queueMicrotask(autosize);
	}, [value, onSubmit, autosize]);

	const onKey = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			// IME guard: when CJK input methods are composing (e.g. picking a
			// candidate from a Chinese/Japanese IME), Enter should commit the
			// composition — NOT submit the form. The composition state is
			// signaled via `nativeEvent.isComposing` or keyCode 229 (legacy).
			// IME 防误发:中日输入法选词按 Enter 应该是确认候选词,不是提交。
			const ne = event.nativeEvent as KeyboardEvent["nativeEvent"] & {
				readonly isComposing?: boolean;
			};
			if (ne.isComposing === true || event.keyCode === 229) return;
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				submit();
			}
		},
		[submit],
	);

	const onFormSubmit = useCallback(
		(event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			submit();
		},
		[submit],
	);

	return (
		<footer
			className={`q-composer${hidden ? " hidden" : ""}`}
			data-intro={intro ? "true" : "false"}
			data-testid="composer"
		>
			{!intro ? (
				<AgentSwitcher
					agents={agents}
					currentAgentId={currentAgentId}
					sessionId={sessionId}
					onSelect={onSelectAgent}
				/>
			) : null}
			{attachments.length > 0 ? (
				<div
					data-testid="composer-attachments"
					style={{
						display: "flex",
						flexWrap: "wrap",
						gap: 6,
						padding: "0 16px 8px",
					}}
				>
					{attachments.map((file, idx) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: filenames can collide on multi-attach; idx disambiguates duplicates
							key={`${file.name}-${idx}`}
							data-testid={`attachment-chip-${idx}`}
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								padding: "3px 8px",
								border: "1px solid var(--border)",
								borderRadius: 12,
								fontFamily: '"JetBrains Mono", monospace',
								fontSize: 11,
								color: "var(--fg-muted)",
								background: "var(--bg-elev)",
							}}
						>
							<span>{file.name}</span>
							<button
								type="button"
								aria-label={`移除附件 ${file.name}`}
								onClick={() => removeAttachment(idx)}
								style={{
									background: "none",
									border: "none",
									cursor: "pointer",
									padding: 0,
									color: "var(--fg-muted)",
									fontFamily: '"JetBrains Mono", monospace',
									fontSize: 11,
									lineHeight: 1,
								}}
							>
								×
							</button>
						</span>
					))}
				</div>
			) : null}
			<form className="q-composer-row" onSubmit={onFormSubmit}>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					onChange={onFileChange}
					style={{ display: "none" }}
					aria-hidden="true"
					tabIndex={-1}
					data-testid="composer-file-input"
				/>
				<button
					type="button"
					className="q-composer-attach"
					aria-label="上传附件 · attach file"
					onClick={onAttachClick}
					data-testid="composer-attach"
				>
					<span className="arrow">↑</span>
					<span>附件{attachments.length > 0 ? ` · ${attachments.length}` : ""}</span>
				</button>
				<textarea
					ref={textareaRef}
					className="q-composer-input"
					rows={1}
					placeholder={intro ? PLACEHOLDER_INTRO : PLACEHOLDER_DEFAULT}
					value={value}
					onChange={(event) => {
						setValue(event.target.value);
						autosize();
					}}
					onKeyDown={onKey}
					aria-label="对话输入框"
					data-testid="composer-input"
				/>
				<button
					type="submit"
					className="q-composer-send"
					aria-label={
						sendDisabled ? `${sendBusyLabel} · 回车入队 / press to queue` : "发送消息 · send"
					}
					data-testid="composer-send"
					data-busy={sendDisabled ? "true" : "false"}
				>
					{sendDisabled ? sendBusyLabel : "发送 · send"}
				</button>
			</form>
		</footer>
	);
}
