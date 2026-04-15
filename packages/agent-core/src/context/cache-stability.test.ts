import { describe, expect, test } from "vitest";
import {
	normalizeSection,
	normalizeSortedList,
	sectionSemanticEqual,
} from "./cache-stability.js";

describe("normalizeSection", () => {
	test("合并多余空格", () => {
		expect(normalizeSection("hello   world")).toBe("hello world");
	});

	test("统一换行符", () => {
		expect(normalizeSection("a\r\nb\r\nc")).toBe("a\nb\nc");
	});

	test("去除行尾空白", () => {
		expect(normalizeSection("hello   \nworld  \n")).toBe("hello\nworld");
	});

	test("最多两个连续换行", () => {
		expect(normalizeSection("a\n\n\n\nb")).toBe("a\n\nb");
	});

	test("相同语义不同格式判定为等价", () => {
		expect(
			sectionSemanticEqual("hello   world\n\n\nfoo", "hello world\n\nfoo"),
		).toBe(true);
	});
});

describe("normalizeSortedList", () => {
	test("去重并排序", () => {
		expect(normalizeSortedList(["c", "a", "b", "a"])).toEqual(["a", "b", "c"]);
	});

	test("空列表返回空", () => {
		expect(normalizeSortedList([])).toEqual([]);
	});
});
