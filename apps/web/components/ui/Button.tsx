import { type ButtonHTMLAttributes, forwardRef } from "react";

export type ButtonVariant = "primary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	readonly variant?: ButtonVariant;
}

const baseStyle: React.CSSProperties = {
	background: "none",
	cursor: "pointer",
	padding: "5px 10px",
	fontFamily: '"Noto Sans SC", sans-serif',
	fontSize: 11,
	letterSpacing: "0.02em",
	transition: "background 120ms, color 120ms, border-color 120ms",
};

const variantStyle: Record<ButtonVariant, React.CSSProperties> = {
	primary: {
		border: "1px solid var(--accent-vermillion)",
		color: "var(--accent-vermillion)",
	},
	ghost: {
		border: "1px solid var(--border)",
		color: "var(--fg)",
	},
	danger: {
		border: "1px solid var(--destructive)",
		color: "var(--destructive)",
	},
};

/**
 * Minimal Quilin-styled button. Intentionally lightweight — Phase 1a doesn't
 * yet need the full shadcn/ui surface. When AI Elements / shadcn copies are
 * imported in Phase 1b, drop this in favor of the canonical primitive.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ variant = "primary", style, type = "button", ...rest },
	ref,
) {
	return (
		<button
			ref={ref}
			type={type}
			style={{ ...baseStyle, ...variantStyle[variant], ...style }}
			{...rest}
		/>
	);
});
