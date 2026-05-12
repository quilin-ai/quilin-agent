/**
 * Read and JSON-parse a Fetch `Request` body, normalising the empty-body
 * case to `{}` and surfacing parse failures as `SyntaxError`.
 *
 * Extracted so the empty / parseable / failing branches can be exercised
 * directly in a unit test without rebuilding the surrounding route
 * handlers.
 *
 * 读取并解析 Fetch Request 的 JSON body：空 body 返回 `{}`，解析失败
 * 抛 SyntaxError。抽成独立模块方便单测，三种分支都能直接覆盖。
 */

export async function readJsonBody(request: Request): Promise<unknown> {
	const text = await request.text();
	if (text.length === 0) {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new SyntaxError(
			`malformed JSON body: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
