import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: ["src/test/**"],
			thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
		},
		reporters: process.env.QUILIN_ENV === "test" ? ["json"] : ["default"],
	},
});
