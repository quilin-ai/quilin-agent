import { logger } from "../logger.js";

export type WriteRiskLevel = "low" | "medium" | "high" | "critical";

export type WriteOrigin = "user" | "agent" | "idle" | "install";

export type AuthorityMode =
	| "ask"
	| "auto-low"
	| "auto-medium"
	| "auto-all"
	| "deny-all";

export type WriteDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "deny"; readonly reason: string }
	| { readonly kind: "confirm"; readonly prompt: string };

export interface WriteRequest {
	readonly tool: string;
	readonly riskLevel: WriteRiskLevel;
	readonly summary: string;
	readonly detail?: string;
	readonly origin: WriteOrigin;
}

export interface AuditRecord {
	readonly timestamp: number;
	readonly request: WriteRequest;
	readonly decision: WriteDecision;
	readonly actor: string;
}

export interface WriteAuthorityOptions {
	mode?: AuthorityMode;
	confirm?: (request: WriteRequest) => Promise<boolean>;
	auditLog?: (record: AuditRecord) => void | Promise<void>;
	actor?: string;
}

function createConfirmPrompt(request: WriteRequest): string {
	return `[WriteAuthority] ${request.tool} (${request.riskLevel.toUpperCase()}): ${request.summary}`;
}

export class WriteAuthority {
	private mode: AuthorityMode;

	private readonly confirmHook?: WriteAuthorityOptions["confirm"];

	private readonly auditLog?: WriteAuthorityOptions["auditLog"];

	private readonly actor: string;

	constructor(options: WriteAuthorityOptions = {}) {
		this.mode = options.mode ?? "ask";
		this.confirmHook = options.confirm;
		this.auditLog = options.auditLog;
		this.actor = options.actor ?? "system";
	}

	getMode(): AuthorityMode {
		return this.mode;
	}

	setMode(mode: AuthorityMode): void {
		this.mode = mode;
	}

	decide(request: WriteRequest): WriteDecision {
		if (this.mode === "deny-all") {
			return { kind: "deny", reason: "write authority disabled" };
		}

		if (request.origin === "install") {
			return {
				kind: "confirm",
				prompt: createConfirmPrompt(request),
			};
		}

		if (request.origin === "idle" && this.mode === "ask") {
			return {
				kind: "deny",
				reason: "idle writes require explicit AUTO opt-in",
			};
		}

		if (request.riskLevel === "critical") {
			return {
				kind: "confirm",
				prompt: createConfirmPrompt(request),
			};
		}

		if (this.mode === "auto-all") {
			return { kind: "allow" };
		}

		if (this.mode === "ask") {
			return {
				kind: "confirm",
				prompt: createConfirmPrompt(request),
			};
		}

		if (this.mode === "auto-low" && request.riskLevel === "low") {
			return { kind: "allow" };
		}

		if (
			this.mode === "auto-medium" &&
			(request.riskLevel === "low" || request.riskLevel === "medium")
		) {
			return { kind: "allow" };
		}

		return {
			kind: "confirm",
			prompt: createConfirmPrompt(request),
		};
	}

	async authorize(request: WriteRequest): Promise<WriteDecision> {
		const initialDecision = this.decide(request);
		let finalDecision = initialDecision;

		if (initialDecision.kind === "confirm") {
			if (this.confirmHook == null) {
				finalDecision = {
					kind: "deny",
					reason: "write request requires interactive confirmation",
				};
			} else {
				try {
					const approved = await this.confirmHook(request);
					finalDecision = approved
						? { kind: "allow" }
						: { kind: "deny", reason: "write request not approved" };
				} catch (error) {
					finalDecision = {
						kind: "deny",
						reason:
							error instanceof Error
								? `write confirmation failed: ${error.message}`
								: "write confirmation failed",
					};
				}
			}
		}

		const auditRecord: AuditRecord = {
			timestamp: Date.now(),
			request,
			decision: finalDecision,
			actor: this.actor,
		};
		if (this.auditLog != null) {
			try {
				const auditResult = this.auditLog(auditRecord);
				if (auditResult instanceof Promise) {
					void auditResult.catch((error: unknown) => {
						logger.warn(
							{ err: error, tool: request.tool, actor: this.actor },
							"WriteAuthority audit logging failed",
						);
					});
				}
			} catch (error) {
				logger.warn(
					{ err: error, tool: request.tool, actor: this.actor },
					"WriteAuthority audit logging failed",
				);
			}
		}

		return finalDecision;
	}
}
