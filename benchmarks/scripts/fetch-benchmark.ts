import { downloadSweBenchLiteDataset } from "../src/swe-bench-lite/dataset.js";

const argv = process.argv.slice(2);
let options: ReturnType<typeof parseArgs>;
try {
	options = parseArgs(argv);
} catch (error: unknown) {
	console.error(
		error instanceof Error ? error.message : "Invalid CLI arguments",
	);
	process.exit(1);
}

if (options.dataset !== "swe-bench-lite") {
	console.error(`Unsupported dataset: ${options.dataset}`);
	process.exit(1);
}

downloadSweBenchLiteDataset({
	...(options.cacheRoot == null ? {} : { cacheRoot: options.cacheRoot }),
	...(options.pageSize == null ? {} : { pageSize: options.pageSize }),
	...(options.maxRows == null ? {} : { maxRows: options.maxRows }),
	...(options.rowsBaseUrl == null ? {} : { rowsBaseUrl: options.rowsBaseUrl }),
})
	.then((result) => {
		console.log(
			JSON.stringify(
				{
					dataset: options.dataset,
					rows: result.rows,
					bytes: result.bytes,
					sha256: result.sha256,
					outputPath: result.outputPath,
					manifestPath: result.manifestPath,
				},
				null,
				2,
			),
		);
	})
	.catch((error: unknown) => {
		console.error(
			error instanceof Error
				? error.message
				: "Unknown benchmark fetch failure",
		);
		process.exit(1);
	});

function parsePositiveInt(flag: string, value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
		throw new Error(`${flag} must be a positive integer, got: ${value}`);
	}
	return parsed;
}

function parseArgs(argv: readonly string[]) {
	let dataset = "swe-bench-lite";
	let cacheRoot: string | undefined;
	let pageSize: number | undefined;
	let maxRows: number | undefined;
	let rowsBaseUrl: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = argv[index + 1];
		if (arg === "--dataset" && value != null) {
			dataset = value;
			index += 1;
			continue;
		}
		if (arg === "--cache-root" && value != null) {
			cacheRoot = value;
			index += 1;
			continue;
		}
		if (arg === "--page-size" && value != null) {
			pageSize = parsePositiveInt("--page-size", value);
			index += 1;
			continue;
		}
		if (arg === "--max-rows" && value != null) {
			maxRows = parsePositiveInt("--max-rows", value);
			index += 1;
			continue;
		}
		if (arg === "--rows-base-url" && value != null) {
			rowsBaseUrl = value;
			index += 1;
		}
	}

	return { dataset, cacheRoot, pageSize, maxRows, rowsBaseUrl };
}
