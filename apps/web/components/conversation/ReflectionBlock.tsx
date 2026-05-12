"use client";

import { type ReactNode, useState } from "react";

export interface ReflectionBlockProps {
	readonly defaultOpen?: boolean;
	readonly children: ReactNode;
}

/**
 * Italic "旁白 · reflection" block — bottom of each assistant turn. Dashed
 * left border distinguishes it from regular reasoning (per demo lines 771–792).
 */
export function ReflectionBlock({ defaultOpen = true, children }: ReflectionBlockProps) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<section className="q-reflection-block" data-open={open ? "true" : "false"}>
			<button
				type="button"
				className="q-reflection-head"
				onClick={() => setOpen((prev) => !prev)}
				aria-expanded={open}
			>
				<span className="caret">▾</span>
				<span>旁白 · reflection</span>
			</button>
			<div className="q-reflection-body">{children}</div>
		</section>
	);
}
