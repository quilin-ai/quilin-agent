import { describe, expect, it } from "vitest";
import { hasSecretPattern } from "../safety/redaction.js";
import { normalizeEvidenceRefs, sanitizeForSelfEvolution } from "./sanitize.js";

describe("sanitizeForSelfEvolution", () => {
	it("reuses shared redactor coverage and preserves local token patterns", () => {
		const githubPat = `github_pat_${"A".repeat(24)}`;
		const databaseUrl = "postgres://user:pass@localhost:5432/app";
		const envSecret = "OPENAI_API_KEY=plain-openai-secret";
		const email = "alpha@example.com";
		const providerKey = "pk-abcdefghijklmnopqrstuvwxyz012345";

		const sanitized = sanitizeForSelfEvolution({
			text: [
				`pat ${githubPat}`,
				`db ${databaseUrl}`,
				envSecret,
				`email ${email}`,
				`provider ${providerKey}`,
			].join("\n"),
			nested: {
				owner: email,
				databaseUrl,
			},
		});
		const serialized = JSON.stringify(sanitized);

		expect(serialized).not.toContain(githubPat);
		expect(serialized).not.toContain(databaseUrl);
		expect(serialized).not.toContain("plain-openai-secret");
		expect(serialized).not.toContain(email);
		expect(serialized).not.toContain(providerKey);
		expect(serialized).toContain("[REDACTED:github_token]");
		expect(serialized).toContain("[REDACTED:database_url]");
		expect(serialized).toContain("OPENAI_API_KEY=[REDACTED:env_secret]");
		expect(serialized).toContain("[REDACTED:email]");
		expect(serialized).toContain("[REDACTED]");
		expect(hasSecretPattern(serialized)).toBe(false);
	});

	it("normalizes and sanitizes evidence references before persistence", () => {
		const githubPat = `github_pat_${"B".repeat(24)}`;
		const databaseUrl = "mysql://user:pass@localhost:3306/app";
		const envSecret = "SESSION_TOKEN=plain-session-secret";
		const email = "beta@example.com";
		const providerKey = "rk-abcdefghijklmnopqrstuvwxyz012345";

		const refs = normalizeEvidenceRefs([
			` ${githubPat} `,
			` ${databaseUrl} `,
			` ${envSecret} `,
			` contact ${email} `,
			` ${providerKey} `,
			" ",
		]);
		const serialized = refs.join("\n");

		expect(refs).toEqual([
			"[REDACTED:github_token]",
			"[REDACTED:database_url]",
			"SESSION_TOKEN=[REDACTED:env_secret]",
			"contact [REDACTED:email]",
			"[REDACTED]",
		]);
		expect(serialized).not.toContain(githubPat);
		expect(serialized).not.toContain(databaseUrl);
		expect(serialized).not.toContain("plain-session-secret");
		expect(serialized).not.toContain(email);
		expect(serialized).not.toContain(providerKey);
		expect(hasSecretPattern(serialized)).toBe(false);
	});

	it("redacts secrets embedded in object keys as well as values", () => {
		const secretKey = "OPENAI_API_KEY=plain-openai-secret";
		const bearerKey = "Bearer secret-source-ref-123456";

		const sanitized = sanitizeForSelfEvolution({
			[secretKey]: "value",
			nested: {
				[bearerKey]: "value",
			},
		});
		const serialized = JSON.stringify(sanitized);

		expect(serialized).not.toContain("plain-openai-secret");
		expect(serialized).not.toContain("secret-source-ref-123456");
		expect(serialized).toContain("[REDACTED]");
		expect(hasSecretPattern(serialized)).toBe(false);
	});
});
