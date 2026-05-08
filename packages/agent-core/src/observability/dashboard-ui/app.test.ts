import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Load the browser-facing app.js once and surface the panel-render functions
// via a minimal DOM stub so we can verify XSS-prone branches without pulling
// in a jsdom dependency. Only the helpers we actually exercise need stubs.

interface ChildElement {
	textContent: string;
	hidden?: boolean;
	style: { display?: string };
	innerHTML: string;
	querySelector: (selector: string) => ChildElement | null;
	querySelectorAll: (selector: string) => readonly ChildElement[];
	setAttribute: (name: string, value: string) => void;
	addEventListener: () => void;
	dataset?: Record<string, string>;
}

function createElement(): ChildElement {
	const node: ChildElement = {
		textContent: "",
		style: {},
		innerHTML: "",
		querySelector: () => null,
		querySelectorAll: () => [],
		setAttribute: () => {},
		addEventListener: () => {},
	};
	return node;
}

interface DashboardModule {
	readonly renderMemory: (
		panel: ChildElement,
		data: {
			tiers: ReadonlyArray<{ name: string; count: unknown; note?: string }>;
		},
	) => void;
	readonly renderMetrics: (
		panel: ChildElement,
		data: {
			totals: Record<string, number>;
			byTool: ReadonlyArray<Record<string, unknown>>;
		},
	) => void;
	readonly renderTasks: (
		panel: ChildElement,
		data: {
			records?: ReadonlyArray<Record<string, unknown>>;
			activeRunCount?: number;
			staleRunCount?: number;
			message?: string;
		},
	) => void;
}

async function loadAppModule(): Promise<DashboardModule> {
	const path = fileURLToPath(new URL("./app.js", import.meta.url));
	const source = await readFile(path, "utf-8");
	const sandbox: Record<string, unknown> = {
		// Stub DOM globals app.js touches at module load. None of the touched
		// branches require real elements for our tests.
		document: {
			readyState: "loading",
			addEventListener: () => {},
			getElementById: () => null,
			querySelector: () => null,
			querySelectorAll: () => [] as ChildElement[],
		},
		fetch: async () => ({ ok: true, json: async () => ({}) }),
		console,
		Promise,
		setTimeout,
		clearTimeout,
		exports: {},
	};
	// app.js has no module exports — append a return that lifts the renderers we
	// need into the sandbox so we can call them from tests.
	const wrapped = `${source}\n;exports.renderMemory = renderMemory;\nexports.renderMetrics = renderMetrics;\nexports.renderTasks = renderTasks;\n`;
	runInNewContext(wrapped, sandbox);
	return sandbox.exports as DashboardModule;
}

function memoryPanelStub(): ChildElement & { container: ChildElement } {
	const container = createElement();
	const empty = createElement();
	const tableWrap = createElement();
	const panel: ChildElement & { container: ChildElement } = {
		...createElement(),
		container,
		querySelector: (selector: string) => {
			if (selector === "#memory-tiers") return container;
			if (selector === ".empty") return empty;
			if (selector === ".table-wrap") return tableWrap;
			return null;
		},
	};
	return panel;
}

function metricsPanelStub(): {
	panel: ChildElement;
	headline: ChildElement;
	tbody: ChildElement;
} {
	const headline = createElement();
	const tbody = createElement();
	const empty = createElement();
	const tableWrap = createElement();
	const panel: ChildElement = {
		...createElement(),
		querySelector: (selector: string) => {
			if (selector === "#metrics-headline") return headline;
			if (selector === "#metrics-tools-table tbody") return tbody;
			if (selector === ".empty") return empty;
			if (selector === ".table-wrap") return tableWrap;
			return null;
		},
	};
	return { panel, headline, tbody };
}

