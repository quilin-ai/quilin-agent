import { logger } from "../logger.js";
import type { WriteAuthority } from "../safety/write-authority.js";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import type {
	FailureAnalysis,
	OfflineOptimizer,
	OptimizationProposalDraft,
	StoredTrajectoryRecord,
} from "./types.js";

/** Minimal trajectory store interface for loose coupling in idle evolution. */
export interface IdleTrajectoryStore {
	list(): Promise<readonly StoredTrajectoryRecord[]>;
}

/**
 * Failure analyzer function type.
 * Maps a stored trajectory to a failure analysis.
 */
export type IdleFailureAnalyzer = (
	trajectory: StoredTrajectoryRecord,
) => FailureAnalysis;

/** Minimal proposal store interface for loose coupling in idle evolution. */
export interface IdleProposalStore {
	append(input: OptimizationProposalDraft): Promise<unknown>;
}

/** Daily token budget configuration for idle evolution. */
export interface IdleBudgetConfig {
	/** Maximum tokens allowed per 24-hour window. */
	readonly dailyTokenQuota: number;
}

export interface IdleEvolutionRunnerOptions {
	/** Daily token budget controlling how much idle work is allowed. */
	readonly idleBudget: IdleBudgetConfig;
	/** Store for reading recent trajectories. */
	readonly trajectoryStore: IdleTrajectoryStore;
	/** Function that analyzes a trajectory for failure signals. */
	readonly failureAnalyzer: IdleFailureAnalyzer;
	/** Store for persisting generated proposals. */
	readonly proposalStore: IdleProposalStore;
	/** Clock override for deterministic testing. */
	readonly now?: () => Date;
	/**
	 * Offline optimizer to use during the idle cycle. When omitted, falls back
	 * to LocalNoopOfflineOptimizer for backward compatibility.
	 *
	 * 可选的离线优化器；省略时回退到 LocalNoopOfflineOptimizer，保持向后兼容。
	 */
	readonly optimizer?: OfflineOptimizer;
	/**
	 * WriteAuthority gate enforcing the safety contract from
	 * docs/07-safety-guardrails/README.md §2.6.4: every agent-initiated write
	 * (including idle evolution proposal persistence) must be authorized
	 * before reaching the underlying store.
	 *
	 * When omitted, idle proposal persistence is denied by default and the
	 * runner logs a warning. Callers must wire a configured `WriteAuthority`
	 * to actually persist proposals.
	 *
	 * WriteAuthority 强制执行 docs/07-safety-guardrails/README.md §2.6.4
	 * 的安全契约：所有 agent-initiated write（包括 idle evolution 提案落盘）
	 * 在写入底层存储前必须获得授权。未提供时默认拒绝并记录警告，调用方必须
	 * 显式注入 WriteAuthority 才能真正持久化提案。
	 */
	readonly writeAuthority?: WriteAuthority;
	/**
	 * When true, the idle runner will build proposals through the optimizer
	 * but skip persistence. Used for inspection / scripted dry runs without
	 * touching the proposal store.
	 *
	 * 为 true 时，runner 仅通过 optimizer 构造提案而跳过持久化，便于人工
	 * 检查或脚本化 dry-run，不写入 proposal store。
	 */
	readonly dryRun?: boolean;
}

/**
 * Default daily token quota for idle evolution: 10 000 tokens per 24-hour window.
 *
 * Idle evolution runs with a bounded budget to avoid consuming excessive
 * compute during idle periods. When the quota is exhausted, tryRun becomes
 * a no-op until the window resets.
 *
 * 闲置演进的默认每日 token 配额：每 24 小时窗口 10 000 token。
 */
export const DEFAULT_IDLE_DAILY_TOKEN_QUOTA = 10_000;

