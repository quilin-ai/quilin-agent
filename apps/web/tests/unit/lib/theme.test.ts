import { describe, expect, it } from "vitest";

import { DEFAULT_THEME, fontStack, layout, motion } from "@/lib/theme";

describe("theme tokens", () => {
	it("exposes motion durations", () => {
		expect(motion.durations.fast).toBe(120);
		expect(motion.durations.slowest).toBe(720);
	});

	it("exposes motion easings", () => {
		expect(motion.easings.standard).toContain("cubic-bezier");
	});

	it("exposes layout pixel constants matching CSS vars", () => {
		expect(layout.columnWidthPx).toBe(720);
		expect(layout.railStripPx).toBe(56);
		expect(layout.railStripOpenPx).toBe(280);
		expect(layout.headHeightPx).toBe(76);
	});

	it("exposes font stack tokens", () => {
		expect(fontStack.serifEn).toContain("Cormorant Garamond");
		expect(fontStack.serifCjk).toContain("Noto Serif SC");
		expect(fontStack.sansCjk).toContain("Noto Sans SC");
		expect(fontStack.mono).toContain("JetBrains Mono");
	});

	it("default theme is light", () => {
		expect(DEFAULT_THEME).toBe("light");
	});
});
