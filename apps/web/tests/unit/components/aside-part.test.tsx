import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AsidePart } from "@/components/chat/AsidePart";

describe("AsidePart — Iter F 交互 primitives", () => {
	it("renders streamdown markdown content", () => {
		render(<AsidePart data={{ text: "**正在权衡** 两个方案" }} />);
		const el = screen.getByTestId("aside-part");
		expect(el).toBeInTheDocument();
		// Streamdown renders the text contents (markdown bold may parse
		// async in jsdom — we just assert the wrapper has the text).
		expect(el.textContent).toContain("正在权衡");
		expect(el.textContent).toContain("两个方案");
	});

	it("defaults weight=low when missing", () => {
		render(<AsidePart data={{ text: "x" }} />);
		expect(screen.getByTestId("aside-part").getAttribute("data-weight")).toBe("low");
	});

	it("respects explicit weight=normal", () => {
		render(<AsidePart data={{ text: "x", weight: "normal" }} />);
		expect(screen.getByTestId("aside-part").getAttribute("data-weight")).toBe("normal");
	});
});
