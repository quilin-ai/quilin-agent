import {
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
	type FileReadToolOptions,
	type FileWriteToolOptions,
} from "./file-tools.js";
import {
	createShellExecTool,
	type ShellExecToolOptions,
} from "./shell-exec.js";
import {
	createSkillManageTool,
	type SkillManageToolOptions,
} from "./skill-manage.js";
import { createSkillViewTool } from "./skill-view.js";
import { createWebFetchTool, type WebFetchToolOptions } from "./web-fetch.js";
import type { WriteAuthority } from "../../safety/write-authority.js";
import type { SkillsManager } from "../../skills/manager.js";
import type { ToolWithMetadata } from "../tool-metadata.js";

export interface BuiltinToolOptions {
	readonly fileRead?: FileReadToolOptions;
	readonly fileWrite?: FileWriteToolOptions;
	readonly shellExec?: ShellExecToolOptions;
	readonly webFetch?: WebFetchToolOptions;
	readonly writeAuthority?: WriteAuthority;
	readonly skillsManager?: SkillsManager;
	readonly skillManage?: Omit<
		SkillManageToolOptions,
		"skillsManager" | "writeAuthority"
	>;
}

export function createBuiltinTools(
	options: BuiltinToolOptions = {},
): ToolWithMetadata[] {
	const tools: ToolWithMetadata[] = [
		createFileReadTool(options.fileRead),
		createFileWriteTool({
			...options.fileWrite,
			authority: options.writeAuthority ?? options.fileWrite?.authority,
		}),
		createFileListTool(),
		createShellExecTool({
			...options.shellExec,
			authority: options.writeAuthority ?? options.shellExec?.authority,
		}),
		createWebFetchTool(options.webFetch),
	];

	if (options.skillsManager != null) {
		tools.push(
			createSkillViewTool({
				skillsManager: options.skillsManager,
			}),
		);
		if (options.writeAuthority != null) {
			tools.push(
				createSkillManageTool({
					skillsManager: options.skillsManager,
					writeAuthority: options.writeAuthority,
					...options.skillManage,
				}),
			);
		}
	}

	return tools;
}

export {
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
	createShellExecTool,
	createSkillManageTool,
	createSkillViewTool,
	createWebFetchTool,
};
