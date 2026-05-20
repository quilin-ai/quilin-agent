"use client";

/**
 * QueueArea — Codex Mac app 风格的排队消息编辑区。
 *
 * QUI-183 P1(2026-05-20):排队消息从 ConversationView 的 q-view 会话流中
 * 抽离出来,渲染在 Composer 上方独立区域。语义上 queued message 不是会话
 * 内容,而是"待执行的指令列表"(可编辑、可重排、可删除)。
 *
 * P1 范围:只做 UI 抽离 + 紧凑 list 渲染。
 *   - 每条单行:↳ 序号 + 文本 + ⃝ 删除占位 + ⋯ 菜单占位
 *   - 操作回调(onDelete / onMoveUp / onMoveDown / onPinTop / onEdit /
 *     onReorder)接口预留,P1 全部 no-op(button disabled),P3 实现真行为
 *   - 不引入 @dnd-kit,follow-up 评估
 *
 * P3 将接入:
 *   - delete(单条)
 *   - reorder(原生 HTML5 drag-and-drop 或 上/下按钮)
 *   - 编辑文本(textarea overlay)
 *   - 指定位置插入(光标 hover 显示插入条)
 */

import type { ReactElement } from "react";

export interface QueuedUserMessageView {
	readonly id: string;
	readonly text: string;
}

export interface QueueAreaProps {
	readonly queued: readonly QueuedUserMessageView[];
	/** P3 接入:点击删除按钮回调。P1 传 undefined → 按钮渲染为 disabled placeholder。 */
	readonly onDelete?: (id: string) => void;
	/** P3 接入:菜单选"置顶"。 */
	readonly onPinTop?: (id: string) => void;
	/** P3 接入:菜单选"下移"。 */
	readonly onMoveDown?: (id: string) => void;
	/** P3 接入:菜单选"上移"。 */
	readonly onMoveUp?: (id: string) => void;
	/** P3 接入:点击 ✏ 进入编辑 textarea。 */
	readonly onEdit?: (id: string) => void;
}

export function QueueArea({
	queued,
	onDelete,
	onPinTop,
	onMoveDown,
	onMoveUp,
	onEdit,
}: QueueAreaProps): ReactElement | null {
	if (queued.length === 0) return null;
	return (
		<section
			className="q-queue-area"
			data-testid="queue-area"
			aria-label="排队消息 · queued messages"
		>
			<div className="q-queue-area-header">
				<span className="q-queue-area-count">
					<strong>{queued.length}</strong>条待发 · queued
				</span>
				<span className="q-queue-area-hint">
					按顺序送入,可删除/重排 · processed in order, editable
				</span>
			</div>
			<ul className="q-queue-area-list">
				{queued.map((item, idx) => (
					<QueueAreaRow
						key={item.id}
						item={item}
						position={idx + 1}
						isFirst={idx === 0}
						isLast={idx === queued.length - 1}
						onDelete={onDelete}
						onPinTop={onPinTop}
						onMoveDown={onMoveDown}
						onMoveUp={onMoveUp}
						onEdit={onEdit}
					/>
				))}
			</ul>
		</section>
	);
}

interface QueueAreaRowProps {
	readonly item: QueuedUserMessageView;
	readonly position: number;
	readonly isFirst: boolean;
	readonly isLast: boolean;
	readonly onDelete?: (id: string) => void;
	readonly onPinTop?: (id: string) => void;
	readonly onMoveDown?: (id: string) => void;
	readonly onMoveUp?: (id: string) => void;
	readonly onEdit?: (id: string) => void;
}

function QueueAreaRow({
	item,
	position,
	isFirst,
	isLast,
	onDelete,
	onPinTop,
	onMoveDown,
	onMoveUp,
	onEdit,
}: QueueAreaRowProps): ReactElement {
	const interactive =
		onDelete != null ||
		onPinTop != null ||
		onMoveDown != null ||
		onMoveUp != null ||
		onEdit != null;
	return (
		<li className="q-queue-area-row" data-testid={`queue-row-${item.id}`} data-position={position}>
			<span className="q-queue-area-row-marker" aria-hidden="true">
				↳ {position}
			</span>
			<span className="q-queue-area-row-text" title={item.text}>
				{item.text}
			</span>
			<div className="q-queue-area-row-actions" data-interactive={interactive ? "true" : "false"}>
				<button
					type="button"
					className="q-queue-area-row-action"
					aria-label={`上移 · move up (queue ${position})`}
					data-testid={`queue-row-${item.id}-move-up`}
					disabled={onMoveUp == null || isFirst}
					onClick={onMoveUp == null ? undefined : () => onMoveUp(item.id)}
				>
					↑
				</button>
				<button
					type="button"
					className="q-queue-area-row-action"
					aria-label={`下移 · move down (queue ${position})`}
					data-testid={`queue-row-${item.id}-move-down`}
					disabled={onMoveDown == null || isLast}
					onClick={onMoveDown == null ? undefined : () => onMoveDown(item.id)}
				>
					↓
				</button>
				<button
					type="button"
					className="q-queue-area-row-action"
					aria-label={`置顶 · pin top (queue ${position})`}
					data-testid={`queue-row-${item.id}-pin-top`}
					disabled={onPinTop == null || isFirst}
					onClick={onPinTop == null ? undefined : () => onPinTop(item.id)}
				>
					⤒
				</button>
				<button
					type="button"
					className="q-queue-area-row-action"
					aria-label={`编辑 · edit (queue ${position})`}
					data-testid={`queue-row-${item.id}-edit`}
					disabled={onEdit == null}
					onClick={onEdit == null ? undefined : () => onEdit(item.id)}
				>
					✏
				</button>
				<button
					type="button"
					className="q-queue-area-row-action q-queue-area-row-action-danger"
					aria-label={`删除 · delete (queue ${position})`}
					data-testid={`queue-row-${item.id}-delete`}
					disabled={onDelete == null}
					onClick={onDelete == null ? undefined : () => onDelete(item.id)}
				>
					⃝
				</button>
			</div>
		</li>
	);
}
