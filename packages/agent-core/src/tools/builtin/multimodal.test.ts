import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	createAudioTranscribeTool,
	createImageDescribeTool,
	createVideoSummarizeTool,
} from "./multimodal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockOkResponse(data: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(data),
		text: vi.fn().mockResolvedValue(JSON.stringify(data)),
		headers: new Headers(),
	} as unknown as Response;
}

function mockErrorResponse(status: number, body: string): Response {
	return {
		ok: false,
		status,
		json: vi.fn().mockRejectedValue(new Error("not json")),
		text: vi.fn().mockResolvedValue(body),
		headers: new Headers(),
	} as unknown as Response;
}

function mockVisionResponse(content: string): Response {
	return mockOkResponse({
		choices: [{ message: { content } }],
	});
}

function mockTranscriptionResponse(text: string): Response {
	return mockOkResponse({ text });
}

// Generate a minimal valid JPEG buffer (the smallest possible)
function minimalJpegBuffer(): Buffer {
	// Minimal JPEG: SOI + APP0 + DQT + SOF0 + DHT + SOS + EOI
	// This is a valid, viewable 1x1 gray JPEG
	const tables = Buffer.from([
		0xff, 0xd8, // SOI
		0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
		0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0 (JFIF)
		0xff, 0xdb, 0x00, 0x43, 0x00, // DQT
	]);

	const qt: number[] = [];
	for (let i = 0; i < 64; i += 1) {
		qt.push(i + 1);
	}
	const dqt = Buffer.from(qt);

	const sof = Buffer.from([
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, // SOF0
	]);

	const dht = Buffer.from([
		0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01,
		0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02,
		0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, // DHT DC
	]);

	const sos = Buffer.from([
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
	]);

	const eoi = Buffer.from([0xff, 0xd9]); // EOI

	return Buffer.concat([tables, dqt, sof, dht, sos, eoi]);
}

// ---------------------------------------------------------------------------
// Env setup / teardown
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };

function setApiKey(value: string) {
	process.env.DEEPSEEK_API_KEY = value;
}

function clearApiKey() {
	delete process.env.DEEPSEEK_API_KEY;
}

beforeEach(() => {
	process.env.DEEPSEEK_API_KEY = "test-api-key";
});

