"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export type ProcessStatus = "running" | "waiting" | "done";

export interface ProcessProps {
	readonly title: string;
	readonly autoScrollKey?: string | number;
	readonly defaultOpen?: boolean;
	readonly status?: ProcessStatus;
	readonly children: ReactNode;
}

const SCROLL_BOTTOM_EPSILON_PX = 24;

/**
 * Collapsible process container for reasoning + tool calls + reflection.
 *
 * Auto-collapses on the running → done transition so finished turns don't
 * leave the verbose process panel expanded. The user can still re-open it
 * manually after that.
 */
export function Process({
	title,
	autoScrollKey,
	defaultOpen = true,
	status = "running",
	children,
}: ProcessProps) {
	const [open, setOpen] = useState(defaultOpen);
	const prevStatusRef = useRef<ProcessStatus>(status);
	const autoScrollEnabledRef = useRef(true);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const onBodyScroll = useCallback(() => {
		const body = bodyRef.current;
		if (body == null || status !== "running") return;
		const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
		autoScrollEnabledRef.current = distanceFromBottom <= SCROLL_BOTTOM_EPSILON_PX;
	}, [status]);
	useEffect(() => {
		if (prevStatusRef.current === "running" && status === "done") {
			setOpen(false);
		}
		if (prevStatusRef.current !== "running" && status === "running") {
			autoScrollEnabledRef.current = true;
		}
		prevStatusRef.current = status;
	}, [status]);
	useEffect(() => {
		// Keep autoScrollKey as the explicit stream-content tick for this effect.
		void autoScrollKey;
		const body = bodyRef.current;
		if (body == null || status !== "running" || !open || !autoScrollEnabledRef.current) return;
		body.scrollTop = body.scrollHeight;
	}, [status, open, autoScrollKey]);
	return (
		<section className="q-process" data-open={open ? "true" : "false"} data-status={status}>
			<button
				type="button"
				className="q-process-head"
				onClick={() => setOpen((prev) => !prev)}
				aria-expanded={open}
				aria-label={`Toggle ${title}`}
			>
				<span className="caret">▾</span>
				<span>{title}</span>
			</button>
			<div className="q-process-body" ref={bodyRef} onScroll={onBodyScroll}>
				{children}
				<div className="q-process-status">
					{status === "running" ? <strong className="q-ps-pulse">正在输出</strong> : null}
					{status === "waiting" ? <strong className="q-ps-waiting">等待授权</strong> : null}
					{status === "done" ? <strong className="q-ps-done">已完成</strong> : null}
				</div>
			</div>
		</section>
	);
}
