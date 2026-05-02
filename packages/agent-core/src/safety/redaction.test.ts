import { describe, expect, it } from "vitest";
import {
	findSecretPatterns,
	hasSecretPattern,
	isSensitiveObjectKey,
	redactJsonLikeValue,
	redactString,
	redactToolOutput,
} from "./redaction.js";

describe("redaction", () => {
	it("redacts deterministic string secret and PII patterns", () => {
		const input = [
			"email alpha@example.com",
			"Bearer abcdefghijklmnopqrstuvwxyz012345",
			"sk-abcdefghijklmnopqrstuvwxyz012345",
			"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"xoxb-1234567890-ABCDEFGHIJ-secretvalue",
		].join("\n");

		const output = redactString(input);

		expect(output).toContain("[REDACTED:email]");
		expect(output).toContain("Bearer [REDACTED:bearer_token]");
		expect(output).toContain("[REDACTED:openai_key]");
		expect(output).toContain("[REDACTED:github_token]");
		expect(output).toContain("[REDACTED:slack_token]");
		expect(output).toBe(redactString(input));
		expect(hasSecretPattern(output)).toBe(false);
	});

	it("detects raw secret-like patterns", () => {
		const matches = findSecretPatterns("contact alpha@example.com");

		expect(matches).toEqual([
			{
				kind: "email",
				matchedText: "alpha@example.com",
			},
		]);
	});

	it("redacts .env-style secret assignments", () => {
		const input = [
			"ANTHROPIC_API_KEY=sk-ant-secret-value",
			"OPENAI_API_KEY=plain-openai-secret",
			"DEEPSEEK_API_KEY=plain-deepseek-secret",
			"DATABASE_URL=postgres://user:pass@localhost:5432/app",
			"SESSION_TOKEN=session-token-value",
			"APP_SECRET=generic-secret-value",
			"DB_PASSWORD=generic-password-value",
			"PRIVATE_KEY=private-key-value",
			"SSH_PRIVATE_KEY=ssh-private-key-value",
			"JWT_SECRET_KEY=jwt-secret-key-value",
			"APP_PRIVATEKEY=app-private-key-value",
			"APP_SECRETKEY=app-secret-key-value",
			"PUBLIC_URL=https://example.test",
			"1: NUMBERED_TOKEN=numbered-token-value",
		].join("\n");

		const output = redactString(input);

		expect(output).toContain("ANTHROPIC_API_KEY=[REDACTED:env_secret]");
		expect(output).toContain("OPENAI_API_KEY=[REDACTED:env_secret]");
		expect(output).toContain("DEEPSEEK_API_KEY=[REDACTED:env_secret]");
		expect(output).toContain("DATABASE_URL=[REDACTED:env_secret]");
		expect(output).toContain("SESSION_TOKEN=[REDACTED:env_secret]");
		expect(output).toContain("APP_SECRET=[REDACTED:env_secret]");
		expect(output).toContain("DB_PASSWORD=[REDACTED:env_secret]");
		expect(output).toContain("PRIVATE_KEY=[REDACTED:env_secret]");
		expect(output).toContain("SSH_PRIVATE_KEY=[REDACTED:env_secret]");
		expect(output).toContain("JWT_SECRET_KEY=[REDACTED:env_secret]");
		expect(output).toContain("APP_PRIVATEKEY=[REDACTED:env_secret]");
		expect(output).toContain("APP_SECRETKEY=[REDACTED:env_secret]");
		expect(output).toContain("PUBLIC_URL=https://example.test");
		expect(output).toContain("1: NUMBERED_TOKEN=[REDACTED:env_secret]");
		expect(output).not.toContain("plain-openai-secret");
		expect(output).not.toContain("postgres://user:pass@localhost");
		expect(output).not.toContain("private-key-value");
		expect(output).not.toContain("ssh-private-key-value");
		expect(output).not.toContain("jwt-secret-key-value");
		expect(hasSecretPattern(output)).toBe(false);
	});

	it("detects .env-style secret assignments for meta verification", () => {
		const matches = findSecretPatterns(
			[
				"OPENAI_API_KEY=plain-openai-secret",
				"SSH_PRIVATE_KEY=ssh-private-key-value",
				"JWT_SECRET_KEY=jwt-secret-key-value",
				"PUBLIC_URL=https://example.test",
			].join("\n"),
		);

		expect(matches).toEqual([
			{
				kind: "env_secret",
				matchedText: "OPENAI_API_KEY=plain-openai-secret",
			},
			{
				kind: "env_secret",
				matchedText: "SSH_PRIVATE_KEY=ssh-private-key-value",
			},
			{
				kind: "env_secret",
				matchedText: "JWT_SECRET_KEY=jwt-secret-key-value",
			},
		]);
	});

	it("redacts sensitive object keys recursively without mutating input", () => {
		const input = {
			authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345",
			nested: {
				api_key: "sk-abcdefghijklmnopqrstuvwxyz012345",
				deepseek_api_key: "deepseek-secret",
				owner: "alpha@example.com",
			},
			items: [{ password: "secret-value", session_token: "session-value" }],
		};

		const output = redactJsonLikeValue(input);

		expect(output).toEqual({
			authorization: "[REDACTED]",
			nested: {
				api_key: "[REDACTED]",
				deepseek_api_key: "[REDACTED]",
				owner: "[REDACTED:email]",
			},
			items: [{ password: "[REDACTED]", session_token: "[REDACTED]" }],
		});
		expect(input.authorization).toContain("Bearer");
	});

	it("normalizes common sensitive object key spellings", () => {
		expect(isSensitiveObjectKey("api_key")).toBe(true);
		expect(isSensitiveObjectKey("apiKey")).toBe(true);
		expect(isSensitiveObjectKey("OPENAI_API_KEY")).toBe(true);
		expect(isSensitiveObjectKey("SESSION_TOKEN")).toBe(true);
		expect(isSensitiveObjectKey("DATABASE_URL")).toBe(true);
		expect(isSensitiveObjectKey("SSH_PRIVATE_KEY")).toBe(true);
		expect(isSensitiveObjectKey("jwtSecretKey")).toBe(true);
		expect(isSensitiveObjectKey("password")).toBe(true);
		expect(isSensitiveObjectKey("displayName")).toBe(false);
	});

	it("redacts JSON-like tool output strings", () => {
		const output = redactToolOutput(
			JSON.stringify({
				email: "alpha@example.com",
				password: "do-not-emit",
			}),
		);

		expect(JSON.parse(output)).toEqual({
			email: "[REDACTED:email]",
			password: "[REDACTED]",
		});
	});
});