afterEach(() => {
	process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// image_describe
// ---------------------------------------------------------------------------

describe("builtin image_describe tool", () => {
	it("creates a tool with the expected metadata", () => {
		const tool = createImageDescribeTool();
		expect(tool.name).toBe("image_describe");
		expect(tool.category).toBe("programmatic");
		expect(tool.riskLevel).toBe("read");
	});

	it("returns an error when neither path nor url is provided", async () => {
		const tool = createImageDescribeTool();
		const result = await tool.execute({});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("Either 'path' or 'url' must be provided");
	});

	it("returns an error when both path and url are provided", async () => {
		const tool = createImageDescribeTool();
		const result = await tool.execute({ path: "/tmp/img.png", url: "https://example.com/img.png" });

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("Provide either 'path' or 'url'");
	});

	it("returns an error for non-existent local file", async () => {
		const tool = createImageDescribeTool();
		const result = await tool.execute({
			path: "/nonexistent/path/image.png",
		});

		expect(result.isError).toBe(true);
	});

	it("returns an error for unsupported local file extension", async () => {
		const tool = createImageDescribeTool();

		// Create a temp file with unsupported extension
		const { writeFile, unlink } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const tmpDir = process.env.TMPDIR ?? "/tmp";
		const tmpFile = join(tmpDir, `multimodal-test-unsupported-${Date.now()}.txt`);
		await writeFile(tmpFile, "hello world");

		try {
			const result = await tool.execute({ path: tmpFile });
			expect(result.isError).toBe(true);
			const payload = JSON.parse(result.content);
			expect(payload.error).toContain("Unsupported file type");
		} finally {
			await unlink(tmpFile).catch(() => {});
		}
	});

	it("describes an image from a URL using mocked vision API", async () => {
		const mockFetcher = vi.fn().mockResolvedValue(
			mockVisionResponse("A scenic mountain landscape with a lake."),
		);

		const tool = createImageDescribeTool({ fetcher: mockFetcher });
		const result = await tool.execute({
			url: "https://example.com/photo.jpg",
		});

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content);
		expect(payload.source).toBe("remote");
		expect(payload.description).toBe(
			"A scenic mountain landscape with a lake.",
		);

		// Verify the API call
		expect(mockFetcher).toHaveBeenCalledTimes(1);
		const callArgs = mockFetcher.mock.calls[0] as [string, RequestInit];
		expect(callArgs[0]).toContain("/v1/chat/completions");
		expect(callArgs[1].headers).toHaveProperty("Authorization", "Bearer test-api-key");
	});

	it("returns an error when vision API call fails", async () => {
		const mockFetcher = vi.fn().mockResolvedValue(
			mockErrorResponse(500, "Internal Server Error"),
		);

		const tool = createImageDescribeTool({ fetcher: mockFetcher });
		const result = await tool.execute({
			url: "https://example.com/photo.jpg",
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("500");
	});

	it("rejects non-http URL protocols", async () => {
		const tool = createImageDescribeTool();
		const result = await tool.execute({
			url: "file:///etc/passwd",
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("http");
	});

	it("handles custom prompt", async () => {
		const mockFetcher = vi.fn().mockResolvedValue(
			mockVisionResponse("The image shows a red car."),
		);

		const tool = createImageDescribeTool({ fetcher: mockFetcher });
		const result = await tool.execute({
			url: "https://example.com/car.jpg",
			prompt: "What color is the vehicle?",
		});

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content);
		expect(payload.description).toBe("The image shows a red car.");

		// Verify the custom prompt was sent
		const body = JSON.parse(mockFetcher.mock.calls[0][1].body as string);
		const textContent = body.messages[0].content.find(
			(c: { type: string }) => c.type === "text",
		);
		expect(textContent.text).toBe("What color is the vehicle?");
	});

	it("returns error when API key is missing", async () => {
		clearApiKey();
		const tool = createImageDescribeTool();
		const result = await tool.execute({ url: "https://example.com/img.jpg" });

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("DEEPSEEK_API_KEY");
	});
});

// ---------------------------------------------------------------------------
// video_summarize
// ---------------------------------------------------------------------------

describe("builtin video_summarize tool", () => {
	it("creates a tool with the expected metadata", () => {
		const tool = createVideoSummarizeTool();
		expect(tool.name).toBe("video_summarize");
		expect(tool.category).toBe("programmatic");
		expect(tool.riskLevel).toBe("read");
	});

	it("returns an error when path is empty", async () => {
		const tool = createVideoSummarizeTool();
		const result = await tool.execute({ path: "" });

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("video file path is required");
	});

	it("returns an error for non-existent file", async () => {
		const tool = createVideoSummarizeTool();
		const result = await tool.execute({
			path: "/nonexistent/video.mp4",
		});

		expect(result.isError).toBe(true);
	});

	it("returns an error for unsupported video extension", async () => {
		const tool = createVideoSummarizeTool();
		const result = await tool.execute({
			path: "/tmp/not-a-video.txt",
		});

		expect(result.isError).toBe(true);
	});

	it("returns error when API key is missing", async () => {
		clearApiKey();
		const tool = createVideoSummarizeTool();
		const result = await tool.execute({ path: "/some/video.mp4" });

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("DEEPSEEK_API_KEY");
	});
});

// ---------------------------------------------------------------------------
// audio_transcribe
// ---------------------------------------------------------------------------

describe("builtin audio_transcribe tool", () => {
	it("creates a tool with the expected metadata", () => {
		const tool = createAudioTranscribeTool();
		expect(tool.name).toBe("audio_transcribe");
		expect(tool.category).toBe("programmatic");
		expect(tool.riskLevel).toBe("read");
	});

	it("returns an error when path is empty", async () => {
		const tool = createAudioTranscribeTool();
		const result = await tool.execute({ path: "" });

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("audio file path is required");
	});

	it("returns an error for non-existent file", async () => {
		const tool = createAudioTranscribeTool();
		const result = await tool.execute({
			path: "/nonexistent/audio.mp3",
		});

		expect(result.isError).toBe(true);
	});

	it("returns error when API key is missing", async () => {
		clearApiKey();
		const tool = createAudioTranscribeTool();
		const result = await tool.execute({ path: "/some/audio.mp3" });

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("DEEPSEEK_API_KEY");
	});

	it("handles API error responses gracefully", async () => {
		const mockFetcher = vi.fn().mockResolvedValue(
			mockErrorResponse(401, "Unauthorized"),
		);

		const tool = createAudioTranscribeTool({ fetcher: mockFetcher });

		// We need a real file to pass the file existence check.
		// Use the temp test approach with a small audio-like file.
		const { writeFile, unlink } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const tmpDir = process.env.TMPDIR ?? "/tmp";
		const tmpFile = join(tmpDir, `multimodal-test-audio-${Date.now()}.mp3`);

		// Write a minimal valid-ish file (not a real MP3, but enough for the test)
		const bogusMp3 = Buffer.from([
			0xff, 0xfb, 0x90, 0x00, // MP3 frame sync + header
			0x00, 0x00, 0x00, 0x00,
		]);
		await writeFile(tmpFile, bogusMp3);

		try {
			const result = await tool.execute({ path: tmpFile });
			expect(result.isError).toBe(true);
			const payload = JSON.parse(result.content);
			expect(payload.error).toContain("401");
		} finally {
			await unlink(tmpFile).catch(() => {});
		}
	});

	it("successfully transcribes audio with mocked API", async () => {
		const mockFetcher = vi.fn().mockResolvedValue(
			mockTranscriptionResponse("Hello, this is a test transcription."),
		);

		const tool = createAudioTranscribeTool({ fetcher: mockFetcher });

		// Create a temp MP3 file
		const { writeFile, unlink } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const tmpDir = process.env.TMPDIR ?? "/tmp";
		const tmpFile = join(tmpDir, `multimodal-test-success-${Date.now()}.mp3`);

		const bogusMp3 = Buffer.from([
			0xff, 0xfb, 0x90, 0x00,
			0x00, 0x00, 0x00, 0x00,
		]);
		await writeFile(tmpFile, bogusMp3);

		try {
			const result = await tool.execute({
				path: tmpFile,
				language: "en",
				prompt: "Technical vocabulary",
			});

			expect(result.isError).toBe(false);
			const payload = JSON.parse(result.content);
			expect(payload.transcription).toBe(
				"Hello, this is a test transcription.",
			);

			// Verify the API call was made to the correct endpoint
			expect(mockFetcher).toHaveBeenCalledTimes(1);
			const callArgs = mockFetcher.mock.calls[0] as [string, RequestInit];
			expect(callArgs[0]).toContain("/v1/audio/transcriptions");
			expect(callArgs[1].headers).toHaveProperty(
				"Authorization",
				"Bearer test-api-key",
			);
			expect(callArgs[1].body).toBeInstanceOf(FormData);
		} finally {
			await unlink(tmpFile).catch(() => {});
		}
	});

	it("returns empty transcription when API returns empty text", async () => {
		const mockFetcher = vi.fn().mockResolvedValue(
			mockOkResponse({ text: "" }),
		);

		const tool = createAudioTranscribeTool({ fetcher: mockFetcher });

		const { writeFile, unlink } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const tmpDir = process.env.TMPDIR ?? "/tmp";
		const tmpFile = join(tmpDir, `multimodal-test-empty-${Date.now()}.wav`);

		const bogusWav = Buffer.alloc(44); // Minimal WAV header
		bogusWav.write("RIFF", 0);
		bogusWav.writeUInt32LE(36, 4);
		bogusWav.write("WAVE", 8);
		await writeFile(tmpFile, bogusWav);

		try {
			const result = await tool.execute({ path: tmpFile });
			expect(result.isError).toBe(false);
			const payload = JSON.parse(result.content);
			expect(payload.transcription).toBe("");
		} finally {
			await unlink(tmpFile).catch(() => {});
		}
	});

	it("returns error for unsupported audio extension", async () => {
		const tool = createAudioTranscribeTool();
		const result = await tool.execute({
			path: "/tmp/not-audio.txt",
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content);
		expect(payload.error).toContain("Unsupported file type");
	});
});
