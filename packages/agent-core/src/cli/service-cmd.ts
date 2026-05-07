// CLI entry for `quilin service install / uninstall / status`.
// Pure TS argv parser; no external CLI library.

import { execFileSync } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const LABEL = "com.quilin.agent";
const LOG_DIR = path.join(homedir(), ".quilin", "logs");

export interface ServiceCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ServiceCommandOptions {
	readonly quilinPath?: string;
	readonly logDir?: string;
	readonly macos?: boolean;
	readonly execFileSync?: typeof import("node:child_process").execFileSync;
}

export interface FileSystem {
	readonly access: (filePath: string, mode?: number) => Promise<void>;
	readonly mkdir: (
		dirPath: string,
		opts?: { recursive: boolean },
	) => Promise<string | undefined>;
	readonly writeFile: (
		filePath: string,
		data: string,
		opts?: { mode: number },
	) => Promise<void>;
	readonly unlink: (filePath: string) => Promise<void>;
	readonly readFile: (
		filePath: string,
		encoding: BufferEncoding,
	) => Promise<string>;
}

const defaultFs: FileSystem = {
	access: (filePath: string, mode?: number) => fs.access(filePath, mode),
	mkdir: (dirPath: string, opts?: { recursive: boolean }) =>
		fs.mkdir(dirPath, opts),
	writeFile: (filePath: string, data: string, opts?: { mode: number }) =>
		fs.writeFile(filePath, data, opts),
	unlink: (filePath: string) => fs.unlink(filePath),
	readFile: (filePath: string, encoding: BufferEncoding) =>
		fs.readFile(filePath, encoding) as Promise<string>,
};

export async function runServiceCommand(
	argv: readonly string[],
	options: ServiceCommandOptions = {},
	fs_: FileSystem = defaultFs,
): Promise<ServiceCommandResult> {
	const subcommand = argv[0];

	if (subcommand === "install") {
		return runInstall(options, fs_);
	}
	if (subcommand === "uninstall") {
		return runUninstall(options, fs_);
	}
	if (subcommand === "status") {
		return runStatus(options, fs_);
	}
	if (subcommand == null || subcommand === "help" || subcommand === "--help") {
		return {
			exitCode: subcommand == null ? 2 : 0,
			stdout: "",
			stderr: helpText(),
		};
	}
	return {
		exitCode: 2,
		stdout: "",
		stderr: `unknown service subcommand: ${subcommand}\n${helpText()}`,
	};
}

function helpText(): string {
	return [
		"Usage:",
		"  quilin service install    Install OS auto-start service",
		"  quilin service uninstall  Remove OS auto-start service",
		"  quilin service status     Show service status",
		"",
		"macOS  -> ~/Library/LaunchAgents/com.quilin.agent.plist (launchd)",
		"Linux  -> ~/.config/systemd/user/quilin-agent.service (systemd --user)",
	].join("\n");
}

// ---- OS detection ----

type OsKind = "macos" | "linux" | "unsupported";

function detectOs(): OsKind {
	const p = platform();
	if (p === "darwin") return "macos";
	if (p === "linux") return "linux";
	return "unsupported";
}

// ---- Path resolution ----

function resolveQuilinPath(options: ServiceCommandOptions): string {
	if (options.quilinPath) return options.quilinPath;
	// process.execPath is the running Node/Bun binary; when quilin is installed
	// globally, this is the quilin wrapper script or the actual entry point.
	return process.execPath;
}

function resolveLogDir(options: ServiceCommandOptions): string {
	return options.logDir ?? LOG_DIR;
}