/**
 * IdleEvolutionRunner orchestrates idle-time self-evolution.
 *
 * When the agent is idle (no user input to process), the main loop may call
 * `tryRun()`. The runner checks the remaining daily token quota (24-hour
 * sliding window), fetches recent trajectories, analyzes them for failure
 * signals, generates optimization proposals via the local no-op optimizer,
 * and persists those proposals for human review.
 *
 * IdleEvolutionRunner 在 agent 空闲时运行自我演进。
 *
 * 当 agent 空闲（没有用户输入待处理）时，主循环可调用 tryRun()。
 * Runner 检查剩余每日 token 配额（24 小时滑动窗口），获取最近的轨迹，
 * 分析失败信号，通过本地 no-op 优化器生成改进提案，并将提案持久化供人工审核。
 */
export class IdleEvolutionRunner {
	private readonly dailyTokenQuota: number;
	private readonly trajectoryStore: IdleTrajectoryStore;
	private readonly failureAnalyzer: IdleFailureAnalyzer;
	private readonly proposalStore: IdleProposalStore;
	private readonly now: () => Date;
	private readonly optimizer: OfflineOptimizer;
	private writeAuthority?: WriteAuthority;
	private readonly dryRun: boolean;

	private tokensUsedToday = 0;
	private lastResetDate = "";
	private initialized = false;

	constructor(options: IdleEvolutionRunnerOptions) {
		this.dailyTokenQuota = options.idleBudget.dailyTokenQuota;
		this.trajectoryStore = options.trajectoryStore;
		this.failureAnalyzer = options.failureAnalyzer;
		this.proposalStore = options.proposalStore;
		this.now = options.now ?? (() => new Date());
		this.optimizer =
			options.optimizer ?? new LocalNoopOfflineOptimizer({ now: this.now });
		this.writeAuthority = options.writeAuthority;
		this.dryRun = options.dryRun ?? false;
	}

	/**
	 * Late-binding setter for the WriteAuthority gate. Used when the gate is
	 * constructed after the runner (e.g. inside the REPL bootstrap, after
	 * `readline` is available for confirm prompts). Once set, every idle
	 * proposal append routes through `WriteAuthority.authorize`.
	 *
	 * 后绑定 WriteAuthority gate。当 gate 在 runner 之后构造（例如 REPL
	 * 启动后才有 readline 用于 confirm）时使用。设置后，每次 idle proposal
	 * append 都会走 WriteAuthority.authorize。
	 */
	setWriteAuthority(authority: WriteAuthority): void {
		this.writeAuthority = authority;
	}

	/**
	 * Attempt to run idle evolution if the daily quota has not been exhausted.
	 *
	 * Called by the main loop when the agent is idle.
	 *
	 * 尝试运行闲置演进（如果每日配额未耗尽）。
	 * 由主循环在 agent 空闲时调用。
	 */
	async tryRun(): Promise<void> {
		this.resetDailyQuotaIfNeeded();

		if (!this.initialized) {
			this.initialized = true;
			logger.info(
				{ dailyTokenQuota: this.dailyTokenQuota },
				"IdleEvolutionRunner: first run — self-evolution engine active",
			);
		}

		if (this.dailyTokenQuota === 0) {
			return;
		}

		if (this.tokensUsedToday >= this.dailyTokenQuota) {
			return;
		}

		const trajectories = await this.trajectoryStore.list();
		if (trajectories.length === 0) {
			return;
		}

		const analyses = trajectories.map((trajectory) =>
			this.failureAnalyzer(trajectory),
		);

		const result = await this.optimizer.optimize({
			trajectories,
			analyses,
			now: this.now,
			dryRun: this.dryRun,
		});

		let appendedCount = 0;
		let deniedCount = 0;
		let failedCount = 0;

		if (this.dryRun) {
			logger.info(
				{
					optimizerId: this.optimizer.optimizerId,
					proposalCount: result.proposals.length,
				},
				"IdleEvolutionRunner: dryRun=true — skipping proposal persistence",
			);
		} else {
			for (const proposal of result.proposals) {
				const authorized = await this.authorizeProposalAppend(proposal);
				if (!authorized) {
					deniedCount += 1;
					continue;
				}
				const ok = await this.appendProposalSafely(proposal);
				if (ok) {
					appendedCount += 1;
				} else {
					failedCount += 1;
				}
			}
		}

		// Rough token estimation: each trajectory analysis costs ~100 tokens.
		// 粗略 token 估计：每条轨迹分析消耗约 100 token。
		const estimatedTokens = trajectories.length * 100;
		this.tokensUsedToday += estimatedTokens;

		logger.info(
			{
				optimizerId: this.optimizer.optimizerId,
				trajectoryCount: trajectories.length,
				proposalCount: result.proposals.length,
				appendedCount,
				deniedCount,
				failedCount,
				dryRun: this.dryRun,
				noProposalReasonCount: result.noProposalReasons.length,
				tokensUsedToday: this.tokensUsedToday,
				dailyTokenQuota: this.dailyTokenQuota,
			},
			"IdleEvolutionRunner: cycle complete",
		);
	}

