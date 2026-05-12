"use client";

import {
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
	readonly hidden?: boolean;
	readonly intro?: boolean;
	readonly onSubmit?: (text: string) => void;
	readonly onSelectAgent?: (agentId: string) => void;
}

/**
 * Floating composer pinned to the bottom of the workspace. Auto-grow textarea,
 * Enter submits, Shift+Enter newline (matches demo lines 2389–2403). The
 * `intro` flag widens it to 640px and centers vertically (handled via CSS).
 */
export function Composer({
	agents,
	currentAgentId,
	hidden = false,
	intro = false,
	onSubmit,
	onSelectAgent,
}: ComposerProps) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const [value, setValue] = useState("");

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
				<AgentSwitcher agents={agents} currentAgentId={currentAgentId} onSelect={onSelectAgent} />
			) : null}
			<form className="q-composer-row" onSubmit={onFormSubmit}>
				<button type="button" className="q-composer-attach" aria-label="上传附件 · attach file">
					<span className="arrow">↑</span>
					<span>附件</span>
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
					aria-label="发送消息 · send"
					data-testid="composer-send"
				>
					发送 · send
				</button>
			</form>
		</footer>
	);
}
