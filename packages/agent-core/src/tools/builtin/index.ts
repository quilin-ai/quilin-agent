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
import {
	createAudioTranscribeTool,
	createImageDescribeTool,
	createVideoSummarizeTool,
	type AudioTranscribeToolOptions,
	type ImageDescribeToolOptions,
	type VideoSummarizeToolOptions,
} from "./multimodal.js";
import {
	type ConfigViewToolOptions,
	type SessionListToolOptions,
	type ToolSearchToolOptions,
	createConfigViewTool,
	createSessionListTool,
	createToolSearchTool,
} from "./config-session-tools.js";
import { createMcpSearchTool } from "../mcp-marketplace.js";
import {
	type SubagentSpawnToolOptions,
	createSubagentSpawnTool,
	createSubagentStatusTool,
} from "./subagent-spawn.js";

export interface BuiltinToolOptions {
	readonly fileRead?: FileReadToolOptions;
	readonly fileWrite?: FileWriteToolOptions;
	readonly fileList?: FileListToolOptions;
	readonly shellExec?: ShellExecToolOptions;
	readonly webFetch?: WebFetchToolOptions;
	readonly imageDescribe?: ImageDescribeToolOptions;
	readonly videoSummarize?: VideoSummarizeToolOptions;
	readonly audioTranscribe?: AudioTranscribeToolOptions;
	readonly writeAuthority?: WriteAuthority;
	readonly skillsManager?: SkillsManager;
	readonly skillSearch?: Omit<SkillSearchToolOptions, "skillsManager">;
	readonly skillView?: Omit<SkillViewToolOptions, "skillsManager">;
	readonly skillManage?: Omit<
		SkillManageToolOptions,
		"skillsManager" | "writeAuthority"
	>;
	readonly subagentSpawn?: SubagentSpawnToolOptions;
	readonly configView?: ConfigViewToolOptions;
	readonly sessionList?: SessionListToolOptions;
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
		createImageDescribeTool(options.imageDescribe),
		createVideoSummarizeTool(options.videoSummarize),
		createAudioTranscribeTool(options.audioTranscribe),
		...(options.subagentSpawn != null ? [createSubagentSpawnTool(options.subagentSpawn)] : []),
		createSubagentStatusTool(),
		createConfigViewTool(options.configView ?? { getRuntimeState: () => null }),
		createSessionListTool(options.sessionList),
		createToolSearchTool({ getTools: () => [] }),
		createMcpSearchTool(),
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
	AudioTranscribeToolOptions,
	FileListToolOptions,
	FileReadToolOptions,
	FileWriteToolOptions,
	ImageDescribeToolOptions,
	ShellExecToolOptions,
	SkillManageToolOptions,
	SkillSearchToolOptions,
	SkillViewToolOptions,
	VideoSummarizeToolOptions,
	WebFetchToolOptions,
};

export {
	createAudioTranscribeTool,
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
	createImageDescribeTool,
	createShellExecTool,
	createSkillManageTool,
	createSkillSearchTool,
	createSkillViewTool,
	createVideoSummarizeTool,
	createWebFetchTool,
};
