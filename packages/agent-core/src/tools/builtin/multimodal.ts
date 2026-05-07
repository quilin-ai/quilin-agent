import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { logger } from "../../logger.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEEPSEEK_API_BASE = "https://api.deepseek.com";
const DEFAULT_VISION_MODEL = "deepseek-chat";
const DEFAULT_MAX_OUTPUT_CHARS = 16_384;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const DEFAULT_MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_MAX_FRAMES = 8;
const DEFAULT_FRAME_INTERVAL_SECONDS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
]);

const IMAGE_MIME_MAP: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const VIDEO_EXTENSIONS = new Set([
	".mp4",
	".mov",
	".avi",
	".mkv",
	".webm",
]);

const AUDIO_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".m4a",
	".ogg",
	".flac",
	".webm",
]);

const AUDIO_MIME_MAP: Readonly<Record<string, string>> = {
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".flac": "audio/flac",
	".webm": "audio/webm",
};

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function createSuccessResult(
	toolCallId: string,
	payload: Record<string, unknown>,
): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify(payload),
		isError: false,
	};
}

function createErrorResult(
	toolCallId: string,
	message: string,
): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify({ error: message }),
		isError: true,
	};
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
	const apiKey = process.env.DEEPSEEK_API_KEY;
	if (apiKey == null || apiKey.trim().length === 0) {
		throw new Error(
			"DEEPSEEK_API_KEY environment variable is not configured.",
		);
	}

	return apiKey;
}

function imageToDataUri(mimeType: string, base64Data: string): string {
	return `data:${mimeType};base64,${base64Data}`;
}

// ---------------------------------------------------------------------------
// Path / file validation
// ---------------------------------------------------------------------------

async function validateFilePath(
	filePath: string,
	allowedExtensions: ReadonlySet<string>,
	maxBytes: number,
): Promise<{ readonly absolutePath: string; readonly size: number; readonly ext: string }> {
	const absolutePath = resolve(filePath);
	const fileName = basename(absolutePath);
	const ext = extname(absolutePath).toLowerCase();

	if (!allowedExtensions.has(ext)) {
		throw new Error(
			`Unsupported file type "${ext}". Allowed: ${[...allowedExtensions].join(", ")}`,
		);
	}

	// Check existence and readability
	try {
		await access(absolutePath, 4 /* R_OK */);
	} catch {
		throw new Error(`File not found or not readable: ${fileName}`);
	}

	const fileStat = await stat(absolutePath);
	if (!fileStat.isFile()) {
		throw new Error(`Path is not a file: ${fileName}`);
	}

	if (fileStat.size > maxBytes) {
		const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1);
		const maxMB = (maxBytes / (1024 * 1024)).toFixed(1);
		throw new Error(
			`File too large: ${sizeMB} MB exceeds ${maxMB} MB limit.`,
		);
	}

	return { absolutePath, size: fileStat.size, ext };
}

async function readFileAsBase64(filePath: string): Promise<string> {
	const buffer = await readFile(filePath);
	return buffer.toString("base64");
}

// ---------------------------------------------------------------------------
// DeepSeek vision API call
// ---------------------------------------------------------------------------

interface VisionApiCallParams {
	readonly prompt: string;
	readonly images: ReadonlyArray<{
		readonly dataUri: string;
	}>;
	readonly apiBaseUrl: string;
	readonly model: string;
	readonly apiKey: string;
	readonly maxOutputChars: number;
	readonly timeoutMs: number;
	readonly fetcher: typeof fetch;
}

