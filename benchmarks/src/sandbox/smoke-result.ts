export interface DockerSmokeCommandPayload {
	readonly exitCode: number | null;
	readonly output_truncated: boolean;
	readonly stderr: string;
	readonly stdout: string;
	readonly timedOut: boolean;
}

interface DockerSmokeCommandResult {
	readonly content: string;
	readonly isError: boolean;
}

export function assertDockerSmokeCommandSucceeded(
	result: unknown,
	label: string,
): DockerSmokeCommandPayload {
	const parsed = parseDockerSmokeCommandResult(result, label);
	if (
		parsed.isError ||
		parsed.payload.exitCode !== 0 ||
		parsed.payload.timedOut ||
		parsed.payload.output_truncated
	) {
		throw new Error(formatSmokeFailure(label, parsed));
	}
	return parsed.payload;
}

export function assertDockerSmokeCommandTimedOut(
	result: unknown,
	label: string,
): DockerSmokeCommandPayload {
	const parsed = parseDockerSmokeCommandResult(result, label);
	if (!parsed.isError || parsed.payload.timedOut !== true) {
		throw new Error(formatSmokeFailure(label, parsed));
	}
	return parsed.payload;
}

function parseDockerSmokeCommandResult(
	result: unknown,
	label: string,
): {
	readonly isError: boolean;
	readonly payload: DockerSmokeCommandPayload;
} {
	const commandResult = parseCommandResultEnvelope(result, label);
	const payload = parsePayload(commandResult.content, label);
	return {
		isError: commandResult.isError,
		payload,
	};
}

function parseCommandResultEnvelope(
	result: unknown,
	label: string,
): DockerSmokeCommandResult {
	if (result == null || typeof result !== "object") {
		throw new Error(`${label} returned a non-object tool result`);
	}
	const candidate = result as Partial<DockerSmokeCommandResult>;
	if (typeof candidate.content !== "string") {
		throw new Error(`${label} returned a tool result without string content`);
	}
	if (typeof candidate.isError !== "boolean") {
		throw new Error(`${label} returned a tool result without isError`);
	}
	return {
		content: candidate.content,
		isError: candidate.isError,
	};
}

function parsePayload(
	content: string,
	label: string,
): DockerSmokeCommandPayload {
	let payload: unknown;
	try {
		payload = JSON.parse(content);
	} catch (error) {
		throw new Error(`${label} returned invalid JSON content: ${String(error)}`);
	}
	if (payload == null || typeof payload !== "object") {
		throw new Error(`${label} returned non-object JSON content`);
	}
	const candidate = payload as Partial<DockerSmokeCommandPayload>;
	if (
		!(typeof candidate.exitCode === "number" || candidate.exitCode === null) ||
		typeof candidate.output_truncated !== "boolean" ||
		typeof candidate.stderr !== "string" ||
		typeof candidate.stdout !== "string" ||
		typeof candidate.timedOut !== "boolean"
	) {
		throw new Error(`${label} returned incomplete DockerSandbox payload`);
	}
	return {
		exitCode: candidate.exitCode,
		output_truncated: candidate.output_truncated,
		stderr: candidate.stderr,
		stdout: candidate.stdout,
		timedOut: candidate.timedOut,
	};
}

function formatSmokeFailure(
	label: string,
	parsed: {
		readonly isError: boolean;
		readonly payload: DockerSmokeCommandPayload;
	},
): string {
	return [
		`${label} failed`,
		`isError=${parsed.isError}`,
		`exitCode=${String(parsed.payload.exitCode)}`,
		`timedOut=${String(parsed.payload.timedOut)}`,
		`output_truncated=${String(parsed.payload.output_truncated)}`,
		`stderr=${parsed.payload.stderr}`,
		`stdout=${parsed.payload.stdout}`,
	].join("; ");
}
