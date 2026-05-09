import { describe, expect, it } from "vitest";
import {
	assertLocalSandboxNotInProd,
	isProductionRuntimeMode,
	LocalSandboxProdRefusalError,
} from "./local-sandbox-prod-gate.js";
import { userConfigSchema } from "./user-config-schema.js";

function makeConfig(sandboxDefault: "docker" | "local-dev") {
	return userConfigSchema.parse({
		runtime: { sandbox: { default: sandboxDefault } },
	});
}

describe("LocalSandboxProdRefusalError messaging", () => {
	it("omits the parenthesised detail when constructor is called without args", () => {
		const error = new LocalSandboxProdRefusalError();
		expect(error.code).toBe("LOCAL_SANDBOX_PROD_REFUSAL");
		expect(error.message).toContain("LocalSandbox is dev-only");
		expect(error.message).not.toContain("(");
	});

	it("includes parenthesised detail when supplied", () => {
		const error = new LocalSandboxProdRefusalError("CI=1");
		expect(error.message).toContain("(CI=1)");
	});
});

describe("LocalSandbox production-mode gate", () => {
	it("treats NODE_ENV=production as production mode", () => {
		expect(isProductionRuntimeMode({ NODE_ENV: "production" })).toBe(true);
	});

	it("treats QUILIN_PROD=1 as production mode", () => {
		expect(isProductionRuntimeMode({ QUILIN_PROD: "1" })).toBe(true);
	});

	it("treats other envs as dev mode", () => {
		expect(isProductionRuntimeMode({ NODE_ENV: "development" })).toBe(false);
		expect(isProductionRuntimeMode({})).toBe(false);
		expect(isProductionRuntimeMode({ NODE_ENV: "test" })).toBe(false);
	});

	it("throws when NODE_ENV=production and sandbox.default=local-dev", () => {
		const config = makeConfig("local-dev");
		expect(() =>
			assertLocalSandboxNotInProd(config, { env: { NODE_ENV: "production" } }),
		).toThrow(LocalSandboxProdRefusalError);
		try {
			assertLocalSandboxNotInProd(config, {
				env: { NODE_ENV: "production" },
			});
			throw new Error("expected refusal");
		} catch (err) {
			expect(err).toBeInstanceOf(LocalSandboxProdRefusalError);
			if (err instanceof LocalSandboxProdRefusalError) {
				expect(err.code).toBe("LOCAL_SANDBOX_PROD_REFUSAL");
				expect(err.message).toContain("LocalSandbox is dev-only");
				expect(err.message).toContain("DockerSandbox");
				expect(err.message).toContain("docs/09-deployment-runtime/README.md");
				expect(err.message).toContain("NODE_ENV=production");
			}
		}
	});

	it("throws when QUILIN_PROD=1 and sandbox.default=local-dev", () => {
		const config = makeConfig("local-dev");
		expect(() =>
			assertLocalSandboxNotInProd(config, { env: { QUILIN_PROD: "1" } }),
		).toThrow(LocalSandboxProdRefusalError);
	});

	it("includes both detail markers when NODE_ENV and QUILIN_PROD both fire", () => {
		const config = makeConfig("local-dev");
		try {
			assertLocalSandboxNotInProd(config, {
				env: { NODE_ENV: "production", QUILIN_PROD: "1" },
			});
			throw new Error("expected refusal");
		} catch (err) {
			expect(err).toBeInstanceOf(LocalSandboxProdRefusalError);
			if (err instanceof LocalSandboxProdRefusalError) {
				expect(err.message).toContain("NODE_ENV=production");
				expect(err.message).toContain("QUILIN_PROD=1");
			}
		}
	});

	it("permits local-dev sandbox when running in dev mode", () => {
		const config = makeConfig("local-dev");
		expect(() =>
			assertLocalSandboxNotInProd(config, {
				env: { NODE_ENV: "development" },
			}),
		).not.toThrow();
	});

	it("permits docker sandbox even in production mode", () => {
		const config = makeConfig("docker");
		expect(() =>
			assertLocalSandboxNotInProd(config, { env: { NODE_ENV: "production" } }),
		).not.toThrow();
		expect(() =>
			assertLocalSandboxNotInProd(config, { env: { QUILIN_PROD: "1" } }),
		).not.toThrow();
	});

	it("falls back to process.env when env override is omitted", () => {
		const config = makeConfig("local-dev");
		// process.env.NODE_ENV is "test" under vitest, and QUILIN_PROD is
		// unset in CI — neither branch of isProductionRuntimeMode fires.
		// vitest 默认 NODE_ENV=test，CI 也不会设 QUILIN_PROD，故两条生产
		// 模式分支都不命中，这里不应该抛错。
		const isCurrentlyProd =
			process.env.NODE_ENV === "production" || process.env.QUILIN_PROD === "1";
		if (isCurrentlyProd) {
			expect(() => assertLocalSandboxNotInProd(config)).toThrow(
				LocalSandboxProdRefusalError,
			);
		} else {
			expect(() => assertLocalSandboxNotInProd(config)).not.toThrow();
		}
	});
});
