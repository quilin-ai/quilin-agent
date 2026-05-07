import { logger } from "../logger.js";
import type { AgentState, Checkpoint, Message } from "./types.js";

/** 自动保存间隔（轮），默认每 5 轮保存一次 */
export const DEFAULT_CHECKPOINT_INTERVAL = 5;

/**
 * Crash 后检测到上一 session 未正常退出的结果
 * / Crash detection result when previous session did not exit cleanly
 */
export interface CrashDetectionResult {
	readonly crashed: true;
	/** 上次会话的状态 / Previous session state */
	readonly previousState: AgentState;
	/** 最后一条用户消息 / Last user message */
	readonly lastUserMessage: string;
	/** 消息数量 / Message count */
	readonly messageCount: number;
}

/**
 * 从 checkpoint 恢复时生成的上下文，供 LLM 理解中断前的状况
 * / Recovery context generated from checkpoint for LLM understanding
 */
export interface RecoveryContext {
	/** crash 摘要，供人类查看 / Crash summary for human review */
	readonly crashSummary: string;
	/** 恢复时追加到 system prompt 的文本 / System prompt addition for recovery */
	readonly recoverySystemPrompt: string;
}

/**
 * 创建一个自动保存工具，每 N 轮自动调用 checkpoint.save()。
 * 返回一个包含 onTurnComplete 和 markTerminal 方法的对象。
 *
 * Creates an auto-save hook that calls checkpoint.save() every N turns.
 * Returns an object with onTurnComplete and markTerminal methods.
 */
export function autoSaveCheckpoint(
	checkpoint: Checkpoint,
	baseState: Pick<AgentState, "createdAt">,
	interval: number = DEFAULT_CHECKPOINT_INTERVAL,
): {
	readonly onTurnComplete: (
		turnCount: number,
		messages: readonly Message[],
	) => Promise<void>;
	readonly markTerminal: (
		turnCount: number,
		messages: readonly Message[],
	) => Promise<void>;
} {
	let turnCounter = 0;

	return {
		async onTurnComplete(
			turnCount: number,
			messages: readonly Message[],
		): Promise<void> {
			turnCounter += 1;
			if (turnCounter % interval !== 0) {
				return;
			}

			try {
				await checkpoint.save({
					messages: [...messages],
					isTerminal: false,
					turnCount,
					createdAt: baseState.createdAt,
					lastActiveAt: new Date().toISOString(),
				});
			} catch (err) {
				logger.warn(
					{ err, turnCount },
					"Auto-save checkpoint failed",
				);
			}
		},

		async markTerminal(
			turnCount: number,
			messages: readonly Message[],
		): Promise<void> {
			try {
				await checkpoint.save({
					messages: [...messages],
					isTerminal: true,
					turnCount,
					createdAt: baseState.createdAt,
					lastActiveAt: new Date().toISOString(),
				});
			} catch (err) {
				logger.warn(
					{ err, turnCount },
					"Terminal checkpoint save failed",
				);
			}
		},
	};
}

/**
 * 检测上一次会话是否非正常退出（isTerminal === false）。
 * 如果找到未完成的会话，返回 CrashDetectionResult；否则返回 null。
 *
 * Detects whether the previous session crashed by checking isTerminal in
 * the last saved checkpoint. Returns CrashDetectionResult if a crash is
 * detected, null otherwise.
 */
export async function detectCrashRecovery(
	checkpoint: Checkpoint,
	sessionId: string,
): Promise<CrashDetectionResult | null> {
	const previousState = await checkpoint.load(sessionId);

	if (previousState == null) {
		return null;
	}

	// isTerminal === true 说明上次会话已正常结束
	// isTerminal === true means the previous session ended cleanly
	if (previousState.isTerminal) {
		return null;
	}

	const lastUserMessage = [...previousState.messages]
		.reverse()
		.find((m) => m.role === "user");

	return {
		crashed: true as const,
		previousState,
		lastUserMessage: lastUserMessage?.content ?? "",
		messageCount: previousState.messages.length,
	};
}

/**
 * 从 crash 检测结果生成恢复上下文，供 LLM 理解中断前的状况。
 *
 * Builds a recovery context from crash detection results so the LLM
 * can understand what was happening before the interruption.
 */
export function buildRecoveryContext(
	crashResult: CrashDetectionResult,
): RecoveryContext {
	const { previousState } = crashResult;

	const recentMessages = previousState.messages.slice(-4);
	const messageDigest = recentMessages
		.map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
		.join("\n");

	const truncatedUserMessage =
		crashResult.lastUserMessage.length > 300
			? `${crashResult.lastUserMessage.slice(0, 300)}...`
			: crashResult.lastUserMessage;

	const crashSummary = [
		`Session crashed at turn ${previousState.turnCount} with ${crashResult.messageCount} messages.`,
		crashResult.lastUserMessage
			? `Last user request: "${truncatedUserMessage}"`
			: "No user message found in the crashed session.",
		`Recent conversation:\n${messageDigest || "(empty)"}`,
	].join("\n\n");

	const recoverySystemPrompt =
		"[SYSTEM NOTE] You are resuming from a crash recovery. " +
		"The previous session was interrupted unexpectedly and did not complete. " +
		"Review the crash context below, acknowledge the interruption if helpful, " +
		"and continue where the conversation left off.";

	return { crashSummary, recoverySystemPrompt };
}
