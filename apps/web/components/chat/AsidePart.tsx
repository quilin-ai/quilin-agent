"use client";

import { Streamdown } from "streamdown";

/**
 * `<AsidePart>` — Iter F 交互 primitives `aside` channel inline 组件.
 *
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §5.3.
 *
 * 弱视觉权重的旁白("我正在权衡两个方案" 这类元层叙述)。Streamdown
 * 渲染 markdown,左侧细竖线,斜体,淡色,与主回答区分。
 *
 * Low-visual-weight aside narration (meta-layer commentary like "我正在
 * 权衡两个方案"). Streamdown renders markdown; left-rule + italic + muted
 * tone separates it from the main assistant text.
 */

export interface AsidePartData {
	readonly text: string;
	readonly weight?: "low" | "normal";
}

interface AsidePartProps {
	readonly data: AsidePartData;
}

export function AsidePart({ data }: AsidePartProps) {
	const weight = data.weight ?? "low";
	return (
		<div
			className="q-aside-part"
			data-testid="aside-part"
			data-weight={weight}
			style={{
				borderLeft: "2px solid var(--fg-subtle)",
				paddingLeft: 12,
				marginTop: 8,
				marginBottom: 8,
				color: weight === "low" ? "var(--fg-muted)" : "var(--fg)",
				fontStyle: "italic",
				fontFamily: '"Cormorant Garamond", "Noto Serif SC", serif',
				fontSize: 13,
				lineHeight: 1.5,
			}}
		>
			<Streamdown>{data.text}</Streamdown>
		</div>
	);
}
