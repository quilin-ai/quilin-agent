import {
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
	type FileReadToolOptions,
} from "./file-tools.js";
import {
	createShellExecTool,
	type ShellExecToolOptions,
} from "./shell-exec.js";
import { createWebFetchTool, type WebFetchToolOptions } from "./web-fetch.js";
import type { WriteAuthority } from "../../safety/write-authority.js";
import type { ToolWithMetadata } from "../tool-metadata.js";

export interface BuiltinToolOptions {
	readonly fileRead?: FileReadToolOptions;
	readonly shellExec?: ShellExecToolOptions;
	readonly webFetch?: WebFetchToolOptions;
	readonly writeAuthority?: WriteAuthority;
}

export function createBuiltinTools(
	options: BuiltinToolOptions = {},
): ToolWithMetadata[] {
	return [
		createFileReadTool(options.fileRead),
		createFileWriteTool(),
		createFileListTool(),
		createShellExecTool({
			...options.shellExec,
			authority: options.writeAuthority ?? options.shellExec?.authority,
		}),
		createWebFetchTool(options.webFetch),
	];
}

export {
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
	createShellExecTool,
	createWebFetchTool,
};
