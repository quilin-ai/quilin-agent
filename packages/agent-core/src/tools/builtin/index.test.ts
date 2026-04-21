import { describe, expect, it } from "vitest";
import { WriteAuthority } from "../../safety/write-authority.js";
import { SkillsManager } from "../../skills/manager.js";
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

	it("adds skill_view when a skills manager is available", () => {
		const tools = createBuiltinTools({
			skillsManager: new SkillsManager({}),
		});

		expect(tools.map((tool) => tool.name)).toContain("skill_view");
	});

	it("adds skill_manage when both skillsManager and writeAuthority are available", () => {
		const tools = createBuiltinTools({
			skillsManager: new SkillsManager({}),
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
		});

		expect(tools.map((tool) => tool.name)).toContain("skill_manage");
	});
});