	/**
	 * Route a proposal append through WriteAuthority, returning whether the
	 * write may proceed. When no WriteAuthority is configured, the runner
	 * defaults to deny + warn (matching the safety spec's "no idle bypass"
	 * rule in docs/07 §2.6.4).
	 *
	 * 通过 WriteAuthority 路由 proposal append，返回是否可以继续写入。
	 * 未配置 WriteAuthority 时默认拒绝并告警，对齐 docs/07 §2.6.4 中
	 * “idle 不得绕过 gate” 的硬约束。
	 */
	private async authorizeProposalAppend(
		proposal: OptimizationProposalDraft,
	): Promise<boolean> {
		if (this.writeAuthority == null) {
			logger.warn(
				{
					tool: "self_evolution_proposal_append",
					origin: "idle",
					proposalTitle: proposal.title,
				},
				"IdleEvolutionRunner: WriteAuthority not configured — denying idle proposal append (docs/07 §2.6.4)",
			);
			return false;
		}

		try {
			const decision = await this.writeAuthority.authorize({
				tool: "self_evolution_proposal_append",
				riskLevel: "medium",
				origin: "idle",
				summary: `idle evolution proposal: ${proposal.title}`,
				detail: proposal.summary,
			});
			if (decision.kind === "allow") {
				return true;
			}
			logger.warn(
				{
					tool: "self_evolution_proposal_append",
					origin: "idle",
					proposalTitle: proposal.title,
					decision: decision.kind,
					reason: decision.kind === "deny" ? decision.reason : decision.prompt,
				},
				"IdleEvolutionRunner: WriteAuthority denied / requires confirmation — skipping idle proposal append",
			);
			return false;
		} catch (error) {
			logger.warn(
				{
					tool: "self_evolution_proposal_append",
					origin: "idle",
					proposalTitle: proposal.title,
					err: error,
				},
				"IdleEvolutionRunner: WriteAuthority threw during authorize — skipping idle proposal append",
			);
			return false;
		}
	}

	/**
	 * Append a proposal to the store with defensive error handling. Idle
	 * cycles must never bubble I/O errors (disk full, EROFS, permission
	 * denied) up to the caller — the agent main loop must remain responsive.
	 *
	 * 容错地将 proposal 写入 store。Idle cycle 不允许把 I/O 错误（磁盘满、
	 * 只读、权限不足）冒泡到调用方，主循环必须保持可响应。
	 */
	private async appendProposalSafely(
		proposal: OptimizationProposalDraft,
	): Promise<boolean> {
		try {
			await this.proposalStore.append(proposal);
			return true;
		} catch (error) {
			logger.warn(
				{
					proposalTitle: proposal.title,
					err: error,
				},
				"IdleEvolutionRunner: proposalStore.append failed — continuing idle cycle",
			);
			return false;
		}
	}

	/**
	 * Reset the daily token counter when the calendar date changes.
	 *
	 * Implements the 24-hour sliding window: when the ISO date string
	 * (YYYY-MM-DD) differs from the last recorded reset, the counter
	 * is cleared to zero.
	 *
	 * 当日期变更时重置每日 token 计数器。
	 */
	private resetDailyQuotaIfNeeded(): void {
		const today = this.now().toISOString().slice(0, 10);
		if (today !== this.lastResetDate) {
			this.tokensUsedToday = 0;
			this.lastResetDate = today;
		}
	}
}
