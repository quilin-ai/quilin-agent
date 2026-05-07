import { describe, expect, it, vi } from "vitest";
import {
	__testing,
	runServiceCommand,
	type ServiceCommandOptions,
} from "./service-cmd.js";

// ---- Helpers ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function fakeFs() {
	const files = new Map<string, string>();

	const access = vi.fn(async (_filePath: string) => {
		if (files.has(_filePath)) return;
		const err = new Error("ENOENT");
		(err as NodeJS.ErrnoException).code = "ENOENT";
		throw err;
	});

	const mkdir = vi.fn(async (_dirPath: string, _opts?: object) => {});

	const writeFile = vi.fn(
		async (filePath: string, data: string) => {
			files.set(filePath, data);
		},
	);

	const unlink = vi.fn(async (filePath: string) => {
		if (files.has(filePath)) {
			files.delete(filePath);
		} else {
			const err = new Error("ENOENT");
			(err as NodeJS.ErrnoException).code = "ENOENT";
			throw err;
		}
	});

	const readFile = vi.fn(async (filePath: string) => {
		const content = files.get(filePath);
		if (content == null) {
			const err = new Error("ENOENT");
			(err as NodeJS.ErrnoException).code = "ENOENT";
			throw err;
		}
		return content;
	}) as AnyFn;

	return { access, mkdir, writeFile, unlink, readFile };
}

function fakeExec(): ReturnType<typeof vi.fn> {
	return vi.fn((_command: string, _args: readonly string[]) => {
		return "";
	});
}

function makeOptions(
	overrides: Partial<ServiceCommandOptions> & {
		macos?: boolean;
	} = {},
) {
	const f = fakeFs();
	const exec = fakeExec();
	const options: ServiceCommandOptions = {
		quilinPath: "/usr/local/bin/quilin",
		logDir: "/home/user/.quilin/logs",
		execFileSync: exec as unknown as typeof import("node:child_process").execFileSync,
	};

	const originalPlatform = process.platform;
	// Always explicitly set the platform to avoid leaking the real host OS.
	Object.defineProperty(process, "platform", {
		value: overrides.macos ? "darwin" : "linux",
		configurable: true,
	});

	// The mock fs is compatible with FileSystem at runtime; cast for the DI signature.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const fs = f as any;

	return {
		options: { ...options, ...overrides, macos: undefined },
		fs,
		exec,
		restorePlatform: () => {
			Object.defineProperty(process, "platform", {
				value: originalPlatform,
				configurable: true,
			});
		},
	};
}

// ---- Tests ----