async function callVisionApi(
	params: VisionApiCallParams,
): Promise<string> {
	const { prompt, images, apiBaseUrl, model, apiKey, maxOutputChars, timeoutMs, fetcher } =
		params;

	const imageContent = images.map((img) => ({
		type: "image_url" as const,
		image_url: { url: img.dataUri },
	}));

	const requestBody = {
		model,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: prompt },
					...imageContent,
				],
			},
		],
		max_tokens: maxOutputChars,
		stream: false,
	};

	const response = await fetcher(`${apiBaseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(requestBody),
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "");
		logger.error(
			{ status: response.status, body: errorBody.slice(0, 500) },
			"DeepSeek vision API returned an error",
		);
		throw new Error(
			`Vision API returned status ${response.status}: ${errorBody.slice(0, 200)}`,
		);
	}

	const json = (await response.json()) as {
		readonly choices?: ReadonlyArray<{
			readonly message?: { readonly content?: string };
		}>;
	};

	const content = json.choices?.[0]?.message?.content;
	if (content == null || content.length === 0) {
		throw new Error("Vision API returned an empty response.");
	}

	return content;
}

// ---------------------------------------------------------------------------
// Video helpers (ffprobe / ffmpeg)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function runFfprobe(
	videoPath: string,
): Promise<{ readonly durationSeconds?: number }> {
	try {
		const { stdout } = await execFileAsync("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			videoPath,
		], { timeout: 30_000 });

		const value = Number.parseFloat(stdout.trim());
		if (Number.isNaN(value) || value <= 0) {
			return {};
		}

		return { durationSeconds: value };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`ffprobe failed. Ensure ffmpeg is installed and the file is a valid video. Details: ${message}`,
		);
	}
}

async function extractFrameJpeg(
	videoPath: string,
	timestampSeconds: number,
): Promise<Buffer> {
	try {
		const { stdout } = await execFileAsync("ffmpeg", [
			"-ss",
			String(timestampSeconds.toFixed(2)),
			"-i",
			videoPath,
			"-vframes",
			"1",
			"-f",
			"image2pipe",
			"-c:v",
			"mjpeg",
			"-q:v",
			"5",
			"-",
		], {
			timeout: 30_000,
			maxBuffer: 20 * 1024 * 1024,
			encoding: "buffer" as unknown as undefined,
		});

		// When encoding is "buffer", stdout is Buffer.
		const buffer = stdout as Buffer;
		if (buffer.length === 0) {
			throw new Error("ffmpeg produced an empty frame.");
		}

		return buffer;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`ffmpeg frame extraction failed at ${timestampSeconds}s. Details: ${message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// image_describe
// ---------------------------------------------------------------------------

export interface ImageDescribeToolOptions {
	readonly apiBaseUrl?: string;
	readonly model?: string;
	readonly maxImageBytes?: number;
	readonly maxOutputChars?: number;
	readonly timeoutMs?: number;
	readonly fetcher?: typeof fetch;
}

export function createImageDescribeTool(
	options: ImageDescribeToolOptions = {},
): ToolWithMetadata {
	const {
		apiBaseUrl = DEEPSEEK_API_BASE,
		model = DEFAULT_VISION_MODEL,
		maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
		maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		fetcher = fetch,
	} = options;

	return {
		name: "image_describe",
		description:
			"Describe an image from a local file path or remote URL using the DeepSeek vision model. Accepts either 'path' (local file) or 'url' (remote image).",
		parameters: z.object({
			path: z.string().optional().describe("Local file path to an image."),
			url: z.string().optional().describe("Remote URL to an image."),
			prompt: z.string().optional().describe(
				"Custom prompt for image description. Defaults to a general description request.",
			),
		}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (args) => {
			const {
				path,
				url,
				prompt = "Please describe this image in detail.",
			} = args as {
				path?: string;
				url?: string;
				prompt?: string;
			};

			if (path == null && url == null) {
				return createErrorResult(
					"builtin-image-describe",
					"Either 'path' or 'url' must be provided.",
				);
			}

			if (path != null && url != null) {
				return createErrorResult(
					"builtin-image-describe",
					"Provide either 'path' or 'url', not both.",
				);
			}

			try {
				const apiKey = getApiKey();
				let dataUri: string;

				if (path != null) {
					const { absolutePath, ext } = await validateFilePath(
						path,
						IMAGE_EXTENSIONS,
						maxImageBytes,
					);
					const mimeType = IMAGE_MIME_MAP[ext] ?? "image/jpeg";
					const base64Data = await readFileAsBase64(absolutePath);
					dataUri = imageToDataUri(mimeType, base64Data);
					logger.info(
						{ path: absolutePath, size: base64Data.length },
						"image_describe: loaded local image",
					);
				} else {
					// url is guaranteed non-null here due to earlier validation
					const parsedUrl = new URL(url!);
					if (!["http:", "https:"].includes(parsedUrl.protocol)) {
						return createErrorResult(
							"builtin-image-describe",
							"Only http and https URLs are allowed.",
						);
					}

					// For remote images, pass the URL directly to the vision API.
					// DeepSeek vision API supports http(s) image_url.
					dataUri = url!;
					logger.info({ url: url! }, "image_describe: referencing remote image");
				}

				const description = await callVisionApi({
					prompt,
					images: [{ dataUri }],
					apiBaseUrl,
					model,
					apiKey,
					maxOutputChars,
					timeoutMs,
					fetcher,
				});

				return createSuccessResult("builtin-image-describe", {
					source: path != null ? "local" : "remote",
					description,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				logger.error({ err: error }, "image_describe failed");
				return createErrorResult("builtin-image-describe", message);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// video_summarize
// ---------------------------------------------------------------------------

export interface VideoSummarizeToolOptions {
	readonly apiBaseUrl?: string;
	readonly model?: string;
	readonly maxVideoBytes?: number;
	readonly maxOutputChars?: number;
	readonly maxFrames?: number;
	readonly frameIntervalSeconds?: number;
	readonly timeoutMs?: number;
	readonly fetcher?: typeof fetch;
}

export function createVideoSummarizeTool(
	options: VideoSummarizeToolOptions = {},
): ToolWithMetadata {
	const {
		apiBaseUrl = DEEPSEEK_API_BASE,
		model = DEFAULT_VISION_MODEL,
		maxVideoBytes = DEFAULT_MAX_VIDEO_BYTES,
		maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
		maxFrames = DEFAULT_MAX_FRAMES,
		frameIntervalSeconds = DEFAULT_FRAME_INTERVAL_SECONDS,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		fetcher = fetch,
	} = options;

	return {
		name: "video_summarize",
		description:
			"Extract keyframes from a local video file and generate a content summary using the DeepSeek vision model.",
		parameters: z.object({
			path: z.string().describe("Local file path to a video file."),
			prompt: z.string().optional().describe(
				"Custom prompt for the summary. Defaults to a comprehensive video content summary request.",
			),
		}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (args) => {
			const {
				path,
				prompt = "These are keyframes extracted from a video at regular time intervals. Generate a comprehensive summary of what this video is about based on these frames. Describe the content, setting, people (if any), actions, and overall narrative or purpose.",
			} = args as {
				path: string;
				prompt?: string;
			};

			if (path == null || path.trim().length === 0) {
				return createErrorResult(
					"builtin-video-summarize",
					"A local video file path is required.",
				);
			}

			try {
				const apiKey = getApiKey();

				// Validate the file
				const { absolutePath } = await validateFilePath(
					path,
					VIDEO_EXTENSIONS,
					maxVideoBytes,
				);

				// Get video duration via ffprobe
				const { durationSeconds } = await runFfprobe(absolutePath);
				if (durationSeconds == null) {
					return createErrorResult(
						"builtin-video-summarize",
						"Could not determine video duration. The file may be corrupt.",
					);
				}

				// Calculate frame extraction timestamps
				const totalFrames = Math.min(
					maxFrames,
					Math.floor(durationSeconds / frameIntervalSeconds),
				);
				if (totalFrames === 0) {
					return createErrorResult(
						"builtin-video-summarize",
						`Video is too short (${durationSeconds.toFixed(1)}s) to extract keyframes at ${frameIntervalSeconds}s intervals.`,
					);
				}

				const timestamps: number[] = [];
				const step = durationSeconds / (totalFrames + 1);
				for (let i = 1; i <= totalFrames; i += 1) {
					timestamps.push(step * i);
				}

				logger.info(
					{ path: absolutePath, durationSeconds, totalFrames, timestamps },
					"video_summarize: extracting keyframes",
				);

				// Extract frames
				const frames: Array<{ readonly dataUri: string }> = [];
				for (const timestamp of timestamps) {
					const buffer = await extractFrameJpeg(absolutePath, timestamp);
					const base64Data = buffer.toString("base64");
					frames.push({
						dataUri: imageToDataUri("image/jpeg", base64Data),
					});
				}

				logger.info(
					{ frameCount: frames.length },
					"video_summarize: frames extracted, calling vision API",
				);

				// Call vision API with all frames
				const summary = await callVisionApi({
					prompt,
					images: frames,
					apiBaseUrl,
					model,
					apiKey,
					maxOutputChars,
					timeoutMs,
					fetcher,
				});

				return createSuccessResult("builtin-video-summarize", {
					path: absolutePath,
					durationSeconds,
					framesExtracted: frames.length,
					summary,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				logger.error({ err: error }, "video_summarize failed");
				return createErrorResult("builtin-video-summarize", message);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// audio_transcribe
// ---------------------------------------------------------------------------

export interface AudioTranscribeToolOptions {
	readonly apiBaseUrl?: string;
	readonly model?: string;
	readonly maxAudioBytes?: number;
	readonly maxOutputChars?: number;
	readonly timeoutMs?: number;
	readonly fetcher?: typeof fetch;
}

export function createAudioTranscribeTool(
	options: AudioTranscribeToolOptions = {},
): ToolWithMetadata {
	const {
		apiBaseUrl = DEEPSEEK_API_BASE,
		model = "whisper-1",
		maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		fetcher = fetch,
	} = options;

	return {
		name: "audio_transcribe",
		description:
			"Transcribe audio from a local file using the DeepSeek audio transcription API.",
		parameters: z.object({
			path: z.string().describe("Local file path to an audio file."),
			language: z.string().optional().describe(
				"ISO 639-1 language code (e.g., 'en', 'zh'). If omitted, auto-detection is used.",
			),
			prompt: z.string().optional().describe(
				"Optional context prompt to guide transcription style and vocabulary.",
			),
		}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (args) => {
			const { path, language, prompt } = args as {
				path: string;
				language?: string;
				prompt?: string;
			};

			if (path == null || path.trim().length === 0) {
				return createErrorResult(
					"builtin-audio-transcribe",
					"A local audio file path is required.",
				);
			}

			try {
				const apiKey = getApiKey();

				// Validate the file
				const { absolutePath, ext } = await validateFilePath(
					path,
					AUDIO_EXTENSIONS,
					maxAudioBytes,
				);

				const mimeType = AUDIO_MIME_MAP[ext] ?? "audio/mpeg";

				// Build multipart form data
				const formData = new FormData();
				const fileBuffer = await readFile(absolutePath);

				// The FormData File constructor
				const fileName = basename(absolutePath);
				const blob = new Blob([fileBuffer], { type: mimeType });
				formData.append("file", blob, fileName);
				formData.append("model", model);

				if (language != null && language.trim().length > 0) {
					formData.append("language", language.trim());
				}

				if (prompt != null && prompt.trim().length > 0) {
					formData.append("prompt", prompt.trim());
				}

				logger.info(
					{ path: absolutePath, size: fileBuffer.length, mimeType },
					"audio_transcribe: sending to API",
				);

				// Send to DeepSeek audio transcription endpoint
				const response = await fetcher(
					`${apiBaseUrl}/v1/audio/transcriptions`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${apiKey}`,
						},
						body: formData,
						signal: AbortSignal.timeout(timeoutMs),
					},
				);

				if (!response.ok) {
					const errorBody = await response.text().catch(() => "");
					logger.error(
						{ status: response.status, body: errorBody.slice(0, 500) },
						"DeepSeek audio API returned an error",
					);
					throw new Error(
						`Audio API returned status ${response.status}: ${errorBody.slice(0, 200)}`,
					);
				}

				const json = (await response.json()) as {
					readonly text?: string;
				};

				const text = json.text;
				if (text == null || text.length === 0) {
					return createSuccessResult("builtin-audio-transcribe", {
						path: absolutePath,
						transcription: "",
					});
				}

				return createSuccessResult("builtin-audio-transcribe", {
					path: absolutePath,
					transcription: text,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				logger.error({ err: error }, "audio_transcribe failed");
				return createErrorResult("builtin-audio-transcribe", message);
			}
		},
	};
}
