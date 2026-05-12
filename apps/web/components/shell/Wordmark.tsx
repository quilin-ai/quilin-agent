import Link from "next/link";

export interface WordmarkProps {
	readonly href?: string;
	readonly variant?: "fixed" | "intro";
}

/**
 * Quilin · 麒麟 wordmark — fixed top-left under header in normal flow,
 * centered + scaled 1.6 in intro variant (per demo line 940).
 */
export function Wordmark({ href = "/", variant = "fixed" }: WordmarkProps) {
	const className = variant === "intro" ? "q-wordmark-wrap q-wordmark-intro" : "q-wordmark-wrap";
	return (
		<Link href={href} className={className} aria-label="回到对话 · Quilin Home">
			<div className="q-wordmark">
				Quilin <span className="cjk">麒麟</span>
			</div>
			<div className="q-wordmark-sub">
				<span>quilt · 拼布</span>
				<span className="plus">+</span>
				<span>qilin · 麒麟</span>
			</div>
		</Link>
	);
}
