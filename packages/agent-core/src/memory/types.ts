export type MemoryLayer = "working" | "episodic" | "semantic" | "skill";

export type MemoryMetadataValue =
	| string
	| number
	| boolean
	| null
	| ReadonlyArray<MemoryMetadataValue>
	| { readonly [key: string]: MemoryMetadataValue };

export interface MemoryMetadata {
	readonly schema_version: number;
	readonly source?: string;
	readonly score?: number;
	readonly staleness?: string;
	readonly [key: string]: MemoryMetadataValue | undefined;
}

export interface MemoryItem {
	readonly id: string;
	readonly content: string;
	readonly content_type: string;
	readonly layer: MemoryLayer;
	readonly metadata: MemoryMetadata;
	readonly embedding: ReadonlyArray<number> | null;
	readonly created_at: string;
	readonly last_accessed: string;
	readonly access_count: number;
	readonly importance_score: number;
}
