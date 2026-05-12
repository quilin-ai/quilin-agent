"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
	readonly pinned?: boolean;
}

/**
 * Left strip rail. Collapsed it shows vertical CJK glyphs; on hover or
 * `pinned`, expands to show the bilingual name + italic description (per
 * demo lines 126–211).
 */
export function RailStrip({ items = DEFAULT_RAIL_ITEMS, pinned = false }: RailStripProps) {
	const pathname = usePathname();
	return (
		<aside
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
