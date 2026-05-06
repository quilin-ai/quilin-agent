import type { WriteAuthority } from "../../safety/write-authority.js";
import type { SkillsManager } from "../../skills/manager.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import {
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
	type FileListToolOptions,
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
import {
	createSkillSearchTool,
	type SkillSearchToolOptions,
} from "./skill-search.js";
import {
	createSkillViewTool,
	type SkillViewToolOptions,
} from "./skill-view.js";
import { createWebFetchTool, type WebFetchToolOptions } from "./web-fetch.js";

export interface BuiltinToolOptions {
	readonly fileRead?: FileReadToolOptions;
	readonly fileWrite?: FileWriteToolOptions;
	readonly fileList?: FileListToolOptions;
	readonly shellExec?: ShellExecToolOptions;
	readonly webFetch?: WebFetchToolOptions;
	readonly writeAuthority?: WriteAuthority;
	readonly skillsManager?: SkillsManager;
	readonly skillSearch?: Omit<SkillSearchToolOptions, "skillsManager">;
	readonly skillView?: Omit<SkillViewToolOptions, "skillsManager">;
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
		createFileListTool(options.fileList),
		createShellExecTool({
			...options.shellExec,
			authority: options.writeAuthority ?? options.shellExec?.authority,
		}),
		createWebFetchTool(options.webFetch),
		createSkillSearchTool({
			skillsManager: options.skillsManager,
			...options.skillSearch,
		}),
	];

	if (options.skillsManager != null) {
		tools.push(
			createSkillViewTool({
				skillsManager: options.skillsManager,
				...options.skillView,
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

export type {
	FileListToolOptions,
	FileReadToolOptions,
	FileWriteToolOptions,
	ShellExecToolOptions,
	SkillManageToolOptions,
	SkillSearchToolOptions,
	SkillViewToolOptions,
	WebFetchToolOptions,
};

export {
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
	createShellExecTool,
	createSkillManageTool,
	createSkillSearchTool,
	createSkillViewTool,
	createWebFetchTool,
};
