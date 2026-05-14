import { useChat } from "@ai-sdk/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
		fireEvent.click(screen.getByTestId("composer-send"));

		expect(sendMessage).not.toHaveBeenCalled();
		expect(screen.getByText("第二轮问题")).toBeInTheDocument();
		expect(screen.getByText(/已排队 · queued 1/)).toBeInTheDocument();

		chatState.status = "ready";
		rerender(<ConversationView sessionId="queue-test-session" />);

		await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ text: "第二轮问题" }));
	});
});
