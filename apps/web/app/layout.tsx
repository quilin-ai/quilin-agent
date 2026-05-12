import type { Metadata } from "next";
import { Cormorant_Garamond, JetBrains_Mono, Noto_Sans_SC, Noto_Serif_SC } from "next/font/google";

import "./globals.css";

const cormorant = Cormorant_Garamond({
	subsets: ["latin"],
	weight: ["400", "500", "600"],
	style: ["normal", "italic"],
	display: "swap",
	variable: "--font-cormorant",
});

const notoSerifSc = Noto_Serif_SC({
	subsets: ["latin"],
	weight: ["300", "400", "500", "600"],
	display: "swap",
	variable: "--font-noto-serif-sc",
});

const notoSansSc = Noto_Sans_SC({
	subsets: ["latin"],
	weight: ["300", "400", "500", "600"],
	display: "swap",
	variable: "--font-noto-sans-sc",
});

const jetbrainsMono = JetBrains_Mono({
	subsets: ["latin"],
	weight: ["400", "500"],
	display: "swap",
	variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
	title: "Quilin · 麒麟",
	description: "Quilin Agent — quilt 拼布 + qilin 麒麟. Self-evolving Agent framework runtime UI.",
	robots: { index: false, follow: false },
	icons: { icon: "/favicon.ico" },
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
	return (
		<html
			lang="zh-Hans"
			data-theme="light"
			className={`${cormorant.variable} ${notoSerifSc.variable} ${notoSansSc.variable} ${jetbrainsMono.variable}`}
			suppressHydrationWarning
		>
			<body>{children}</body>
		</html>
	);
}
