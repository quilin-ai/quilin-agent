/**
 * Barrel for the Quilin-as-server module (Stage 3 skeleton).
 *
 * Quilin-as-server 模块（Stage 3 骨架）的 barrel。
 */

export {
	createMockResourceBridge,
	EXPOSED_RESOURCE_DESCRIPTORS,
	EXPOSED_RESOURCE_URIS,
	type ExposedResourceUri,
	isExposedResourceUri,
	type ResourceBridge,
} from "./exposed-resources.js";
export {
	createMockToolBridge,
	createUnknownToolResult,
	EXPOSED_TOOL_DESCRIPTORS,
	EXPOSED_TOOL_NAMES,
	type ExposedToolName,
	isExposedToolName,
	type ToolBridge,
} from "./exposed-tools.js";
export {
	QuilinMcpServer,
	type QuilinMcpServerOptions,
	runQuilinMcpServerOnStdio,
} from "./quilin-mcp-server.js";
