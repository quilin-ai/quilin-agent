/**
 * 远程 Skill 条目 / Remote Skill Entry
 *
 * Represents a skill available in the remote skills.sh marketplace.
 * 表示远程 skills.sh 市场中可用的 skill。
 */
export interface RemoteSkillEntry {
	readonly name: string;
	readonly description: string;
	readonly downloadUrl: string;
}

/**
 * Skills 远程注册中心 / Skills Remote Registry
 *
 * Searches and fetches skill manifests from the remote skills.sh API
 * (https://skills.sh). Provides a lightweight client for the public
 * skill marketplace, complementary to the local SkillsManager catalog.
 *
 * 从远程 skills.sh API 搜索和获取 skill 清单。为公共 skill 市场提供
 * 轻量客户端，与本地 SkillsManager 目录互补。
 */
export class SkillsRemoteRegistry {
	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;

	constructor(
		options: {
			readonly baseUrl?: string;
			readonly fetchFn?: typeof fetch;
		} = {},
	) {
		this.baseUrl = options.baseUrl ?? "https://skills.sh/api";
		this.fetchFn = options.fetchFn ?? fetch;
	}

	/**
	 * 搜索远程 Skill 市场 / Search remote skill marketplace
	 *
	 * Queries the skills.sh search API for skills matching the given query.
	 * Returns an array of RemoteSkillEntry with name, description, and download URL.
	 *
	 * 查询 skills.sh 搜索 API，返回匹配的 RemoteSkillEntry 数组，
	 * 包含 name、description 和 download URL。
	 */
	async search(query: string): Promise<readonly RemoteSkillEntry[]> {
		const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
		const response = await this.fetchFn(url);

		if (!response.ok) {
			throw new Error(
				`Skills remote registry search failed: HTTP ${response.status}`,
			);
		}

		const data: unknown = await response.json();
		return this.normalizeSearchResults(data);
	}

	/**
	 * 获取远程 Skill 清单 / Get remote skill manifest
	 *
	 * Fetches the full manifest/details for a specific skill by its ID.
	 * Returns a single RemoteSkillEntry or null if not found.
	 *
	 * 根据 ID 获取特定 skill 的完整清单/详情。返回单个 RemoteSkillEntry，
	 * 如果未找到则返回 null。
	 */
	async getManifest(id: string): Promise<RemoteSkillEntry | null> {
		const url = `${this.baseUrl}/skills/${encodeURIComponent(id)}`;
		const response = await this.fetchFn(url);

		if (response.status === 404) {
			return null;
		}

		if (!response.ok) {
			throw new Error(
				`Skills remote registry getManifest failed: HTTP ${response.status}`,
			);
		}

		const data: unknown = await response.json();
		return this.normalizeManifestEntry(data);
	}

	/**
	 * Normalize raw API search response to RemoteSkillEntry array.
	 * Handles both array responses and { results: [...] } envelope.
	 */
	private normalizeSearchResults(
		data: unknown,
	): readonly RemoteSkillEntry[] {
		if (Array.isArray(data)) {
			return data
				.map((item) => this.normalizeManifestEntry(item))
				.filter((entry): entry is RemoteSkillEntry => entry != null);
		}

		if (
			typeof data === "object" &&
			data != null &&
			"results" in data &&
			Array.isArray((data as Record<string, unknown>).results)
		) {
			return (
				(data as Record<string, unknown>).results as unknown[]
			)
				.map((item) => this.normalizeManifestEntry(item))
				.filter((entry): entry is RemoteSkillEntry => entry != null);
		}

		return [];
	}

	/**
	 * Normalize a single raw API entry to RemoteSkillEntry.
	 * Returns null if required fields are missing.
	 */
	private normalizeManifestEntry(item: unknown): RemoteSkillEntry | null {
		if (typeof item !== "object" || item == null) {
			return null;
		}

		const obj = item as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		const description =
			typeof obj.description === "string" ? obj.description.trim() : "";
		const downloadUrl =
			typeof obj.downloadUrl === "string"
				? obj.downloadUrl
				: typeof obj.download_url === "string"
					? obj.download_url
					: typeof obj.url === "string"
						? obj.url
						: "";

		if (name.length === 0) {
			return null;
		}

		return {
			name,
			description: description.length > 0 ? description : name,
			downloadUrl: downloadUrl.length > 0 ? downloadUrl : "",
		};
	}
}
