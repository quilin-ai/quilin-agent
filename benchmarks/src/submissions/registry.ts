import type { BenchmarkTask } from "../wire/task.js";
import type { SubmissionAdapter } from "./types.js";
import { SubmissionAdapterRegistryError } from "./types.js";

export class SubmissionAdapterRegistry {
	private readonly adapters = new Map<string, SubmissionAdapter>();

	constructor(adapters: readonly SubmissionAdapter[] = []) {
		for (const adapter of adapters) {
			this.register(adapter);
		}
	}

	register<T extends BenchmarkTask>(adapter: SubmissionAdapter<T>): void {
		if (this.adapters.has(adapter.dataset)) {
			throw new SubmissionAdapterRegistryError(
				`Submission adapter already registered for dataset: ${adapter.dataset}`,
			);
		}

		this.adapters.set(adapter.dataset, adapter);
	}

	get(dataset: BenchmarkTask["dataset"]): SubmissionAdapter {
		const adapter = this.adapters.get(dataset);

		if (!adapter) {
			throw new SubmissionAdapterRegistryError(
				`No submission adapter registered for dataset: ${dataset}`,
			);
		}

		return adapter;
	}
}
