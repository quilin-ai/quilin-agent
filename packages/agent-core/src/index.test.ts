import { getDefaultModel } from "./llm/provider.js";

describe("agent-core skeleton", () => {
	it("uses DeepSeek as the default model", () => {
		expect(getDefaultModel()).toBe("deepseek-chat");
	});
});
