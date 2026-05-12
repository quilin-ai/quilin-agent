"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { useRailPin } from "@/lib/use-rail-pin";

export interface RailStripItem {
	readonly target: string;
	readonly glyph: string;
	readonly nameCjk: string;
	readonly nameEn: string;
	readonly desc: string;
	readonly count: number | string;
	readonly href: string;
}

export const DEFAULT_RAIL_ITEMS: readonly RailStripItem[] = [
	{
		target: "sessions",
		glyph: "会话",
		nameCjk: "会话",
		nameEn: "Sessions",
		desc: "所有历史对话记录",
		count: "—",
		href: "/sessions",
	},
	{
		target: "memory",
		glyph: "记忆",
		nameCjk: "记忆",
		nameEn: "Memory",
		desc: "四层记忆",
		count: "—",
		href: "/memory",
	},
	{
		target: "skills",
		glyph: "技能",
		nameCjk: "技能",
		nameEn: "Skills",
		desc: "已注册技能",
		count: "—",
		href: "/skills",
	},
	{
		target: "mcp",
		glyph: "服务",
		nameCjk: "服务",
		nameEn: "MCP",
		desc: "stdio / http 服务器",
		count: "—",
		href: "/mcp",
	},
	{
		target: "tools",
		glyph: "工具",
		nameCjk: "工具",
		nameEn: "Tools",
		desc: "内置工具集",
		count: "—",
		href: "/tools",
	},
	{
		target: "config",
		glyph: "配置",
		nameCjk: "配置",
		nameEn: "Config",
		desc: "trust · budget · model",
		count: "—",
		href: "/config",
	},
];

export interface RailStripProps {
	readonly items?: readonly RailStripItem[];
	/**
	 * Optional override of the shared `useRailPin` state. When omitted, the
	 * rail follows the global pin signal: any rail-item click pins it; any
	 * pointerdown outside the rail unpins it. Pass `true` to force-pin
	 * regardless of clicks (legacy callers).
	 */
	readonly pinned?: boolean;
}

/**
 * Left navigation rail. CSS `:hover` expands transiently; the pinned signal
 * (from `useRailPin`) keeps it expanded across navigation.
 *
 * Pin lifecycle:
 *   1. User clicks a rail item Link → `setPinned(true)` fires BEFORE Next.js
 *      navigation, so the next page mount reads `pinned=true` from session
 *      storage and renders expanded immediately.
 *   2. While pinned, a `pointerdown` listener on `document` unpins as soon as
 *      the user clicks anywhere outside the rail aside.
 *   3. After unpin, hover still works (CSS-driven), so the user can peek the
 *      rail without committing to a pin.
 *
 * 钉住状态由共享 hook 管理,跨页面持续。点 rail 任意 item → 钉住;点 rail
 * 以外 → 自动收起。
 */
export function RailStrip({ items = DEFAULT_RAIL_ITEMS, pinned: pinnedOverride }: RailStripProps) {
	const pathname = usePathname();
	const [pinnedFromHook, setPinned] = useRailPin();
	const pinned = pinnedOverride ?? pinnedFromHook;
	const railRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!pinned) return;
		if (pinnedOverride === true) return; // legacy force-pin: skip outside-click
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target as Element | null;
			if (target == null) return;
			const rail = railRef.current;
			if (rail != null && !rail.contains(target)) {
				setPinned(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [pinned, pinnedOverride, setPinned]);

	return (
		<aside
			ref={railRef}
			className="q-rail-strip"
			data-pinned={pinned ? "true" : "false"}
			aria-label="Quilin navigation rail"
		>
			{items.map((item) => {
				const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
				return (
					<Link
						key={item.target}
						href={item.href}
						className={`q-strip-item${active ? " active" : ""}`}
						data-target={item.target}
						data-testid={`rail-${item.target}`}
						onClick={() => setPinned(true)}
					>
						<span className="glyph">{item.glyph}</span>
						<span className="name-full">
							{item.nameCjk} · {item.nameEn}
							<span className="desc">{item.desc}</span>
						</span>
						<span className="count">{item.count}</span>
					</Link>
				);
			})}
		</aside>
	);
}