function plistPath(): string {
	return path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function systemdUnitPath(): string {
	return path.join(
		homedir(),
		".config",
		"systemd",
		"user",
		`${LABEL}.service`,
	);
}

function serviceFilePath(osKind: OsKind): string {
	if (osKind === "macos") return plistPath();
	if (osKind === "linux") return systemdUnitPath();
	throw new Error(`unsupported OS for service: ${platform()}`);
}

// ---- Template builders ----

function plistTemplate(quilinPath: string, logDir: string): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
		'  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		`    <key>Label</key><string>${LABEL}</string>`,
		"    <key>ProgramArguments</key>",
		`    <array><string>${quilinPath}</string></array>`,
		"    <key>RunAtLoad</key><true/>",
		"    <key>KeepAlive</key><true/>",
		`    <key>StandardOutPath</key><string>${path.join(logDir, "agent.log")}</string>`,
		`    <key>StandardErrorPath</key><string>${path.join(logDir, "agent-error.log")}</string>`,
		"    <key>EnvironmentVariables</key>",
		"    <dict><key>QUILIN_RUNTIME_MODE</key><string>service</string></dict>",
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

function systemdUnitTemplate(quilinPath: string, logDir: string): string {
	return [
		"[Unit]",
		"Description=Quilin Agent",
		"After=network-online.target",
		"",
		"[Service]",
		`ExecStart=${quilinPath}`,
		"Environment=QUILIN_RUNTIME_MODE=service",
		"Restart=on-failure",
		"RestartSec=5",
		`StandardOutput=file:${path.join(logDir, "agent.log")}`,
		`StandardError=file:${path.join(logDir, "agent-error.log")}`,
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

// ---- Service exist check ----

async function serviceFileExists(
	osKind: OsKind,
	fs_: FileSystem,
): Promise<boolean> {
	try {
		await fs_.access(serviceFilePath(osKind), constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

// ---- install ----

async function runInstall(
	options: ServiceCommandOptions,
	fs_: FileSystem,
): Promise<ServiceCommandResult> {
	const osKind = detectOs();
	if (osKind === "unsupported") {
		return {
			exitCode: 1,
			stdout: "",
			stderr: `error: unsupported OS "${platform()}" for service installation\n`,
		};
	}

	const filePath = serviceFilePath(osKind);
	const quilinPath = resolveQuilinPath(options);
	const logDir = resolveLogDir(options);

	if (await serviceFileExists(osKind, fs_)) {
		return {
			exitCode: 0,
			stdout: `service already installed at ${filePath}\n`,
			stderr: "",
		};
	}

	// Ensure log directory exists
	await fs_.mkdir(logDir, { recursive: true });

	// Write service file
	const content =
		osKind === "macos"
			? plistTemplate(quilinPath, logDir)
			: systemdUnitTemplate(quilinPath, logDir);
	await fs_.writeFile(filePath, content, { mode: 0o644 });

	// Activate the service
	if (osKind === "macos") {
		runExec("launchctl", ["load", filePath], options);
	} else {
		runExec("systemctl", ["--user", "daemon-reload"], options);
		runExec("systemctl", ["--user", "enable", LABEL], options);
		runExec("systemctl", ["--user", "start", LABEL], options);
	}

	return {
		exitCode: 0,
		stdout: `service installed and started: ${filePath}\n`,
		stderr: "",
	};
}

// ---- uninstall ----

async function runUninstall(
	options: ServiceCommandOptions,
	fs_: FileSystem,
): Promise<ServiceCommandResult> {
	const osKind = detectOs();
	if (osKind === "unsupported") {
		return {
			exitCode: 1,
			stdout: "",
			stderr: `error: unsupported OS "${platform()}" for service uninstallation\n`,
		};
	}

	const filePath = serviceFilePath(osKind);

	if (!(await serviceFileExists(osKind, fs_))) {
		return {
			exitCode: 0,
			stdout: "service is not installed\n",
			stderr: "",
		};
	}

	// Deactivate the service
	if (osKind === "macos") {
		runExec("launchctl", ["unload", filePath], options);
	} else {
		runExec("systemctl", ["--user", "stop", LABEL], options);
		runExec("systemctl", ["--user", "disable", LABEL], options);
	}

	await fs_.unlink(filePath);

	return {
		exitCode: 0,
		stdout: `service removed: ${filePath}\n`,
		stderr: "",
	};
}

// ---- status ----

async function runStatus(
	options: ServiceCommandOptions,
	fs_: FileSystem,
): Promise<ServiceCommandResult> {
	const osKind = detectOs();
	if (osKind === "unsupported") {
		return {
			exitCode: 1,
			stdout: "",
			stderr: `error: unsupported OS "${platform()}" for service status\n`,
		};
	}

	const filePath = serviceFilePath(osKind);
	const installed = await serviceFileExists(osKind, fs_);

	if (!installed) {
		return {
			exitCode: 0,
			stdout: "service status: not installed\n",
			stderr: "",
		};
	}

	let statusLine: string;
	try {
		if (osKind === "macos") {
			statusLine = runExecCapture(
				"launchctl",
				["list", LABEL],
				options,
			);
		} else {
			statusLine = runExecCapture(
				"systemctl",
				["--user", "is-active", LABEL],
				options,
			).trim();
		}
	} catch {
		statusLine = "inactive / not loaded";
	}

	return {
		exitCode: 0,
		stdout: [
			`service status: ${statusLine}`,
			`  file: ${filePath}`,
			"",
		].join("\n"),
		stderr: "",
	};
}

// ---- Shell helpers ----

function runExec(
	command: string,
	args: readonly string[],
	options: ServiceCommandOptions,
): void {
	const exec = options.execFileSync ?? execFileSync;
	exec(command, args, { stdio: "ignore" });
}

function runExecCapture(
	command: string,
	args: readonly string[],
	options: ServiceCommandOptions,
): string {
	const exec = options.execFileSync ?? execFileSync;
	return exec(command, args, { encoding: "utf8", stdio: "pipe" }).toString();
}

// ---- Testing exports ----

export const __testing = {
	detectOs,
	resolveQuilinPath,
	resolveLogDir,
	plistPath,
	systemdUnitPath,
	serviceFilePath,
	plistTemplate,
	systemdUnitTemplate,
	serviceFileExists,
	helpText,
	LABEL,
};
