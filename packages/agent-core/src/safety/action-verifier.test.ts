import { describe, expect, it } from "vitest";
import { verifyAction } from "./action-verifier.js";

describe("verifyAction", () => {
	it("allows normal read-only tool calls", () => {
		expect(
			verifyAction({
				id: "call-1",
				name: "file_read",
				arguments: { path: "README.md" },
			}),
		).toEqual({
			layer: 2,
			decision: "allow",
			code: "allowed",
			reason: "Read-only tool call allowed",
		});
	});

	it("blocks sensitive file reads before read-only allow", () => {
		for (const path of [
			".env",
			".env.local",
			"~/.gcloud/application_default_credentials.json",
			"~/.azure/accessTokens.json",
			"~/.config/gcloud/application_default_credentials.json",
			"~/.ssh/id_rsa",
			"secrets.pem",
			"private.key",
			"/etc/shadow",
			"/etc/sudoers",
		]) {
			expect(
				verifyAction({
					id: `read-${path}`,
					name: "file_read",
					arguments: { path },
				}),
			).toMatchObject({
				layer: 2,
				decision: "block",
				code: "sensitive_file_read",
			});
		}
	});

	it("blocks shell credential exfiltration commands", () => {
		const result = verifyAction({
			id: "call-1",
			name: "shell_exec",
			arguments: { command: "cat .env" },
		});

		expect(result).toMatchObject({
			layer: 2,
			decision: "block",
			code: "shell_credential_exfiltration",
		});
	});

	it("blocks shell reads of sensitive credential files", () => {
		for (const command of [
			"cat ~/.ssh/id_rsa",
			"cat ~/.gcloud/application_default_credentials.json",
			"cat ~/.azure/accessTokens.json",
			"cat ~/.config/gcloud/application_default_credentials.json",
			"cat /etc/shadow",
			"cat /etc/sudoers",
			"cat secrets.pem",
			"cat private.key",
			"rg token ~/.aws/credentials",
			"sed -n '1,5p' .env.local",
		]) {
			expect(
				verifyAction({
					id: `shell-${command}`,
					name: "shell_exec",
					arguments: { command },
				}),
			).toMatchObject({
				layer: 2,
				decision: "block",
				code: "shell_credential_exfiltration",
			});
		}
	});

	it("blocks shell stdin redirection reads of sensitive credential files", () => {
		for (const command of [
			"cat < secrets.pem",
			"cat < private.key",
			"cat < ~/.ssh/id_rsa",
		]) {
			expect(
				verifyAction({
					id: `shell-${command}`,
					name: "shell_exec",
					arguments: { command },
				}),
			).toMatchObject({
				layer: 2,
				decision: "block",
				code: "shell_credential_exfiltration",
			});
		}
	});

	it("blocks shell glob reads under sensitive credential directories", () => {
		for (const command of [
			"cat ~/.ssh/*",
			"cat ~/.aws/*",
			"cat ~/.gcloud/*",
			"cat ~/.azure/*",
			"cat ~/.config/gcloud/*",
			"cat ~/.kube/*",
			"cat /etc/ssh/*",
			"grep token ~/.aws/*",
			"grep token ~/.gcloud/*",
			"grep token ~/.azure/*",
			"grep token ~/.config/gcloud/*",
			"grep token ~/.kube/*",
			"grep token /etc/ssh/*",
		]) {
			expect(
				verifyAction({
					id: `shell-${command}`,
					name: "shell_exec",
					arguments: { command },
				}),
			).toMatchObject({
				layer: 2,
				decision: "block",
				code: "shell_credential_exfiltration",
			});
		}
	});

	it("blocks shell glob reads of sensitive key extensions", () => {
		for (const command of ["cat *.pem", "grep token *.key"]) {
			expect(
				verifyAction({
					id: `shell-${command}`,
					name: "shell_exec",
					arguments: { command },
				}),
			).toMatchObject({
				layer: 2,
				decision: "block",
				code: "shell_credential_exfiltration",
			});
		}
	});

	it("blocks destructive shell intent", () => {
		const result = verifyAction({
			id: "call-1",
			name: "shell_exec",
			arguments: { command: "rm -rf /" },
		});

		expect(result).toMatchObject({
			decision: "block",
			code: "destructive_shell_intent",
		});
	});

	it("allows ordinary shell reads that do not target credentials", () => {
		for (const command of [
			"cat README.md",
			"cat docs/*.md",
			"grep token packages/**/*.ts",
		]) {
			expect(
				verifyAction({
					id: `shell-${command}`,
					name: "shell_exec",
					arguments: { command },
				}),
			).toMatchObject({
				decision: "allow",
				code: "allowed",
			});
		}
	});

	it("blocks risky file writes and deletes", () => {
		expect(
			verifyAction({
				id: "call-1",
				name: "file_write",
				arguments: { path: ".env.local", content: "TOKEN=value" },
			}),
		).toMatchObject({
			decision: "block",
			code: "risky_file_write",
		});

		expect(
			verifyAction({
				id: "call-2",
				name: "file_delete",
				arguments: { path: "/" },
			}),
		).toMatchObject({
			decision: "block",
			code: "risky_file_delete",
		});
	});
});
