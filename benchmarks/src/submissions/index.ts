export {
	type BenchmarkSubmissionConfig,
	type BenchmarkSubmissionConfigProvider,
	type ResolvedBenchmarkSubmissionPaths,
	resolveBenchmarkSubmissionConfig,
	resolveBenchmarkSubmissionPaths,
} from "./config.js";
export { SubmissionAdapterRegistry } from "./registry.js";
export {
	createSweBenchVerifiedJsonlAdapter,
	sweBenchVerifiedJsonlAdapter,
} from "./swe-bench-verified-jsonl.js";
export {
	type SubmissionAdapter,
	SubmissionAdapterError,
	SubmissionAdapterRegistryError,
	type SubmissionFormat,
} from "./types.js";

import { SubmissionAdapterRegistry } from "./registry.js";
import { sweBenchVerifiedJsonlAdapter } from "./swe-bench-verified-jsonl.js";

export const defaultSubmissionAdapterRegistry = new SubmissionAdapterRegistry([
	sweBenchVerifiedJsonlAdapter,
]);
