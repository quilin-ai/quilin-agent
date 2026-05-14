export interface UserIntentRewrite {
	readonly originalText: string;
	readonly normalizedText: string;
	readonly changed: boolean;
	readonly reason: string | null;
}

const SIMILAR_INTENT_REASON = "中文同音/输入法误选：询问相似案例时应为「有类似的」。";
const SIMILAR_INTENT_TYPO_PATTERN = /(又累的|又类似的|有累的)([^。！？？，,\n]*)/g;
const SIMILAR_INTENT_TARGET_PATTERN =
	/^\s*[^。！？？，,\n]{0,18}(团队|案例|竞品|公司|项目|产品|方案|平台|应用|工具|服务|机会|标的|赛道|品牌|机构|网站|app|APP|App)(?:\s|吗|么|呢|有|是|，|,|。|？|\?|$)/;
const FATIGUE_CONTEXT_TAIL_PATTERN =
	/^\s*(很|太|挺|特别|比较|越来越|容易|更|也|就|会|快|慢|累|疲|困|乏|没劲|压力|焦虑|透支|崩|不行)/;

function rewriteSimilarIntentTypo(text: string): UserIntentRewrite {
	let changed = false;
	const normalizedText = text.replace(SIMILAR_INTENT_TYPO_PATTERN, (match, _typo, tail) => {
		if (FATIGUE_CONTEXT_TAIL_PATTERN.test(String(tail))) return match;
		if (!SIMILAR_INTENT_TARGET_PATTERN.test(String(tail))) return match;
		changed = true;
		return `有类似的${tail}`;
	});
	return {
		originalText: text,
		normalizedText,
		changed,
		reason: changed ? SIMILAR_INTENT_REASON : null,
	};
}

export function rewriteUserIntentText(text: string): UserIntentRewrite {
	return rewriteSimilarIntentTypo(text);
}

export function intentRewriteSystemNote(rewrite: UserIntentRewrite | null): string {
	if (rewrite == null || !rewrite.changed) return "";
	return (
		"本轮高置信输入归一化:\n" +
		`- 用户原文: ${rewrite.originalText}\n` +
		`- 按此意图理解: ${rewrite.normalizedText}\n` +
		`- 依据: ${rewrite.reason ?? "明显输入错误"}\n` +
		"接下来所有搜索 query、subagent task、工具参数和最终回答都优先使用归一化后的意图；不要按错字逐字执行。"
	);
}
