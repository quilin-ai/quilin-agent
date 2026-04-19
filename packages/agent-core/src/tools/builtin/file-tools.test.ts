import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		vi.unstubAllEnvs();
		await rm(tempDir, { recursive: true, force: true });
	});

	it("file_read returns numbered lines and supports offset plus limit", async () => {
		const filePath = join(tempDir, "notes.txt");
		await writeFile(filePath, "first\nsecond\nthird\nfourth\n", "utf8");
		const tool = createFileReadTool({ allowedRoots: [tempDir] });

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
		const sensitiveTool = createFileReadTool({ allowedRoots: [tempDir] });

		const blocked = await sensitiveTool.execute({ path: secretPath });

		expect(blocked.isError).toBe(true);
		expect(JSON.parse(blocked.content)).toEqual({
			error: expect.stringContaining(".env"),
		});

		const largePath = join(tempDir, "large.txt");
		await writeFile(largePath, "alpha\nbeta\ngamma\ndelta\n", "utf8");
		const truncatingTool = createFileReadTool({
			maxChars: 6,
			allowedRoots: [tempDir],
		});

		const truncated = await truncatingTool.execute({ path: largePath });

		expect(truncated.isError).toBe(false);
		expect(JSON.parse(truncated.content)).toEqual({
			path: largePath,
			content: "1: ...",
			truncated: true,
		});
	});

	it("file_read keeps the rendered output within maxChars", async () => {
		const filePath = join(tempDir, "many-lines.txt");
		await writeFile(filePath, `${"abcde\n".repeat(1000)}`, "utf8");
		const tool = createFileReadTool({
			maxChars: 5_000,
			allowedRoots: [tempDir],
		});

		const result = await tool.execute({ path: filePath });

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content) as {
			content: string;
			truncated: boolean;
		};
		expect(payload.truncated).toBe(true);
		expect(payload.content.length).toBeLessThanOrEqual(5_000);
	});

	it("file_write writes utf-8 content and reports written bytes", async () => {
		const filePath = join(tempDir, "output.txt");
		const tool = createFileWriteTool({ allowedRoots: [tempDir] });

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

	it("file_write blocks ssh authorized_keys and oversized payloads", async () => {
		const fakeHome = join(tempDir, "home");
		const sshDir = join(fakeHome, ".ssh");
		const authorizedKeysPath = join(sshDir, "authorized_keys");

		vi.stubEnv("HOME", fakeHome);
		await mkdir(sshDir, { recursive: true });

		const sensitiveTool = createFileWriteTool({ allowedRoots: [fakeHome] });
		const sensitiveResult = await sensitiveTool.execute({
			path: authorizedKeysPath,
			content: "ssh-ed25519 AAAATEST user@example",
		});

		expect(sensitiveResult.isError).toBe(true);
		expect(JSON.parse(sensitiveResult.content)).toEqual({
			error: expect.stringContaining("authorized_keys"),
		});

		const oversizedTool = createFileWriteTool({
			allowedRoots: [tempDir],
			maxBytes: 4,
		} as never);
		const oversizedResult = await oversizedTool.execute({
			path: join(tempDir, "too-large.txt"),
			content: "hello",
		});

		expect(oversizedResult.isError).toBe(true);
		expect(JSON.parse(oversizedResult.content)).toEqual({
			error: expect.stringContaining("maxBytes"),
		});
	});

	it("file_write replaces files without leaving temporary artifacts", async () => {
		const filePath = join(tempDir, "atomic.txt");
		await writeFile(filePath, "before", "utf8");
		const tool = createFileWriteTool({ allowedRoots: [tempDir] });

		const result = await tool.execute({
			path: filePath,
			content: "after",
		});

		expect(result.isError).toBe(false);
		expect(await readFile(filePath, "utf8")).toBe("after");
		expect(await readdir(tempDir)).toEqual(["atomic.txt"]);
	});

	it("file_list returns sorted entries and supports glob-style filtering", async () => {
		await writeFile(join(tempDir, "b.ts"), "export {};\n", "utf8");
		await writeFile(join(tempDir, "a.md"), "# note\n", "utf8");
		await mkdir(join(tempDir, "docs"));
		const tool = createFileListTool({ allowedRoots: [tempDir] });

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

	it("blocks traversal outside allowed roots and symlink escapes", async () => {
		const rootDir = join(tempDir, "workspace");
		const nestedDir = join(rootDir, "nested");
		const outsidePath = join(tempDir, "outside.txt");
		const symlinkPath = join(rootDir, "escape-link.txt");

		await mkdir(nestedDir, { recursive: true });
		await writeFile(outsidePath, "do not read", "utf8");
		await symlink(outsidePath, symlinkPath);

		const tool = createFileReadTool({ allowedRoots: [rootDir] });

		const traversalResult = await tool.execute({
			path: join(nestedDir, "..", "..", "outside.txt"),
		});
		expect(traversalResult.isError).toBe(true);
		expect(JSON.parse(traversalResult.content)).toEqual({
			error: "Path not accessible",
		});

		const symlinkResult = await tool.execute({ path: symlinkPath });
		expect(symlinkResult.isError).toBe(true);
		expect(JSON.parse(symlinkResult.content)).toEqual({
			error: "Path not accessible",
		});
	});

	it("blocks sensitive credential paths even inside allowed roots", async () => {
		const fakeHome = join(tempDir, "home");
		const awsDir = join(fakeHome, ".aws");
		const credentialsPath = join(awsDir, "credentials");

		vi.stubEnv("HOME", fakeHome);
		await mkdir(awsDir, { recursive: true });
		await writeFile(credentialsPath, "[default]\naws_access_key_id=test\n", "utf8");

		const tool = createFileReadTool({ allowedRoots: [fakeHome] });
		const result = await tool.execute({ path: credentialsPath });

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("credentials"),
		});
	});

	it("applies allowed roots to file_write and file_list", async () => {
		const rootDir = join(tempDir, "workspace");
		await mkdir(rootDir, { recursive: true });

		const writeTool = createFileWriteTool({ allowedRoots: [rootDir] });
		const writeResult = await writeTool.execute({
			path: join(tempDir, "outside-write.txt"),
			content: "nope",
		});
		expect(writeResult.isError).toBe(true);
		expect(JSON.parse(writeResult.content)).toEqual({
			error: "Path not accessible",
		});

		const listTool = createFileListTool({ allowedRoots: [rootDir] });
		const listResult = await listTool.execute({ path: tempDir });
		expect(listResult.isError).toBe(true);
		expect(JSON.parse(listResult.content)).toEqual({
			error: "Path not accessible",
		});
	});

	it("uses the same inaccessible-path message for system sensitive and missing paths", async () => {
		const systemTool = createFileReadTool({ allowedRoots: ["/"] });
		const systemResult = await systemTool.execute({ path: "/etc/shadow" });

		expect(systemResult.isError).toBe(true);
		expect(JSON.parse(systemResult.content)).toEqual({
			error: "Path not accessible",
		});

		const missingTool = createFileReadTool({ allowedRoots: [tempDir] });
		const missingResult = await missingTool.execute({
			path: join(tempDir, "missing.txt"),
		});
		expect(missingResult.isError).toBe(true);
		expect(JSON.parse(missingResult.content)).toEqual({
			error: "Path not accessible",
		});
	});
});
