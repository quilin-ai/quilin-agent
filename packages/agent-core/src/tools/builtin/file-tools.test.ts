import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
} from "./file-tools.js";

describe("builtin file tools", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "quilin-file-tools-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("file_read returns numbered lines and supports offset plus limit", async () => {
		const filePath = join(tempDir, "notes.txt");
		await writeFile(filePath, "first\nsecond\nthird\nfourth\n", "utf8");
		const tool = createFileReadTool();

		const result = await tool.execute({
			path: filePath,
			offset: 1,
			limit: 2,
		});

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toEqual({
			path: filePath,
			content: "2: second\n3: third",
			truncated: false,
		});
	});

	it("file_read blocks sensitive files and truncates oversized output", async () => {
		const secretPath = join(tempDir, ".env");
		await writeFile(secretPath, "TOKEN=secret", "utf8");
		const sensitiveTool = createFileReadTool();

		const blocked = await sensitiveTool.execute({ path: secretPath });

		expect(blocked.isError).toBe(true);
		expect(JSON.parse(blocked.content)).toEqual({
			error: expect.stringContaining(".env"),
		});

		const largePath = join(tempDir, "large.txt");
		await writeFile(largePath, "alpha\nbeta\ngamma\ndelta\n", "utf8");
		const truncatingTool = createFileReadTool({ maxChars: 6 });

		const truncated = await truncatingTool.execute({ path: largePath });

		expect(truncated.isError).toBe(false);
		expect(JSON.parse(truncated.content)).toEqual({
			path: largePath,
			content: "1: alpha\n2: ...",
			truncated: true,
		});
	});

	it("file_write writes utf-8 content and reports written bytes", async () => {
		const filePath = join(tempDir, "output.txt");
		const tool = createFileWriteTool();

		const result = await tool.execute({
			path: filePath,
			content: "hello 麒麟",
		});

		expect(result.isError).toBe(false);
		expect(await readFile(filePath, "utf8")).toBe("hello 麒麟");
		expect(JSON.parse(result.content)).toEqual({
			path: filePath,
			bytesWritten: Buffer.byteLength("hello 麒麟", "utf8"),
		});
	});

	it("file_list returns sorted entries and supports glob-style filtering", async () => {
		await writeFile(join(tempDir, "b.ts"), "export {};\n", "utf8");
		await writeFile(join(tempDir, "a.md"), "# note\n", "utf8");
		await mkdir(join(tempDir, "docs"));
		const tool = createFileListTool();

		const result = await tool.execute({
			path: tempDir,
			pattern: "*.ts",
		});

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toEqual({
			path: tempDir,
			entries: [
				{
					name: "b.ts",
					path: join(tempDir, "b.ts"),
					type: "file",
				},
			],
		});
	});
});
