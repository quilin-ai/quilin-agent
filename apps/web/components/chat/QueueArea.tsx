"use client";

/**
 * QueueArea — Codex Mac app 风格的排队消息编辑区。
 *
 * QUI-183 P1(2026-05-20):排队消息从 ConversationView 的 q-view 会话流中
 * 抽离出来,渲染在 Composer 上方独立区域。语义上 queued message 不是会话
 * 内容,而是"待执行的指令列表"(可编辑、可重排、可删除)。
 *
 * QUI-183 P3(2026-05-20):加 5 个交互回调 + 原生 HTML5 drag-and-drop。
 *
 * QUI-183 P3 UX 改进(2026-05-20,user feedback):
 *   - 点文字区域直接进入编辑(去掉 ✏ 按钮,减少视觉噪音)
 *   - 去掉 ⤒ 置顶按钮(用 ⏩ 立即插入语义代替)
 *   - 删除按钮 ⃝ → 🗑 垃圾桶(更符合通用 icon 语义)
 *   - 新增 ⏩ 立即插入按钮:把这条移到队头,当前 phase 完成后立即 drain
 *     (功能上 = 置顶 + drain semantics,语义上更明确"插队")
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
	// QUI-183 P3 UX 改进(2026-05-20):队列可收起。默认 expanded,user 点 ▼ 收起。
	// 收起时只显示 header(节省屏幕空间,会话区 padding 也减小)。
	const [collapsed, setCollapsed] = useState(false);
	if (queued.length === 0) return null;
	return (
		<section
			className="q-queue-area"
			data-testid="queue-area"
			data-collapsed={collapsed ? "true" : "false"}
			aria-label="排队消息 · queued messages"
		>
			<div className="q-queue-area-header">
				<button
					type="button"
					className="q-queue-area-toggle"
					aria-label={collapsed ? "展开队列 · expand" : "收起队列 · collapse"}
					data-testid="queue-area-toggle"
					onClick={() => setCollapsed((c) => !c)}
				>
					{collapsed ? "▶" : "▼"}
				</button>
				<span className="q-queue-area-count">
					<strong>{queued.length}</strong>条待发 · queued
				</span>
				<span className="q-queue-area-hint">
					{onReorder != null ? "拖拽重排 · drag to reorder" : "按顺序送入 · processed in order"}
				</span>
			</div>
			{collapsed ? null : (
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
			)}
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
							// IME guard:中日 IME 选词按 Enter 是确认候选词,不该提前 saveEdit。
							// 与 Composer.tsx onKey 同 pattern。QUI-183 iter cross-review
							// Reviewer A 提的 REAL #1 (2026-05-20)。
							const ne = ev.nativeEvent as KeyboardEvent & {
								readonly isComposing?: boolean;
							};
							if (ne.isComposing === true || ev.keyCode === 229) return;
							if (ev.key === "Enter" && !ev.shiftKey) {
								ev.preventDefault();
								saveEdit();
							} else if (ev.key === "Escape") {
								ev.preventDefault();
								cancelEdit();
							}
						}}
						onBlur={saveEdit}
						// biome-ignore lint/a11y/noAutofocus: 行内编辑需即时聚焦
						autoFocus
						rows={1}
					/>
					<div className="q-queue-area-row-actions">
						<button
							type="button"
							className="q-queue-area-row-action"
							aria-label="保存 · save (Enter)"
							data-testid={`queue-row-${item.id}-edit-save`}
							onClick={saveEdit}
						>
							✓
						</button>
						<button
							type="button"
							className="q-queue-area-row-action q-queue-area-row-action-danger"
							aria-label="取消 · cancel (Esc)"
							data-testid={`queue-row-${item.id}-edit-cancel`}
							onClick={cancelEdit}
						>
							×
						</button>
					</div>
				</>
			) : (
				<>
					{/* QUI-183 P3 UX 改进:点 text 直接进入编辑(无需 ✏ 按钮)。
					   用 <button type="button"> 包裹保证键盘可达 + a11y。 */}
					{onEdit != null ? (
						<button
							type="button"
							className="q-queue-area-row-text q-queue-area-row-text-button"
							data-testid={`queue-row-${item.id}-text`}
							title={`${item.text}\n\n点击编辑 / click to edit`}
							onClick={beginEdit}
						>
							{item.text}
						</button>
					) : (
						<span className="q-queue-area-row-text" title={item.text}>
							{item.text}
						</span>
					)}
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
						{/* 立即插入 = 把这条移到队头,当前 streaming phase 完成后立即 drain。
						   功能等同 pin-top,但语义更明确表达"插队优先发"。 */}
						<button
							type="button"
							className="q-queue-area-row-action q-queue-area-row-action-priority"
							aria-label={`立即插入 · jump queue (queue ${position}, drain next)`}
							data-testid={`queue-row-${item.id}-jump`}
							disabled={onPinTop == null || isFirst}
							onClick={onPinTop == null ? undefined : () => onPinTop(item.id)}
							title="立即插入 · 当前会话完成后立刻发送此条"
						>
							⏩
						</button>
						<button
							type="button"
							className="q-queue-area-row-action q-queue-area-row-action-danger"
							aria-label={`删除 · delete (queue ${position})`}
							data-testid={`queue-row-${item.id}-delete`}
							disabled={onDelete == null}
							onClick={onDelete == null ? undefined : () => onDelete(item.id)}
							title="删除 · remove this queued message"
						>
							🗑
						</button>
					</div>
				</>
			)}
		</li>
	);
}