describe("service install", () => {
	it("writes plist on macOS and loads via launchctl", async () => {
		const { options, fs, exec, restorePlatform } = makeOptions({ macos: true });

		const result = await runServiceCommand(["install"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("service installed and started");
		expect(result.stdout).toContain("LaunchAgents/com.quilin.agent.plist");

		expect(fs.mkdir).toHaveBeenCalledWith("/home/user/.quilin/logs", {
			recursive: true,
		});
		expect(fs.writeFile).toHaveBeenCalledTimes(1);

		const writeCall = fs.writeFile.mock.calls[0];
		const filePath: string = writeCall[0];
		const content: string = writeCall[1];
		expect(filePath).toContain("LaunchAgents/com.quilin.agent.plist");
		expect(content).toContain("<plist");
		expect(content).toContain("com.quilin.agent");
		expect(content).toContain("/usr/local/bin/quilin");
		expect(content).toContain("QUILIN_RUNTIME_MODE");
		expect(content).toContain("service");

		expect(exec).toHaveBeenCalledWith("launchctl", ["load", filePath], {
			stdio: "ignore",
		});

		restorePlatform();
	});

	it("writes systemd unit on Linux and enables/starts", async () => {
		const { options, fs, exec } = makeOptions();

		const result = await runServiceCommand(["install"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("service installed and started");

		expect(fs.writeFile).toHaveBeenCalledTimes(1);
		const content: string = fs.writeFile.mock.calls[0][1];
		expect(content).toContain("[Unit]");
		expect(content).toContain("Description=Quilin Agent");
		expect(content).toContain("ExecStart=/usr/local/bin/quilin");
		expect(content).toContain("QUILIN_RUNTIME_MODE=service");
		expect(content).toContain("Restart=on-failure");
		expect(content).toContain("WantedBy=default.target");

		expect(exec).toHaveBeenCalledWith(
			"systemctl",
			["--user", "daemon-reload"],
			{ stdio: "ignore" },
		);
		expect(exec).toHaveBeenCalledWith(
			"systemctl",
			["--user", "enable", "com.quilin.agent"],
			{ stdio: "ignore" },
		);
		expect(exec).toHaveBeenCalledWith(
			"systemctl",
			["--user", "start", "com.quilin.agent"],
			{ stdio: "ignore" },
		);
	});

	it("skips when service is already installed", async () => {
		const { options, fs, exec } = makeOptions();

		// Pre-install the service file
		await fs.writeFile(__testing.serviceFilePath("linux"), "fake-unit");
		// Reset mock call history so the pre-install write doesn't confuse assertions.
		fs.writeFile.mockClear();

		const result = await runServiceCommand(["install"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("already installed");
		expect(fs.writeFile).not.toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalled();
	});

	it("rejects unsupported OS", async () => {
		const { options, fs, restorePlatform } = makeOptions({ macos: true });

		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});

		const result = await runServiceCommand(["install"], options, fs);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/unsupported OS/);

		restorePlatform();
	});
});

describe("service uninstall", () => {
	it("unloads and removes plist on macOS", async () => {
		const { options, fs, exec, restorePlatform } = makeOptions({ macos: true });

		// Pre-install
		const filePath = __testing.plistPath();
		await fs.writeFile(filePath, "fake-plist");

		const result = await runServiceCommand(["uninstall"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("service removed");

		expect(exec).toHaveBeenCalledWith("launchctl", ["unload", filePath], {
			stdio: "ignore",
		});
		expect(fs.unlink).toHaveBeenCalledWith(filePath);

		restorePlatform();
	});

	it("stops, disables, and removes systemd unit on Linux", async () => {
		const { options, fs, exec } = makeOptions();

		const filePath = __testing.systemdUnitPath();
		await fs.writeFile(filePath, "fake-unit");

		const result = await runServiceCommand(["uninstall"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("service removed");

		expect(exec).toHaveBeenCalledWith(
			"systemctl",
			["--user", "stop", "com.quilin.agent"],
			{ stdio: "ignore" },
		);
		expect(exec).toHaveBeenCalledWith(
			"systemctl",
			["--user", "disable", "com.quilin.agent"],
			{ stdio: "ignore" },
		);
		expect(fs.unlink).toHaveBeenCalledWith(filePath);
	});

	it("reports not-installed when service file is missing", async () => {
		const { options, fs, exec } = makeOptions();

		const result = await runServiceCommand(["uninstall"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("not installed");
		expect(exec).not.toHaveBeenCalled();
		expect(fs.unlink).not.toHaveBeenCalled();
	});

	it("rejects unsupported OS", async () => {
		const { options, fs, restorePlatform } = makeOptions({ macos: true });

		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});

		const result = await runServiceCommand(["uninstall"], options, fs);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/unsupported OS/);

		restorePlatform();
	});
});

describe("service status", () => {
	it("shows active status on macOS via launchctl list", async () => {
		const { options, fs, exec, restorePlatform } = makeOptions({ macos: true });

		const filePath = __testing.plistPath();
		await fs.writeFile(filePath, "fake-plist");
		exec.mockReturnValue("12345\t0\tcom.quilin.agent\n");

		const result = await runServiceCommand(["status"], options, fs);
		expect(result.exitCode).toBe(0);
		// macOS output includes PID\tstatus\tlabel
		expect(result.stdout).toContain("12345");
		expect(result.stdout).toContain(filePath);

		expect(exec).toHaveBeenCalledWith(
			"launchctl",
			["list", "com.quilin.agent"],
			expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
		);

		restorePlatform();
	});

	it("shows active status on Linux via systemctl is-active", async () => {
		const { options, fs, exec } = makeOptions();

		const filePath = __testing.systemdUnitPath();
		await fs.writeFile(filePath, "fake-unit");
		exec.mockReturnValue("active\n");

		const result = await runServiceCommand(["status"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("active");
		expect(result.stdout).toContain(filePath);

		expect(exec).toHaveBeenCalledWith(
			"systemctl",
			["--user", "is-active", "com.quilin.agent"],
			expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
		);
	});

	it("shows not installed when file is missing", async () => {
		const { options, fs, exec } = makeOptions();

		const result = await runServiceCommand(["status"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("not installed");
		expect(exec).not.toHaveBeenCalled();
	});

	it("handles launchctl error gracefully", async () => {
		const { options, fs, exec, restorePlatform } = makeOptions({ macos: true });

		const filePath = __testing.plistPath();
		await fs.writeFile(filePath, "fake-plist");
		exec.mockImplementation(() => {
			throw new Error("launchctl: command not found");
		});

		const result = await runServiceCommand(["status"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("inactive");

		restorePlatform();
	});

	it("rejects unsupported OS", async () => {
		const { options, fs, restorePlatform } = makeOptions({ macos: true });

		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});

		const result = await runServiceCommand(["status"], options, fs);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/unsupported OS/);

		restorePlatform();
	});
});

describe("service help", () => {
	it("prints help on no subcommand with exit 2", async () => {
		const { options, fs } = makeOptions();
		const result = await runServiceCommand([], options, fs);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/quilin service install/);
	});

	it("prints help on `help` with exit 0", async () => {
		const { options, fs } = makeOptions();
		const result = await runServiceCommand(["help"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toMatch(/quilin service uninstall/);
		expect(result.stderr).toMatch(/macOS/);
		expect(result.stderr).toMatch(/Linux/);
	});

	it("prints help on `--help` with exit 0", async () => {
		const { options, fs } = makeOptions();
		const result = await runServiceCommand(["--help"], options, fs);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toMatch(/LaunchAgents/);
	});

	it("rejects unknown subcommand", async () => {
		const { options, fs } = makeOptions();
		const result = await runServiceCommand(["bogus"], options, fs);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/unknown service subcommand/);
	});
});

describe("templates", () => {
	it("plistTemplate embeds quilin path and log paths", () => {
		const tpl = __testing.plistTemplate("/opt/quilin", "/var/log/quilin");
		expect(tpl).toContain("<string>/opt/quilin</string>");
		expect(tpl).toContain("<string>/var/log/quilin/agent.log</string>");
		expect(tpl).toContain("<string>/var/log/quilin/agent-error.log</string>");
		expect(tpl).toContain("<key>QUILIN_RUNTIME_MODE</key>");
		expect(tpl).toContain("<string>service</string>");
	});

	it("systemdUnitTemplate embeds quilin path and log paths", () => {
		const tpl = __testing.systemdUnitTemplate("/opt/quilin", "/var/log/quilin");
		expect(tpl).toContain("ExecStart=/opt/quilin");
		expect(tpl).toContain("QUILIN_RUNTIME_MODE=service");
		expect(tpl).toContain("file:/var/log/quilin/agent.log");
		expect(tpl).toContain("file:/var/log/quilin/agent-error.log");
		expect(tpl).toContain("Restart=on-failure");
		expect(tpl).toContain("RestartSec=5");
	});
});

describe("resolveQuilinPath", () => {
	it("uses provided quilinPath option", () => {
		expect(
			__testing.resolveQuilinPath({ quilinPath: "/custom/quilin" }),
		).toBe("/custom/quilin");
	});

	it("falls back to process.execPath when no option given", () => {
		expect(__testing.resolveQuilinPath({})).toBe(process.execPath);
	});
});

describe("serviceFilePath", () => {
	it("returns plist path for macOS", () => {
		const p = __testing.serviceFilePath("macos");
		expect(p).toContain("Library/LaunchAgents/com.quilin.agent.plist");
	});

	it("returns systemd path for Linux", () => {
		const p = __testing.serviceFilePath("linux");
		expect(p).toContain(".config/systemd/user/com.quilin.agent.service");
	});

	it("throws for unsupported", () => {
		expect(() => __testing.serviceFilePath("unsupported")).toThrow();
	});
});
