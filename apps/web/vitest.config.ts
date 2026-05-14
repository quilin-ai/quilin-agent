import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	esbuild: {
		jsx: "automatic",
		jsxImportSource: "react",
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "."),
			"@quilin/agent-core/control-plane/v2/schemas": resolve(__dirname, "./lib/schemas.ts"),
		},
	},
	test: {
		globals: true,
		environment: "jsdom",
		setupFiles: ["./tests/setup.ts"],
		include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.spec.{ts,tsx}"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["lib/**/*.ts", "components/**/*.{ts,tsx}"],
			exclude: [
				"**/*.d.ts",
				"**/*.test.{ts,tsx}",
				"tests/**",
				"app/**",
				".next/**",
				"node_modules/**",
			],
			thresholds: {
				lines: 95,
				branches: 95,
				functions: 95,
				statements: 95,
			},
		},
		reporters: process.env.QUILIN_ENV === "test" ? ["json"] : ["default"],
	},
});
