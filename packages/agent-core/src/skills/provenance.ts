import { createHash } from "node:crypto";
import type {
	SkillContentDigest,
	SkillDescriptor,
	SkillProvenanceReceipt,
} from "./types.js";

export interface CreateSkillProvenanceReceiptOptions {
	readonly descriptor: SkillDescriptor;
	readonly content: string | Buffer;
	readonly generatedAt?: string;
}

export interface ValidateSkillProvenanceReceiptOptions {
	readonly descriptor: SkillDescriptor;
	readonly provenance: SkillProvenanceReceipt;
	readonly content: string | Buffer;
}

export type SkillProvenanceValidationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly detail: string };

export function createSkillContentDigest(
	content: string | Buffer,
): SkillContentDigest {
	return {
		algorithm: "sha256",
		value: createHash("sha256").update(content).digest("hex"),
	};
}

export function createSkillProvenanceReceipt(
	options: CreateSkillProvenanceReceiptOptions,
): SkillProvenanceReceipt {
	const receipt: SkillProvenanceReceipt = {
		schemaVersion: "quilin.skill_provenance.v1",
		skillName: options.descriptor.name,
		skillVersion: options.descriptor.frontmatter.version,
		source: options.descriptor.source,
		path: options.descriptor.path,
		digest: createSkillContentDigest(options.content),
		sizeBytes: Buffer.byteLength(options.content),
		generatedAt: options.generatedAt,
	};

	return receipt;
}

export function validateSkillProvenanceReceipt(
	options: ValidateSkillProvenanceReceiptOptions,
): SkillProvenanceValidationResult {
	const { content, descriptor, provenance } = options;
	const mismatches: string[] = [];
	const digestAlgorithm = provenance.digest?.algorithm;
	const digestValue = provenance.digest?.value;
	const compare = (
		field: string,
		expected: string | undefined,
		actual: string | undefined,
	): void => {
		if (actual !== expected) {
			mismatches.push(
				`${field} expected ${expected ?? "<unset>"} but received ${actual ?? "<unset>"}`,
			);
		}
	};

	if (provenance.schemaVersion !== "quilin.skill_provenance.v1") {
		mismatches.push(
			`schemaVersion expected quilin.skill_provenance.v1 but received ${provenance.schemaVersion}`,
		);
	}
	compare("skillName", descriptor.name, provenance.skillName);
	compare(
		"skillVersion",
		descriptor.frontmatter.version,
		provenance.skillVersion,
	);
	compare("source", descriptor.source, provenance.source);
	compare("path", descriptor.path, provenance.path);

	if (digestAlgorithm !== "sha256") {
		mismatches.push(
			`digest.algorithm expected sha256 but received ${digestAlgorithm ?? "<unset>"}`,
		);
	}
	if (typeof digestValue !== "string" || !/^[a-f0-9]{64}$/u.test(digestValue)) {
		mismatches.push("digest.value must be a lowercase sha256 hex digest");
	}
	if (!Number.isSafeInteger(provenance.sizeBytes) || provenance.sizeBytes < 0) {
		mismatches.push("sizeBytes must be a non-negative safe integer");
	}
	const expectedDigest = createSkillContentDigest(content);
	const expectedSizeBytes = Buffer.byteLength(content);
	compare("digest.algorithm", expectedDigest.algorithm, digestAlgorithm);
	compare("digest.value", expectedDigest.value, digestValue);
	if (provenance.sizeBytes !== expectedSizeBytes) {
		mismatches.push(
			`sizeBytes expected ${expectedSizeBytes} but received ${provenance.sizeBytes}`,
		);
	}

	if (mismatches.length === 0) {
		return { ok: true };
	}

	return {
		ok: false,
		detail: `Skill provenance receipt does not match descriptor: ${mismatches.join("; ")}`,
	};
}
