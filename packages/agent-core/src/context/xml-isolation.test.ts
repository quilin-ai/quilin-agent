import { describe, expect, it } from "vitest";
import { escapeXmlAttribute, escapeXmlText } from "./xml-isolation.js";

describe("xml isolation helpers", () => {
	it("escapes XML text nodes without changing ordinary text", () => {
		expect(escapeXmlText("alpha & <beta>")).toBe("alpha &amp; &lt;beta&gt;");
		expect(escapeXmlText("plain text")).toBe("plain text");
	});

	it("escapes XML attribute delimiters and text-sensitive characters", () => {
		expect(escapeXmlAttribute(`"alpha" & 'beta' <tag>`)).toBe(
			"&quot;alpha&quot; &amp; &apos;beta&apos; &lt;tag&gt;",
		);
	});
});
