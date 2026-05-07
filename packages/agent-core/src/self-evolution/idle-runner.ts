import { analyzeTrajectoryFailures } from "./failure-analyzer.js";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import { logger } from "../logger.js";
import type {
  FailureAnalysis,
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

  private tokensUsedToday = 0;
  private lastResetDate = "";
  private initialized = false;

  constructor(options: IdleEvolutionRunnerOptions) {
    this.dailyTokenQuota = options.idleBudget.dailyTokenQuota;
    this.trajectoryStore = options.trajectoryStore;
    this.failureAnalyzer = options.failureAnalyzer;
    this.proposalStore = options.proposalStore;
    this.now = options.now ?? (() => new Date());
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

    const optimizer = new LocalNoopOfflineOptimizer({ now: this.now });
    const result = optimizer.optimize({
      trajectories,
      analyses,
      now: this.now,
    });

    for (const proposal of result.proposals) {
      await this.proposalStore.append(proposal);
    }

    // Rough token estimation: each trajectory analysis costs ~100 tokens.
    // 粗略 token 估计：每条轨迹分析消耗约 100 token。
    const estimatedTokens = trajectories.length * 100;
    this.tokensUsedToday += estimatedTokens;

    logger.info(
      {
        trajectoryCount: trajectories.length,
        proposalCount: result.proposals.length,
        noProposalReasonCount: result.noProposalReasons.length,
        tokensUsedToday: this.tokensUsedToday,
        dailyTokenQuota: this.dailyTokenQuota,
      },
      "IdleEvolutionRunner: cycle complete",
    );
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
