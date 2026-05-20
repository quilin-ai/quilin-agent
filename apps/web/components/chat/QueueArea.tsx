"use client";

/**
 * QueueArea — Codex Mac app 风格的排队消息编辑区。
 *
 * QUI-183 P1(2026-05-20):排队消息从 ConversationView 的 q-view 会话流中
 * 抽离出来,渲染在 Composer 上方独立区域。语义上 queued message 不是会话
 * 内容,而是"待执行的指令列表"(可编辑、可重排、可删除)。
 *
 * QUI-183 P3(2026-05-20):加 5 个交互回调 + 原生 HTML5 drag-and-drop。
 *   - onDelete(id):删除单条
 *   - onMoveUp / onMoveDown(id):上移 / 下移
 *   - onPinTop(id):置顶
 *   - onEdit(id, newText):编辑文本(行内 textarea + 保存 / 取消)
 *   - onReorder(fromId, toId):拖拽 reorder(放到目标行位置)
 *
 * 不引入 @dnd-kit,follow-up 评估移动端触控拖拽。
 */

import { type ReactElement, useState } from "react";

export interface QueuedUserMessageView {
	readonly id: string;
	readonly text: string;
}

export interface QueueAreaProps {
	readonly queued: readonly QueuedUserMessageView[];
	readonly onDelete?: (id: string) => void;
	readonly onPinTop?: (id: string) => void;
	readonly onMoveDown?: (id: string) => void;
	readonly onMoveUp?: (id: string) => void;
	readonly onEdit?: (id: string, newText: string) => void;
	readonly onReorder?: (fromId: string, toId: string) => void;
}

export function QueueArea({
	queued,
	onDelete,
	onPinTop,
	onMoveDown,
	onMoveUp,
	onEdit,
	onReorder,
}: QueueAreaProps): ReactElement | null {
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [dragOverId, setDragOverId] = useState<string | null>(null);
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
					{onReorder != null ? "拖拽重排 · drag to reorder" : "按顺序送入 · processed in order"}
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
						onReorder={onReorder}
						draggingId={draggingId}
						dragOverId={dragOverId}
						setDraggingId={setDraggingId}
						setDragOverId={setDragOverId}
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
	readonly onEdit?: (id: string, newText: string) => void;
	readonly onReorder?: (fromId: string, toId: string) => void;
	readonly draggingId: string | null;
	readonly dragOverId: string | null;
	readonly setDraggingId: (id: string | null) => void;
	readonly setDragOverId: (id: string | null) => void;
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
	onReorder,
	draggingId,
	dragOverId,
	setDraggingId,
	setDragOverId,
}: QueueAreaRowProps): ReactElement {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.text);

	const beginEdit = (): void => {
		if (onEdit == null) return;
		setDraft(item.text);
		setEditing(true);
	};
	const saveEdit = (): void => {
		if (onEdit == null) return;
		const trimmed = draft.trim();
		if (trimmed.length === 0) {
			setEditing(false);
			setDraft(item.text);
			return;
		}
		onEdit(item.id, trimmed);
		setEditing(false);
	};
	const cancelEdit = (): void => {
		setEditing(false);
		setDraft(item.text);
	};

	const dragEnabled = onReorder != null && !editing;

	return (
		<li
			className="q-queue-area-row"
			data-testid={`queue-row-${item.id}`}
			data-position={position}
			data-dragging={draggingId === item.id ? "true" : "false"}
			data-drag-over={dragOverId === item.id && draggingId !== item.id ? "true" : "false"}
			draggable={dragEnabled}
			onDragStart={
				dragEnabled
					? (ev) => {
							setDraggingId(item.id);
							ev.dataTransfer.effectAllowed = "move";
							ev.dataTransfer.setData("text/plain", item.id);
						}
					: undefined
			}
			onDragEnter={
				dragEnabled
					? () => {
							if (draggingId != null && draggingId !== item.id) setDragOverId(item.id);
						}
					: undefined
			}
			onDragOver={
				dragEnabled
					? (ev) => {
							ev.preventDefault();
							ev.dataTransfer.dropEffect = "move";
						}
					: undefined
			}
			onDragLeave={
				dragEnabled
					? () => {
							if (dragOverId === item.id) setDragOverId(null);
						}
					: undefined
			}
			onDrop={
				dragEnabled
					? (ev) => {
							ev.preventDefault();
							const fromId = ev.dataTransfer.getData("text/plain") || draggingId;
							setDraggingId(null);
							setDragOverId(null);
							if (fromId && fromId !== item.id && onReorder != null) {
								onReorder(fromId, item.id);
							}
						}
					: undefined
			}
			onDragEnd={
				dragEnabled
					? () => {
							setDraggingId(null);
							setDragOverId(null);
						}
					: undefined
			}
		>
			<span className="q-queue-area-row-marker" aria-hidden="true">
				↳ {position}
			</span>
			{editing ? (
				<>
					<textarea
						className="q-queue-area-row-edit"
						data-testid={`queue-row-${item.id}-edit-input`}
						value={draft}
						onChange={(ev) => setDraft(ev.target.value)}
						onKeyDown={(ev) => {
							if (ev.key === "Enter" && !ev.shiftKey) {
								ev.preventDefault();
								saveEdit();
							} else if (ev.key === "Escape") {
								ev.preventDefault();
								cancelEdit();
							}
						}}
						// biome-ignore lint/a11y/noAutofocus: 行内编辑需即时聚焦
						autoFocus
						rows={1}
					/>
					<div className="q-queue-area-row-actions">
						<button
							type="button"
							className="q-queue-area-row-action"
							aria-label="保存 · save"
							data-testid={`queue-row-${item.id}-edit-save`}
							onClick={saveEdit}
						>
							✓
						</button>
						<button
							type="button"
							className="q-queue-area-row-action q-queue-area-row-action-danger"
							aria-label="取消 · cancel"
							data-testid={`queue-row-${item.id}-edit-cancel`}
							onClick={cancelEdit}
						>
							×
						</button>
					</div>
				</>
			) : (
				<>
					<span className="q-queue-area-row-text" title={item.text}>
						{item.text}
					</span>
					<div className="q-queue-area-row-actions">
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
							onClick={onEdit == null ? undefined : beginEdit}
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
				</>
			)}
		</li>
	);
}
