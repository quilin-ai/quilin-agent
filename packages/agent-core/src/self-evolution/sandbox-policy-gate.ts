import { DockerSandboxRouter } from "../tools/docker-sandbox-router.js";
import type { GeneratedPatchProposalKind } from "./types.js";

/**
 * Input to the sandbox policy gate consulted before applying a self-evolution
 * proposal patch. Mirrors the shape of `WriteRequest` so callers can reuse
 * the same metadata they pass to `WriteAuthority`.
 *
 * 自进化提案补丁应用前咨询的沙箱策略闸门入参。形状对齐 `WriteRequest`，
 * 调用方可复用传给 `WriteAuthority` 的元数据。
 */
export interface ProposalSandboxDecisionInput {
	readonly tool: string;
	readonly riskLevel: "low" | "medium" | "high" | "critical";
	readonly proposalKind: GeneratedPatchProposalKind | "artifact_only";
	readonly proposalId: string;
	readonly summary?: string;
}

/**
 * Decision returned by `ProposalSandboxPolicyGate.decide`:
 * - `docker` → run patch apply inside a Docker sandbox container.
 * - `native` → fall back to host execution; a warning describes why isolation
 *   could not be enforced so the caller can audit the gap.
 * - `deny` → the gate refuses to apply the patch (e.g. policy override). The
 *   caller MUST skip the applier and record the reason.
 *
 * 沙箱策略闸门返回的决策：docker（容器内执行）/ native（宿主机回退 + 警告）/
 * deny（拒绝应用，调用方必须跳过 applier 并记录原因）。
 */
export type ProposalSandboxDecision =
	| { readonly kind: "docker"; readonly provider: "docker" }
	| { readonly kind: "native"; readonly warning: string }
	| { readonly kind: "deny"; readonly reason: string };

/**
 * Policy gate consulted by `JsonlProposalStore.applyApproved` before invoking
 * a `ProposalPatchApplier` on `scaffold_patch` proposals (07 §2.6.4 high-risk
 * write paths must route through sandbox isolation when available).
 *
 * `applyApproved` 在调用 `scaffold_patch` 类提案的 applier 之前咨询此闸门
 * （07 §2.6.4：高风险写路径在条件允许时必须走沙箱隔离）。
 */
export interface ProposalSandboxPolicyGate {
	decide(input: ProposalSandboxDecisionInput): Promise<ProposalSandboxDecision>;
}

export interface DockerProposalSandboxPolicyGateOptions {
	/**
	 * Override availability probe (used in tests). Returns `true` when Docker
	 * is reachable, `false` otherwise.
	 *
	 * 覆盖可用性探测（用于测试）。Docker 可达返回 `true`，否则 `false`。
	 */
	readonly isDockerAvailable?: () => Promise<boolean>;
	/**
	 * Optional explicit deny predicate. When the predicate returns a string,
	 * the gate denies the apply with the predicate's reason. Lets callers
	 * implement org-specific deny rules (e.g. "deny while CI maintenance").
	 *
	 * 可选的显式 deny 谓词。返回字符串时，闸门以该字符串为理由拒绝应用。
	 * 让调用方实现组织级 deny 规则（如 "CI 维护期间禁止 apply"）。
	 */
	readonly denyOverride?: (
		input: ProposalSandboxDecisionInput,
	) => Promise<string | undefined> | string | undefined;
	/**
	 * Override the warning string emitted when Docker is unavailable but
	 * native fallback is permitted. Useful when callers want to embed audit
	 * IDs in the warning.
	 *
	 * 覆盖 Docker 不可用、native fallback 时发出的警告字符串。
	 */
	readonly nativeFallbackWarning?: string;
}

const DEFAULT_NATIVE_FALLBACK_WARNING =
	"Docker sandbox unavailable; applying scaffold patch on the host. Audit the apply trace before relying on it.";

/**
 * Default policy gate that prefers Docker sandbox isolation when available
 * and falls back to native execution with a warning otherwise. `scaffold_patch`
 * is the only kind currently treated as high-risk; other kinds short-circuit
 * to `native` without a warning so existing flows (artifact-only proposals)
 * are unaffected.
 *
 * 默认策略闸门：Docker 可用时优先使用容器隔离，不可用时 native 回退并打警告。
 * 当前仅 `scaffold_patch` 视为高风险，其他类型直接走 native（无警告），
 * 保持既有行为不变。
 */
export class DockerProposalSandboxPolicyGate
	implements ProposalSandboxPolicyGate
{
	private readonly isDockerAvailable: () => Promise<boolean>;
	private readonly denyOverride?: DockerProposalSandboxPolicyGateOptions["denyOverride"];
	private readonly nativeFallbackWarning: string;

	constructor(options: DockerProposalSandboxPolicyGateOptions = {}) {
		this.isDockerAvailable =
			options.isDockerAvailable ??
			(() => DockerSandboxRouter.isDockerAvailable());
		this.denyOverride = options.denyOverride;
		this.nativeFallbackWarning =
			options.nativeFallbackWarning ?? DEFAULT_NATIVE_FALLBACK_WARNING;
	}

	async decide(
		input: ProposalSandboxDecisionInput,
	): Promise<ProposalSandboxDecision> {
		if (this.denyOverride !== undefined) {
			const reason = await this.denyOverride(input);
			if (typeof reason === "string" && reason.trim().length > 0) {
				return { kind: "deny", reason: reason.trim() };
			}
		}

		if (input.proposalKind !== "scaffold_patch") {
			return { kind: "native", warning: "" };
		}

		const available = await this.isDockerAvailable();
		if (available) {
			return { kind: "docker", provider: "docker" };
		}

		return {
			kind: "native",
			warning: this.nativeFallbackWarning,
		};
	}
}

/**
 * Convenience constructor mirroring the `createDockerSandboxRouter` style.
 *
 * 与 `createDockerSandboxRouter` 风格一致的工厂函数。
 */
export function createDockerProposalSandboxPolicyGate(
	options: DockerProposalSandboxPolicyGateOptions = {},
): ProposalSandboxPolicyGate {
	return new DockerProposalSandboxPolicyGate(options);
}