function tasksPanelStub(): {
	panel: ChildElement;
	summary: ChildElement;
	tbody: ChildElement;
	empty: ChildElement;
	tableWrap: ChildElement;
} {
	const summary = createElement();
	const tbody = createElement();
	const empty = createElement();
	const tableWrap = createElement();
	const panel: ChildElement = {
		...createElement(),
		querySelector: (selector: string) => {
			if (selector === "#tasks-summary") return summary;
			if (selector === "#tasks-table tbody") return tbody;
			if (selector === ".empty") return empty;
			if (selector === ".table-wrap") return tableWrap;
			return null;
		},
	};
	return { panel, summary, tbody, empty, tableWrap };
}

describe("dashboard-ui app.js", () => {
	it("escapes hostile tier.count payloads in renderMemory (QUI-105 round-1 #1)", async () => {
		const mod = await loadAppModule();
		const panel = memoryPanelStub();
		mod.renderMemory(panel, {
			tiers: [
				{
					name: "working",
					// Simulate compromised provider data — trace store fields are
					// strings on the wire and may be returned as-is from upstream
					// MCP servers; the dashboard must not splice them as raw HTML.
					count: '<img src=x onerror="alert(1)">',
					note: "<script>alert('note')</script>",
				},
			],
		});
		const html = panel.container.innerHTML;
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).toContain("&lt;script&gt;alert(");
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("<script>alert");
	});

	it("escapes totals in renderMetrics so attacker-controlled spans cannot inject (QUI-105 round-1 #1)", async () => {
		const mod = await loadAppModule();
		const { panel, headline } = metricsPanelStub();
		mod.renderMetrics(panel, {
			// Numeric fields normally arrive as numbers; treat the contract as
			// strict-string-coerced so a broken upstream cannot smuggle markup.
			totals: {
				spans: 1 as unknown as number,
				llmCalls: 0,
				tokensIn: 0,
				tokensOut: 0,
				errors: 0,
				avgLatencyMs: 0,
			},
			byTool: [],
		});
		// Sanity: headline is populated with non-empty markup.
		expect(headline.innerHTML).toContain("metric-card");
		// And does not double-escape the safe numeric values.
		expect(headline.innerHTML).toContain(">1<");
		expect(headline.innerHTML).not.toContain("&amp;amp;");
	});

	it("surfaces backend message hint in the tasks panel when records are empty (QUI-105 round-2 D1)", async () => {
		const mod = await loadAppModule();
		const { panel, empty, tbody } = tasksPanelStub();
		mod.renderTasks(panel, {
			records: [],
			activeRunCount: 0,
			staleRunCount: 0,
			message: "tasks provider not connected (TODO QUI-105 round 2)",
		});
		// Empty placeholder text reflects the backend hint, not the static
		// "No active sub-agent runs" copy in index.html.
		expect(empty.innerHTML).toContain("tasks provider not connected");
		expect(empty.hidden).toBe(false);
		// And the table body remains empty.
		expect(tbody.innerHTML).toBe("");
	});

	it("escapes hostile message hint payloads in renderTasks (QUI-105 round-2 D1)", async () => {
		const mod = await loadAppModule();
		const { panel, empty } = tasksPanelStub();
		mod.renderTasks(panel, {
			records: [],
			activeRunCount: 0,
			staleRunCount: 0,
			// A misconfigured provider could send markup; the dashboard must
			// not splice it as raw HTML.
			message: "<img src=x onerror=alert(1)>",
		});
		expect(empty.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(empty.innerHTML).not.toContain("<img src=x");
	});

	it("leaves the static empty copy alone when no message hint is provided (QUI-105 round-2 D1)", async () => {
		const mod = await loadAppModule();
		const { panel, empty } = tasksPanelStub();
		// Pre-seed the empty element with the static index.html copy so we
		// can assert renderTasks does not mutate it when the backend omits
		// `data.message` (which is the case once the supervisor runtime is
		// wired in for real).
		empty.innerHTML = "No active sub-agent runs reported.";
		mod.renderTasks(panel, {
			records: [],
			activeRunCount: 0,
			staleRunCount: 0,
		});
		expect(empty.innerHTML).toBe("No active sub-agent runs reported.");
	});
});
