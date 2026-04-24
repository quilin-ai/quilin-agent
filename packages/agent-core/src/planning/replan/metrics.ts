export interface GlobalReplanRateMetrics {
	readonly totalRuns: number;
	readonly globalReplanTriggers: number;
	readonly triggerRate: number;
	readonly productionRuns: number;
	readonly productionGlobalReplanTriggers: number;
	readonly productionTriggerRate: number;
	readonly productionTargetRate: number;
	readonly productionTargetMet: boolean;
}

export interface GlobalReplanRateOptions {
	readonly productionTargetRate?: number;
}

export interface GlobalReplanRunSample {
	readonly hadGlobalReplan: boolean;
	readonly production?: boolean;
}

export const DEFAULT_GLOBAL_REPLAN_PRODUCTION_TARGET_RATE = 0.05;

function normalizeRate(value: number | undefined): number {
	const resolved = value ?? DEFAULT_GLOBAL_REPLAN_PRODUCTION_TARGET_RATE;
	if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
		throw new RangeError("productionTargetRate must be between 0 and 1");
	}
	return resolved;
}

export function computeGlobalReplanRate(
	samples: ReadonlyArray<GlobalReplanRunSample>,
	options: GlobalReplanRateOptions = {},
): GlobalReplanRateMetrics {
	const productionTargetRate = normalizeRate(options.productionTargetRate);
	const globalReplanTriggers = samples.filter(
		(sample) => sample.hadGlobalReplan,
	).length;
	const productionSamples = samples.filter(
		(sample) => sample.production === true,
	);
	const productionGlobalReplanTriggers = productionSamples.filter(
		(sample) => sample.hadGlobalReplan,
	).length;

	return {
		totalRuns: samples.length,
		globalReplanTriggers,
		triggerRate:
			samples.length === 0 ? 0 : globalReplanTriggers / samples.length,
		productionRuns: productionSamples.length,
		productionGlobalReplanTriggers,
		productionTriggerRate:
			productionSamples.length === 0
				? 0
				: productionGlobalReplanTriggers / productionSamples.length,
		productionTargetRate,
		productionTargetMet:
			productionSamples.length === 0
				? true
				: productionGlobalReplanTriggers / productionSamples.length <=
					productionTargetRate,
	};
}
