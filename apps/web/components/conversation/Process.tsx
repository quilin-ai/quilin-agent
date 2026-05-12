"use client";

import { type ReactNode, useState } from "react";

export type ProcessStatus = "running" | "waiting" | "done";

export interface ProcessProps {
	readonly title: string;
	readonly defaultOpen?: boolean;
	readonly status?: ProcessStatus;
	readonly children: ReactNode;
}

/**
 * Top-level "过程 · process" container — wraps reasoning + tool calls +
 * reflection. Status chip changes color + glyph based on `status` (per
 * demo lines 580–603).
 */
export function Process({ title, defaultOpen = true, status = "running", children }: ProcessProps) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<section className="q-process" data-open={open ? "true" : "false"}>
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
			<div className="q-process-body">
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
