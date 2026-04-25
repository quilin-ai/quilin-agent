import type { SpanSnapshot } from "../span.js";

export interface SpanExporter {
	readonly exportSpan?: (span: SpanSnapshot) => Promise<void> | void;
	readonly exportSpans?: (
		spans: readonly SpanSnapshot[],
	) => Promise<void> | void;
}

export interface ExportFailure {
	readonly exporterIndex: number;
	readonly error: unknown;
}

export class CompositeSpanExporter {
	readonly exporters: readonly SpanExporter[];
	private failures: readonly ExportFailure[] = [];

	constructor(exporters: readonly SpanExporter[]) {
		this.exporters = [...exporters];
	}

	get lastFailures(): readonly ExportFailure[] {
		return this.failures;
	}

	async exportSpan(span: SpanSnapshot): Promise<void> {
		await this.exportSpans([span]);
	}

	async exportSpans(spans: readonly SpanSnapshot[]): Promise<void> {
		const results = await Promise.allSettled(
			this.exporters.map((exporter) => {
				if (exporter.exportSpans != null) {
					return exporter.exportSpans(spans);
				}
				return Promise.all(spans.map((span) => exporter.exportSpan?.(span)));
			}),
		);

		this.failures = results.flatMap((result, exporterIndex) =>
			result.status === "rejected"
				? [{ exporterIndex, error: result.reason }]
				: [],
		);
	}
}
