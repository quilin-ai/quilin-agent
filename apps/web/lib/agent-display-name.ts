const DEFAULT_SUBAGENT_NAME = "子代理";
const DEFAULT_MAIN_NAME = "主代理";
const MAX_SUBJECT_CHARS = 12;

const ACTION_SUFFIX_RULES: readonly { readonly pattern: RegExp; readonly suffix: string }[] = [
	{ pattern: /审查|复审|评审|review|cross[-_\s]?review/i, suffix: "审查" },
	{ pattern: /修复|排查|错误|失败|bug|fix|error|failure/i, suffix: "修复" },
	{ pattern: /验证|测试|复现|qa|test|verify|repro/i, suffix: "验证" },
	{ pattern: /对比|比较|compare|benchmark/i, suffix: "对比" },
	{ pattern: /总结|整理|归纳|summary|summari[sz]e/i, suffix: "总结" },
	{ pattern: /实现|开发|新增|支持|build|implement|feature/i, suffix: "实现" },
	{ pattern: /抓取|fetch|web_fetch|爬取/i, suffix: "抓取" },
	{
		pattern: /调研|研究|分析|搜索|搜搜|查询|查找|查一下|research|analy[sz]e|search/i,
		suffix: "研究",
	},
];

const LEADING_FILLER_PATTERNS: readonly RegExp[] = [
	/^(请|请你|帮我|帮用户|麻烦|需要|负责|执行|开始|继续)+/i,
	/^(一个|这个|该|本次|当前|相关|关于|针对)+/i,
	/^(子任务|任务|task)\s*[:：]?\s*/i,
	/^(再搜搜|再搜索|继续搜搜|继续搜索|搜搜|再查查|再查|查查|调研|研究|分析|搜索|查询|查找|查一下|查|验证|测试|复现|修复|排查|实现|开发|新增|支持|总结|整理|归纳|对比|比较|抓取|爬取)(一下)?/i,
	/^(有类似的|类似的|相似的)/i,
	/^(research|analy[sz]e|search|verify|test|fix|implement|build|summari[sz]e|compare|fetch)\s+/i,
	/^(一下|一下子|下|这个|这类|该|相关|关于|针对)+/i,
];

const TRAILING_FILLER_PATTERNS: readonly RegExp[] = [
	/(这个|该)?(赛道|方向|领域|问题|任务|内容|资料|信息|情况|结果|报告)$/i,
	/(并|然后|以及|和|与|及).+$/i,
];

function inferActionSuffix(task: string): string {
	for (const rule of ACTION_SUFFIX_RULES) {
		if (rule.pattern.test(task)) return rule.suffix;
	}
	return "";
}

function stripFillers(input: string): string {
	let text = input;
	for (let i = 0; i < 4; i += 1) {
		const before = text;
		for (const pattern of LEADING_FILLER_PATTERNS) {
			text = text.replace(pattern, "");
		}
		if (text === before) break;
		text = text.trim();
	}
	for (const pattern of TRAILING_FILLER_PATTERNS) {
		text = text.replace(pattern, "");
	}
	return text.trim();
}

function compactSubject(input: string): string {
	const normalized = input
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/[`"'“”‘’「」『』()[\]{}<>]/g, " ")
		.replace(/\b20\d{2}\s*年?/g, " ")
		.replace(/最新|近期|最近|今年|当前|目前|近\s*\d+\s*(天|周|个月|年)/g, " ")
		.replace(/[，。；;、：:！？!?]/g, " ")
		.replace(/[吗呢吧么]\s*$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const withoutFillers = stripFillers(normalized);
	const tokens = withoutFillers.match(/[\p{Script=Han}]+|[A-Za-z][A-Za-z0-9_.-]*|\d+/gu);
	if (tokens == null || tokens.length === 0) return "";
	const joined = tokens.join("");
	return joined.slice(0, MAX_SUBJECT_CHARS);
}

function alreadyEndsWithAction(subject: string, action: string): boolean {
	if (action.length === 0) return true;
	return subject.endsWith(action) || /研究|分析|审查|验证|修复|总结|实现|对比|抓取$/.test(subject);
}

export function deriveAgentDisplayName(task: string | null | undefined): string {
	if (task == null || task.trim().length === 0) return DEFAULT_SUBAGENT_NAME;
	const action = inferActionSuffix(task);
	const subject = compactSubject(task);
	if (subject.length === 0) {
		return action.length > 0 ? `${DEFAULT_SUBAGENT_NAME} · ${action}` : DEFAULT_SUBAGENT_NAME;
	}
	if (alreadyEndsWithAction(subject, action)) return subject;
	return `${subject}${action}`;
}

export function agentDisplayName(
	kind: "main" | "subagent",
	task: string | null | undefined,
	displayName?: string | null,
): string {
	const trimmed = displayName?.trim();
	if (trimmed != null && trimmed.length > 0) return trimmed;
	if (kind === "main") return DEFAULT_MAIN_NAME;
	return deriveAgentDisplayName(task);
}
