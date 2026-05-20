import { useChat } from "@ai-sdk/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationView } from "@/components/chat/ConversationView";

vi.mock("@ai-sdk/react", () => ({
	useChat: vi.fn(),
}));

vi.mock("ai", () => ({
	DefaultChatTransport: class DefaultChatTransport {},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

const baseMessages: readonly UIMessage[] = [
	{
		id: "user-1",
		role: "user",
		parts: [{ type: "text", text: "第一轮问题" }],
	},
	{
		id: "assistant-1",
		role: "assistant",
		parts: [{ type: "text", text: "第一轮还在输出" }],
	},
] as readonly UIMessage[];

const persistedToolMessages: readonly UIMessage[] = [
	{
		id: "user-fetch",
		role: "user",
		parts: [{ type: "text", text: "抓取 example.com" }],
	},
	{
		id: "assistant-fetch",
		role: "assistant",
		parts: [
			{
				type: "dynamic-tool",
				toolName: "web_fetch",
				toolCallId: "tool-1",
				state: "output-available",
				input: { url: "https://example.com" },
				output: { title: "Example Domain" },
			},
			{ type: "text", text: "标题是 Example Domain。" },
		],
	},
] as readonly UIMessage[];

function sessionResponse(messages: readonly UIMessage[]): Response {
	return Response.json({
		session: {
			id: "s",
			title: "s",
			created_at: Date.now(),
			updated_at: Date.now(),
			message_count: messages.length,
		},
		messages,
	});
}

describe("ConversationView queued sends", () => {
	beforeEach(() => {
		window.localStorage.clear();
		window.sessionStorage.clear();
		Element.prototype.scrollIntoView = vi.fn();
		vi.clearAllMocks();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					ok: true,
					data: { exists: false, status: null, epoch: "test-epoch" },
				}),
			),
		);
	});

	it("queues a user submit while the assistant turn is streaming, then sends after ready", async () => {
		const sendMessage = vi.fn(async () => undefined);
		const resumeStream = vi.fn(async () => undefined);
		const chatState = {
			messages: baseMessages,
			status: "streaming",
		};
		vi.mocked(useChat).mockImplementation(
			() =>
				({
					...chatState,
					sendMessage,
					resumeStream,
				}) as unknown as ReturnType<typeof useChat>,
		);

		const { rerender } = render(<ConversationView sessionId="queue-test-session" />);
		const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "第二轮问题" } });
		// QUI-183 P2:streaming 中 send button 被 stop button 替换(composer-stop),
		// 用户改用 Enter 触发 enqueue(textarea onKey → form submit)。
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

		expect(sendMessage).not.toHaveBeenCalled();
		// QUI-183 P1:排队消息从会话流抽到 Composer 上方 QueueArea 组件,
		// 旧 q-queued-badge "已排队 · queued N" 被新 header "{N}条待发 · queued" +
		// 行 marker "↳ N" 替代。test 改为断言 QueueArea section 出现 + 包含文本。
		const queueArea = screen.getByTestId("queue-area");
		expect(queueArea).toBeInTheDocument();
		expect(queueArea.textContent ?? "").toContain("第二轮问题");
		expect(queueArea.textContent ?? "").toContain("1");
		expect(queueArea.textContent ?? "").toMatch(/queued/i);

		chatState.status = "ready";
		rerender(<ConversationView sessionId="queue-test-session" />);

		await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ text: "第二轮问题" }));
	});

	it("hydrates the next session after client-side navigation changes sessionId", async () => {
		const sendMessage = vi.fn(async () => undefined);
		const resumeStream = vi.fn(async () => undefined);
		const useChatCalls: UIMessage[][] = [];
		vi.mocked(useChat).mockImplementation((options?: Parameters<typeof useChat>[0]) => {
			const seededMessages =
				options != null && "messages" in options && Array.isArray(options.messages)
					? options.messages
					: [];
			useChatCalls.push(seededMessages);
			return {
				id: "mock-chat",
				messages: seededMessages,
				setMessages: vi.fn(),
				sendMessage,
				resumeStream,
				stop: vi.fn(async () => undefined),
				status: "ready",
				error: undefined,
				regenerate: vi.fn(),
				clearError: vi.fn(),
				addToolResult: vi.fn(),
				addToolOutput: vi.fn(),
				addToolApprovalResponse: vi.fn(),
			} as unknown as ReturnType<typeof useChat>;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/sessions/session-b")) return sessionResponse(persistedToolMessages);
				return new Response("not found", { status: 404 });
			}),
		);

		const { rerender } = render(<ConversationView sessionId="session-a" />);
		await screen.findByText(/开始对话/);

		rerender(<ConversationView sessionId="session-b" />);

		await screen.findByText("标题是 Example Domain。");
		expect(screen.queryByText(/开始对话/)).not.toBeInTheDocument();
		expect(useChatCalls.at(-1)?.map((m) => m.id)).toEqual(["user-fetch", "assistant-fetch"]);
	});

	it("syncs persisted assistant/tool parts after the chat status becomes ready", async () => {
		const sendMessage = vi.fn(async () => undefined);
		const resumeStream = vi.fn(async () => undefined);
		const stop = vi.fn(async () => undefined);
		let chatStatus = "streaming";
		let chatMessages: UIMessage[] = [
			{
				id: "user-fetch",
				role: "user",
				parts: [{ type: "text", text: "抓取 example.com" }],
			},
		];
		vi.mocked(useChat).mockImplementation(
			() =>
				({
					id: "mock-chat",
					messages: chatMessages,
					setMessages: (next: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])): void => {
						chatMessages = typeof next === "function" ? next(chatMessages) : next;
					},
					sendMessage,
					resumeStream,
					stop,
					status: chatStatus,
					error: undefined,
					regenerate: vi.fn(),
					clearError: vi.fn(),
					addToolResult: vi.fn(),
					addToolOutput: vi.fn(),
					addToolApprovalResponse: vi.fn(),
				}) as unknown as ReturnType<typeof useChat>,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/chat/status")) {
					return Response.json({
						ok: true,
						data: { exists: true, status: "running", epoch: "test-epoch" },
					});
				}
				if (url.includes("/api/sessions/stream-sync-session")) {
					return sessionResponse(persistedToolMessages);
				}
				return new Response("not found", { status: 404 });
			}),
		);

		const { rerender } = render(<ConversationView sessionId="stream-sync-session" />);
		await screen.findByText("抓取 example.com");
		expect(screen.queryByText("标题是 Example Domain。")).not.toBeInTheDocument();

		chatStatus = "ready";
		rerender(<ConversationView sessionId="stream-sync-session" />);

		await waitFor(() =>
			expect(chatMessages.map((message) => message.id)).toEqual(["user-fetch", "assistant-fetch"]),
		);

		await act(async () => {
			rerender(<ConversationView sessionId="stream-sync-session" />);
		});
		expect(await screen.findByText("标题是 Example Domain。")).toBeInTheDocument();
		expect(screen.getByText(/web_fetch/)).toBeInTheDocument();
	});

	it("does not call useChat.stop from the server-terminal watchdog before draining queued sends", async () => {
		const sendMessage = vi.fn(async () => undefined);
		const resumeStream = vi.fn(async () => undefined);
		const stop = vi.fn(async () => undefined);
		const chatMessages: UIMessage[] = [];
		vi.mocked(useChat).mockImplementation(
			() =>
				({
					id: "mock-chat",
					messages: chatMessages,
					setMessages: vi.fn(),
					sendMessage,
					resumeStream,
					stop,
					status: "ready",
					error: undefined,
					regenerate: vi.fn(),
					clearError: vi.fn(),
					addToolResult: vi.fn(),
					addToolOutput: vi.fn(),
					addToolApprovalResponse: vi.fn(),
				}) as unknown as ReturnType<typeof useChat>,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/chat/status")) {
					return Response.json({
						ok: true,
						data: { exists: true, status: "completed", epoch: "test-epoch" },
					});
				}
				if (url.includes("/api/sessions/watchdog-stop-race")) {
					return sessionResponse([]);
				}
				return new Response("not found", { status: 404 });
			}),
		);

		render(<ConversationView sessionId="watchdog-stop-race" />);
		const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "下一条不能被 watchdog stop 抢断" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

		await waitFor(() =>
			expect(sendMessage).toHaveBeenCalledWith({ text: "下一条不能被 watchdog stop 抢断" }),
		);
		expect(stop).not.toHaveBeenCalled();
	});
});
