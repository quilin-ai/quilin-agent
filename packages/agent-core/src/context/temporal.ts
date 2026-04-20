import type { BuildContext, PromptSection } from "./prompt-types.js";

export interface TemporalContext {
	readonly currentTime: Date;
	readonly lastMessageTime: Date | null;
	readonly sessionStartTime: Date;
	readonly lastSessionEndTime: Date | null;
}

interface TemporalSessionState {
	readonly currentTime?: string;
	readonly lastMessageTime?: string;
	readonly sessionStartTime?: string;
	readonly lastSessionEndTime?: string;
}

function readTemporalContext(ctx: BuildContext): TemporalContext {
	const state = (ctx.sessionState.temporal ?? {}) as TemporalSessionState;
	const currentTime = state.currentTime == null ? new Date() : new Date(state.currentTime);
	const sessionStartTime =
		state.sessionStartTime == null ? currentTime : new Date(state.sessionStartTime);

	return {
		currentTime,
		lastMessageTime:
			state.lastMessageTime == null ? null : new Date(state.lastMessageTime),
		sessionStartTime,
		lastSessionEndTime:
			state.lastSessionEndTime == null ? null : new Date(state.lastSessionEndTime),
	};
}

export function classifyGap(seconds: number): string {
	if (seconds < 300) {
		return "normal";
	}
	if (seconds < 1_800) {
		return "short_away";
	}
	if (seconds < 14_400) {
		return "medium_away";
	}
	if (seconds < 86_400) {
		return "long_away";
	}
	return "cross_day";
}

function classifyDayPeriod(value: Date): string {
	const hour = value.getUTCHours();
	if (hour < 6) {
		return "late_night";
	}
	if (hour < 12) {
		return "morning";
	}
	if (hour < 18) {
		return "afternoon";
	}
	return "evening";
}

function formatDateTime(value: Date): string {
	return value.toISOString();
}

function formatDuration(seconds: number): string {
	if (seconds < 60) {
		return `${Math.round(seconds)} 秒`;
	}
	if (seconds < 3_600) {
		return `${Math.round(seconds / 60)} 分钟`;
	}
	if (seconds < 86_400) {
		return `${Math.round(seconds / 3_600)} 小时`;
	}
	return `${Math.round(seconds / 86_400)} 天`;
}

export function createTemporalBucketSection(): PromptSection {
	return {
		name: "temporal-bucket",
		order: 70,
		updateFrequency: "per_session",
		compute: (ctx) => {
			const context = readTemporalContext(ctx);
			const lines = [
				"[时间桶]",
				`日期桶: ${context.currentTime.toISOString().slice(0, 10)}`,
				`时间桶: ${classifyDayPeriod(context.currentTime)}`,
			];

			if (context.lastMessageTime != null) {
				const gapSeconds =
					(context.currentTime.getTime() - context.lastMessageTime.getTime()) /
					1_000;
				lines.push(`消息间隔桶: ${classifyGap(gapSeconds)}`);
			}

			if (context.lastSessionEndTime != null) {
				const sessionGapSeconds =
					(context.currentTime.getTime() -
						context.lastSessionEndTime.getTime()) /
					1_000;
				lines.push(`跨 session 桶: ${classifyGap(sessionGapSeconds)}`);
			}

			return lines.join("\n");
		},
	};
}

export function decoratePreciseTemporalUserInput(
	userInput: string,
	context: TemporalContext,
): string {
	const lines = [
		"[时间上下文]",
		`当前时间: ${formatDateTime(context.currentTime)}`,
	];

	if (context.lastMessageTime != null) {
		const gapSeconds =
			(context.currentTime.getTime() - context.lastMessageTime.getTime()) / 1_000;
		lines.push(`距上条消息: ${formatDuration(gapSeconds)}`);
		lines.push(`消息间隔分类: ${classifyGap(gapSeconds)}`);
	}

	const sessionDurationSeconds =
		(context.currentTime.getTime() - context.sessionStartTime.getTime()) / 1_000;
	lines.push(`本次 session 持续: ${formatDuration(sessionDurationSeconds)}`);

	if (context.lastSessionEndTime != null) {
		const crossSessionGapSeconds =
			(context.currentTime.getTime() - context.lastSessionEndTime.getTime()) /
			1_000;
		lines.push(`距上次 session: ${formatDuration(crossSessionGapSeconds)}`);
	}

	return `${lines.join("\n")}\n\n${userInput}`;
}
