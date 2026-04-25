// Runtime accessors that bridge ADR-009 user config to ADR-008
// observability primitives. Module-level singletons populated by
// bootstrapUserRuntime(); pure accessors throw if accessed before boot.

import { StructuredLogger } from "../observability/log.js";
import { OTelSpanProvider } from "../observability/span.js";
import {
	loadUserConfig,
	type UserConfigLoadOptions,
	type UserConfigLoadResult,
} from "./user-config.js";

interface UserRuntime {
	readonly result: UserConfigLoadResult;
	readonly spanProvider: OTelSpanProvider;
	readonly structuredLogger: StructuredLogger;
}

let runtime: UserRuntime | null = null;

export class UserRuntimeNotBootedError extends Error {
	constructor() {
		super(
			"user runtime not booted; call bootstrapUserRuntime() before accessor",
		);
		this.name = "UserRuntimeNotBootedError";
	}
}

export interface BootstrapOptions extends UserConfigLoadOptions {
	readonly spanProvider?: OTelSpanProvider;
	readonly structuredLogger?: StructuredLogger;
}

export async function bootstrapUserRuntime(
	options: BootstrapOptions = {},
): Promise<UserRuntime> {
	const { spanProvider, structuredLogger, ...loadOptions } = options;
	const result = await loadUserConfig(loadOptions);
	runtime = {
		result,
		spanProvider: spanProvider ?? new OTelSpanProvider(),
		structuredLogger:
			structuredLogger ??
			new StructuredLogger({ level: result.config.observability.log_level }),
	};
	return runtime;
}

export function resetUserRuntime(): void {
	runtime = null;
}

export function getUserRuntime(): UserRuntime {
	if (runtime == null) {
		throw new UserRuntimeNotBootedError();
	}
	return runtime;
}

export function getUserConfig(): UserConfigLoadResult["config"] {
	return getUserRuntime().result.config;
}

export function getUserConfigSources(): UserConfigLoadResult["sources"] {
	return getUserRuntime().result.sources;
}

export function getDefaultSpanProvider(): OTelSpanProvider {
	return getUserRuntime().spanProvider;
}

export function getDefaultStructuredLogger(): StructuredLogger {
	return getUserRuntime().structuredLogger;
}
