import { describe, expect, it } from "vitest";
import { createBuiltinTools } from "./index.js";

describe("builtin tool index", () => {
	it("returns the default builtin tool set", () => {
		const tools = createBuiltinTools();

		expect(tools.map((tool) => tool.name)).toEqual([
			"file_read",
			"file_write",
			"file_list",
			"shell_exec",
			"web_fetch",
		]);
		expect(tools.map((tool) => tool.category)).toEqual([
			"programmatic",
			"programmatic",
			"programmatic",
			"programmatic",
			"programmatic",
		]);
	});
});
