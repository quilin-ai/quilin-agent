export type EventLineKind = "default" | "critical" | "memory" | "skill";

export interface EventLineProps {
	readonly kw: string;
	readonly name: string;
	readonly desc?: string;
	readonly meta?: string;
	readonly kind?: EventLineKind;
}

/**
 * Light single-line event row — for memory recalls, skill loads, redaction,
 * heartbeat, etc. No body; only chrome + meta string (per demo lines 626–666).
 */
export function EventLine({ kw, name, desc, meta, kind = "default" }: EventLineProps) {
	return (
		<div className="q-event-line" data-kind={kind}>
			<div className="ev-main">
				<span className="ev-kw">{kw}</span>
				<span className="ev-name">{name}</span>
				{desc ? <span className="ev-desc">{desc}</span> : null}
			</div>
			{meta ? <span className="ev-meta">{meta}</span> : null}
		</div>
	);
}
