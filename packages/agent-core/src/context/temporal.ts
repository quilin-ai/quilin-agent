import type { PromptSection } from "./prompt-types.js";

export interface TemporalContext {
	readonly currentTime: Date;
	readonly lastMessageTime: Date | null;
	readonly sessionStartTime: Date;
	readonly lastSessionEndTime: Date | null;
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

export function createTemporalSection(
	getContext: () => TemporalContext,
): PromptSection {
	return {
		name: "temporal",
		order: 70,
		updateFrequency: "per_turn",
		compute: () => {
			const context = getContext();
			const lines = [
				"[时间上下文]",
				`当前时间: ${formatDateTime(context.currentTime)}`,
			];

			if (context.lastMessageTime != null) {
				const gapSeconds =
					(context.currentTime.getTime() - context.lastMessageTime.getTime()) /
					1_000;
				lines.push(`距上条消息: ${formatDuration(gapSeconds)}`);
				lines.push(`消息间隔分类: ${classifyGap(gapSeconds)}`);
			}

			const sessionDurationSeconds =
				(context.currentTime.getTime() - context.sessionStartTime.getTime()) /
				1_000;
			lines.push(
				`本次 session 持续: ${formatDuration(sessionDurationSeconds)}`,
			);

			if (context.lastSessionEndTime != null) {
				const crossSessionGapSeconds =
					(context.currentTime.getTime() -
						context.lastSessionEndTime.getTime()) /
					1_000;
				lines.push(`距上次 session: ${formatDuration(crossSessionGapSeconds)}`);
			}

			return lines.join("\n");
		},
	};
}
