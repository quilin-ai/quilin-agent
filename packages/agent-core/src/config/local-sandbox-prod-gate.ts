// LocalSandbox production-mode refusal gate (QUI-148).
//
// LocalSandbox 仅在开发场景作为 unsafe opt-in 使用。生产模式下若发现
// `runtime.sandbox.default = "local-dev"` 必须立即抛出可执行的启动错误，
// 防止运维误把 dev 配置带进生产环境。
//
// LocalSandbox is a dev-only unsafe opt-in. When the runtime is in
// production mode, configuring it as the default sandbox provider must
// fail loud at startup with an actionable error so that an operator
// cannot silently ship a dev-only sandbox to production.
//
// Production detection (either condition is sufficient):
// - `process.env.NODE_ENV === "production"`
// - `process.env.QUILIN_PROD === "1"`
//
// 适用条件（任一成立即视为生产模式）：上述两条之一。

import type { UserConfig } from "./user-config-schema.js";

/**
 * Production-mode sandbox refusal error. Constructor message ends with a
 * pointer to the deployment runtime spec so operators can find the
 * remediation steps.
 *
 * 生产模式 sandbox 拒绝错误。错误消息末尾附带部署运行时文档锚点，方便
 * 运维定位修复步骤。
 */
export class LocalSandboxProdRefusalError extends Error {
	readonly code = "LOCAL_SANDBOX_PROD_REFUSAL" as const;

	constructor(detail?: string) {
		super(
			[
				"LocalSandbox is dev-only and refused in production mode.",
				"Configure DockerSandbox or remove sandbox.default override.",
				"See docs/09-deployment-runtime/README.md § sandbox.",
				detail == null ? null : `(${detail})`,
			]
				.filter((part): part is string => part != null)
				.join(" "),
		);
		this.name = "LocalSandboxProdRefusalError";
	}
}

export interface LocalSandboxProdGateOptions {
	/**
	 * Override the environment lookup. Mainly used by tests to avoid
	 * mutating `process.env` for parallel test isolation.
	 *
	 * 用于测试覆写的环境查找入口，避免并行测试争用 `process.env`。
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Returns true if the runtime is in production mode. Either
 * `NODE_ENV=production` or `QUILIN_PROD=1` flips this on.
 *
 * 当 `NODE_ENV=production` 或 `QUILIN_PROD=1` 任一条件成立时判定为生产
 * 模式，返回 true。
 */
export function isProductionRuntimeMode(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return env.NODE_ENV === "production" || env.QUILIN_PROD === "1";
}

/**
 * Throws `LocalSandboxProdRefusalError` if the user config selects
 * `local-dev` as the default sandbox while running in production mode.
 * No-op otherwise — both dev mode and prod-mode-with-DockerSandbox are
 * accepted silently.
 *
 * 当用户配置把 `local-dev` 设为默认 sandbox 且运行于生产模式时抛出
 * `LocalSandboxProdRefusalError`。其余情况（dev 模式或生产模式 + Docker）
 * 静默放行。
 */
export function assertLocalSandboxNotInProd(
	config: UserConfig,
	options: LocalSandboxProdGateOptions = {},
): void {
	const env = options.env ?? process.env;
	if (!isProductionRuntimeMode(env)) {
		return;
	}
	const sandboxDefault = config.runtime.sandbox.default;
	if (sandboxDefault !== "local-dev") {
		return;
	}
	const detailParts: string[] = [];
	if (env.NODE_ENV === "production") {
		detailParts.push("NODE_ENV=production");
	}
	if (env.QUILIN_PROD === "1") {
		detailParts.push("QUILIN_PROD=1");
	}
	throw new LocalSandboxProdRefusalError(detailParts.join(", ") || undefined);
}
