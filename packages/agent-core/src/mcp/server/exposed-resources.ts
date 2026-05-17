/**
 * Stage 3 (Quilin-as-server) resource whitelist.
 *
 * MCP resources are read-only addressable blobs identified by a URI.
 * Stage 3 exposes three: user profile, skill index, recent session
 * summaries. Anything else returns `unknown_resource` — same
 * "no-throw" convention as `exposed-tools.ts`.
 *
 * Stage 3（Quilin-as-server）的资源白名单。
 *
 * MCP resource 是用 URI 寻址的只读内容。Stage 3 暴露三个：用户档案、
 * skill 索引、最近 session 摘要。其它一律返回 `unknown_resource` ——
 * 与 `exposed-tools.ts` 同样的"不抛异常"约定。
 *
 * See `docs/research/2026-05-18-quilin-as-server/README.md` § 2.2.
 */

import type {
	ReadResourceResult,
	Resource,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * URIs of resources exposed to peer MCP clients in Stage 3.
 *
 * Stage 3 暴露给 peer MCP client 的资源 URI。
 */
export const EXPOSED_RESOURCE_URIS = [
	"quilin://profile",
	"quilin://skills",
	"quilin://recent-sessions",
] as const;

export type ExposedResourceUri = (typeof EXPOSED_RESOURCE_URIS)[number];

/**
 * Resource descriptors advertised via `list_resources`.
 *
 * 通过 `list_resources` 公布的资源描述。
 */
export const EXPOSED_RESOURCE_DESCRIPTORS: Readonly<
	Record<ExposedResourceUri, Resource>
> = Object.freeze({
	"quilin://profile": {
		uri: "quilin://profile",
		name: "User profile",
		description:
			"Redacted body of ~/.quilin/user.md — who this user is, in markdown.",
		mimeType: "text/markdown",
	},
	"quilin://skills": {
		uri: "quilin://skills",
		name: "Installed skills index",
		description:
			"Markdown index of installed Quilin skills (name + description + path).",
		mimeType: "text/markdown",
	},
	"quilin://recent-sessions": {
		uri: "quilin://recent-sessions",
		name: "Recent session summaries",
		description:
			"Last N session summaries (count bounded by env QUILIN_MCP_SERVER_RECENT_SESSIONS, default 5).",
		mimeType: "text/markdown",
	},
});

/**
 * Pluggable bridge to real Quilin resource sources. The skeleton ships
 * a mock implementation so tests can run without filesystem or
 * `quilin-mem`. Stage 3.1 wires the real readers.
 *
 * 可注入的资源源桥接。骨架自带 mock 实现，测试不依赖文件系统或
 * `quilin-mem`。Stage 3.1 接真实读取器。
 */
export interface ResourceBridge {
	readonly readResource: (
		uri: ExposedResourceUri,
	) => Promise<ReadResourceResult>;
}

/**
 * Deterministic mock `ResourceBridge` for tests and local dev. Each
 * resource returns a tiny markdown stub naming itself.
 *
 * 确定性 mock `ResourceBridge`，给测试和本地开发用。每个 resource
 * 回小段 markdown 标识自己。
 */
export function createMockResourceBridge(): ResourceBridge {
	return {
		readResource: async (uri) => ({
			contents: [
				{
					uri,
					mimeType: "text/markdown",
					text: `# mock resource: ${uri}\n\nReplaced in Stage 3.1.\n`,
				},
			],
		}),
	};
}

/**
 * Type guard: is `uri` on the exposed resource whitelist?
 *
 * 类型守卫：`uri` 是否在资源白名单上？
 */
export function isExposedResourceUri(uri: string): uri is ExposedResourceUri {
	return (EXPOSED_RESOURCE_URIS as readonly string[]).includes(uri);
}
