// SIGHUP signal handler factory (QUI-148).
//
// 注册 `process.on("SIGHUP", handler)`，在收到 SIGHUP 时调用
// `controller.reload("signal")`。失败仅记录 error 级日志，绝不让父进程崩溃。
// Vitest 等测试环境必须跳过注册（`NODE_ENV === "test"` 或存在 `VITEST` env），
// 避免污染测试运行器的信号处理。
//
// Wires `process.on("SIGHUP", handler)` so SIGHUP triggers a capabilities
// reload via `controller.reload("signal")`. Failures are logged at error
// level and never crash the parent. Tests skip registration when
// `NODE_ENV === "test"` or `VITEST` env is set so the test runner's own
// signal handling is not polluted.

import type {
	CapabilitiesHotReloadController,
	CapabilitiesReloadResult,
} from "./hot-reload.js";

export type ProcessLike = NodeJS.EventEmitter & {
	readonly env: NodeJS.ProcessEnv;
};

export interface SighupHandlerOptions {
	/**
	 * Override the env lookup. Tests may pass a frozen env to make
	 * registration deterministic.
	 *
	 * 测试可注入冻结 env 以保证注册结果可预测。
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Inject a custom process emitter. Defaults to the global `process`.
	 *
	 * 可注入自定义 process 事件源，默认使用全局 `process`。
	 */
	readonly processRef?: ProcessLike;
	/**
	 * Optional info-level logger called when registration succeeds.
	 *
	 * 注册成功时回调（可选 info 日志钩子）。
	 */
	readonly onRegister?: () => void;
	/**
	 * Optional logger invoked after each reload attempt with the result.
	 *
	 * 每次 reload 完成后回调，可用于日志或测试断言。
	 */
	readonly onReload?: (result: CapabilitiesReloadResult) => void;
	/**
	 * Optional error-level logger for reload failures or thrown errors.
	 *
	 * 当 reload 抛错或返回 failure 时的错误日志钩子。
	 */
	readonly onError?: (error: unknown) => void;
	/**
	 * Force registration regardless of test-env detection. Mainly for
	 * exercising the wiring inside Vitest.
	 *
	 * 强制注册，绕过测试环境检测。仅用于在 Vitest 中验证接线。
	 */
	readonly forceRegister?: boolean;
}

export interface SighupHandlerHandle {
	readonly registered: boolean;
	readonly reason: "registered" | "test_environment" | "forced";
	dispose(): void;
}

/**
 * Returns true when the runtime should suppress SIGHUP registration.
 * Vitest sets the `VITEST` env var; CI / unit tests typically set
 * `NODE_ENV=test`.
 *
 * 当 `NODE_ENV=test` 或 `VITEST` env 存在时返回 true，应跳过 SIGHUP 注册。
 */
export function isTestEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return env.NODE_ENV === "test" || env.VITEST != null;
}

/**
 * Installs a SIGHUP handler that triggers `controller.reload("signal")`.
 * Returns a handle whose `dispose()` removes the listener; useful for
 * graceful shutdown and for keeping tests deterministic.
 *
 * 安装 SIGHUP handler，触发 `controller.reload("signal")`。返回 handle，
 * `dispose()` 可移除监听器，便于优雅退出与测试可重入。
 */
export function installSighupHandler(
	controller: CapabilitiesHotReloadController,
	options: SighupHandlerOptions = {},
): SighupHandlerHandle {
	const env = options.env ?? process.env;
	const processRef = options.processRef ?? (process as unknown as ProcessLike);
	const skip = options.forceRegister !== true && isTestEnvironment(env);
	if (skip) {
		return {
			registered: false,
			reason: "test_environment",
			dispose: () => {
				/* noop — never registered */
			},
		};
	}

	const listener = () => {
		void runReload(controller, options);
	};

	processRef.on("SIGHUP", listener);
	options.onRegister?.();

	return {
		registered: true,
		reason: options.forceRegister === true ? "forced" : "registered",
		dispose: () => {
			processRef.off("SIGHUP", listener);
		},
	};
}

async function runReload(
	controller: CapabilitiesHotReloadController,
	options: SighupHandlerOptions,
): Promise<void> {
	try {
		const result = await controller.reload("signal");
		options.onReload?.(result);
		if (result.status === "failure") {
			options.onError?.(
				new Error(
					`SIGHUP reload returned failure: ${result.snapshot.errorName}: ${result.snapshot.errorMessage}`,
				),
			);
		}
	} catch (error) {
		options.onError?.(error);
	}
}
