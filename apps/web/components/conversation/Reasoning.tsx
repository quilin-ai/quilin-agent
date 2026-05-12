"use client";

import { type ReactNode, useState } from "react";

export interface ReasoningProps {
	readonly title: string;
	readonly defaultOpen?: boolean;
	readonly children: ReactNode;
}

/**
 * Italic "思考 · reasoning" or "规划 · planning" block. Collapsed by default
 * because reasoning traces are dense and noisy (per demo lines 1252–1272).
 */
export function Reasoning({ title, defaultOpen = false, children }: ReasoningProps) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<section className="q-reasoning" data-open={open ? "true" : "false"}>
			<button
				type="button"
				className="q-reasoning-head"
				onClick={() => setOpen((prev) => !prev)}
				aria-expanded={open}
			>
				<span className="caret">▾</span>
				<span>{title}</span>
			</button>
			<div className="q-reasoning-body">{children}</div>
		</section>
	);
}
