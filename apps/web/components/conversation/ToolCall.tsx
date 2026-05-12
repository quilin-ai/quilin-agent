"use client";

import { type ReactNode, useState } from "react";

export type ToolCallKind = "tool" | "mcp" | "subagent" | "memory";
export type ToolCallStatus = "done" | "pending" | "error";

export interface ToolCallProps {
	readonly name: string;
	readonly kind?: ToolCallKind;
	readonly status?: ToolCallStatus;
	readonly statusLabel?: string;
	readonly defaultOpen?: boolean;
	readonly blocked?: boolean;
	readonly children?: ReactNode;
}

function kwLabel(kind: ToolCallKind): string {
	switch (kind) {
		case "mcp":
			return "MCP";
		case "subagent":
			return "子代理";
		case "memory":
			return "记忆";
		default:
			return "调用";
	}
}

function defaultStatusLabel(status: ToolCallStatus): string {
	switch (status) {
		case "done":
			return "▢ done";
		case "pending":
			return "▪ running";
		case "error":
			return "✕ error";
	}
}

/**
 * Collapsible tool call row — keyword chip + tool name + status + body slot
 * (per demo lines 1275–1293). Border color follows `kind` (see globals.css
 * `.q-tool-call[data-kind="..."]` rules).
 */
export function ToolCall({
	name,
	kind = "tool",
	status = "pending",
	statusLabel,
	defaultOpen = false,
	blocked = false,
	children,
}: ToolCallProps) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<section
			className={`q-tool-call${blocked ? " blocked" : ""}`}
			data-kind={kind}
			data-open={open ? "true" : "false"}
		>
			<button
				type="button"
				className="q-tool-call-head"
				onClick={() => setOpen((prev) => !prev)}
				aria-expanded={open}
			>
				<span className="caret">▾</span>
				<span className="kw">{kwLabel(kind)}</span>
				<span className="name">{name}</span>
				<span className={`status ${status}`}>{statusLabel ?? defaultStatusLabel(status)}</span>
			</button>
			<div className="q-tool-call-body">{children}</div>
		</section>
	);
}
