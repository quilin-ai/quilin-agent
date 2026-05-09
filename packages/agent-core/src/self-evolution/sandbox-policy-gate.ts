import { DockerSandboxRouter } from "../tools/docker-sandbox-router.js";
import { sanitizeSelfEvolutionString } from "./sanitize.js";
import type { GeneratedPatchProposalKind } from "./types.js";

/**
 * Maximum length applied to operator-provided strings (deny override reason,
 * native fallback warning, sandbox probe error message) before they enter the
 * gate's decision payload. Sized to fit a typical log line and to prevent
 * adversarial overrides from bloating the audit trail.
 *
 * 操作员提供的字符串（denyOverride reason / native fallback warning /
 * 探测错误信息）在进入决策载荷前的统一长度上限。控制在常见日志行长度内，
 * 防止恶意覆盖污染审计轨迹。
 */
const MAX_GATE_REASON_CHARS = 200;

/**
 * Strip C0 control characters (U+0000..U+001F except tab) and DEL (U+007F)
 * from a string so they never reach the gate's decision payload. Tabs are
 * preserved because some legitimate operator messages embed them; newlines
 * collapse to a single space for log-line friendliness.
 *
 * 剔除 C0 控制字符（U+0000..U+001F，保留 tab）和 DEL（U+007F），newline
 * 折叠为空格，避免污染审计日志。
 */
function stripControlChars(value: string): string {
	let output = "";
	for (const codeUnit of value) {
		const code = codeUnit.codePointAt(0) ?? 0;
		// Newlines collapse to a single space (avoid swallowing line breaks
		// silently — operator messages may use \n as a soft break).
		if (code === 0x0a || code === 0x0d) {
			output += " ";
			continue;
		}
		// Preserve TAB (U+0009); strip all other C0 controls + DEL.
		if (code === 0x09) {
			output += codeUnit;
			continue;
		}
		if (code <= 0x1f || code === 0x7f) {
			continue;
		}
		output += codeUnit;
	}
	// Collapse multiple spaces produced by newline replacement.
	return output.replace(/ {2,}/gu, " ");
}

/**
 * Sanitize and length-cap an operator-provided reason / warning string so
 * the gate never returns control characters, secrets, or oversized blobs in
 * its decision payload. Falls back to a stable placeholder when the input
 * sanitizes to empty (e.g. only control characters).
 *
 * 清洗操作员提供的 reason / warning 字符串，再做长度截断，确保闸门返回的
 * 决策载荷里不会出现控制字符、密钥或超长内容；当输入被清洗后为空（例如
 * 仅含控制字符），回退到固定占位串。
 */
function sanitizeGateReason(value: string, fallback: string): string {
	const sanitized = stripControlChars(sanitizeSelfEvolutionString(value)).trim();
	const safe = sanitized.length > 0 ? sanitized : fallback;
	if (safe.length <= MAX_GATE_REASON_CHARS) {
		return safe;
	}
	return `${safe.slice(0, MAX_GATE_REASON_CHARS)}...[truncated]`;
}

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
	readonly isDockerAvailable?: () => Promise<boolean> | boolean;
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
	/**
	 * When `true`, the gate denies the apply if Docker is unreachable instead
	 * of falling back to native execution. Production deployments that treat
	 * Docker isolation as a hard requirement should set this to `true`; the
	 * default (`false`) preserves the legacy `native + warning` fallback so
	 * existing call sites keep working.
	 *
	 * Trade-off: `true` blocks scaffold-patch apply during a Docker outage;
	 * `false` lets the apply continue on the host with a `logger.warn` audit
	 * entry. See docs/07 §2.6.5 for the policy choice rationale.
	 *
	 * 设为 `true` 时，Docker 不可达直接 deny 而不再 native fallback。生产环境
	 * 把容器隔离视为硬约束的部署应启用；默认 `false` 保持既有 `native+warning`
	 * 行为，避免破坏既有调用方。
	 */
	readonly requireDocker?: boolean;
}

const DEFAULT_DOCKER_PROBE_FAILURE_REASON =
	"sandbox probe failed; refusing to apply scaffold patch without isolation guarantee";

const DEFAULT_DOCKER_REQUIRED_REASON =
	"Docker required for scaffold patch apply but Docker daemon is unavailable";

const DEFAULT_DENY_OVERRIDE_PLACEHOLDER = "policy override";

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
	private readonly isDockerAvailable: () => Promise<boolean> | boolean;
	private readonly denyOverride?: DockerProposalSandboxPolicyGateOptions["denyOverride"];
	private readonly nativeFallbackWarning: string;
	private readonly requireDocker: boolean;

	constructor(options: DockerProposalSandboxPolicyGateOptions = {}) {
		this.isDockerAvailable =
			options.isDockerAvailable ??
			(() => DockerSandboxRouter.isDockerAvailable());
		this.denyOverride = options.denyOverride;
		this.nativeFallbackWarning = sanitizeGateReason(
			options.nativeFallbackWarning ?? DEFAULT_NATIVE_FALLBACK_WARNING,
			DEFAULT_NATIVE_FALLBACK_WARNING,
		);
		this.requireDocker = options.requireDocker ?? false;
	}

	async decide(
		input: ProposalSandboxDecisionInput,
	): Promise<ProposalSandboxDecision> {
		if (this.denyOverride !== undefined) {
			const reason = await this.denyOverride(input);
			if (typeof reason === "string" && reason.trim().length > 0) {
				// Sanitize + length-cap operator-supplied deny reasons so they
				// never carry control characters, secrets, or oversized blobs
				// into the gate's decision payload (round-2 cross-review).
				return {
					kind: "deny",
					reason: sanitizeGateReason(reason, DEFAULT_DENY_OVERRIDE_PLACEHOLDER),
				};
			}
		}

		if (input.proposalKind !== "scaffold_patch") {
			return { kind: "native", warning: "" };
		}

		// `isDockerAvailable` may be a custom probe (DockerSandboxRouter or
		// a caller-supplied function) — wrap in try/catch so a thrown probe
		// error becomes a deny decision instead of crashing the apply path.
		// 用户传入的 probe 可能抛错；用 try/catch 兜底成 deny，避免崩溃 apply。
		let available: boolean;
		try {
			available = await this.isDockerAvailable();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				kind: "deny",
				reason: sanitizeGateReason(
					`sandbox probe failed: ${message}`,
					DEFAULT_DOCKER_PROBE_FAILURE_REASON,
				),
			};
		}
		if (available) {
			return { kind: "docker", provider: "docker" };
		}

		// Docker unreachable: production callers can opt into hard-fail
		// (`requireDocker: true`) instead of native fallback. See
		// docs/07 §2.6.5 + docs/10 §2.4.0 for the trade-off rationale.
		// Docker 不可达：生产调用方可通过 requireDocker:true 切到硬拒绝模式。
		if (this.requireDocker) {
			return {
				kind: "deny",
				reason: DEFAULT_DOCKER_REQUIRED_REASON,
			};
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
