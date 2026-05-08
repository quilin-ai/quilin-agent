// Quilin Observability Dashboard — vanilla JS controller.
// 7-panel single-page UI. No bundler, no framework.

const PANELS = [
	"tasks",
	"memory",
	"tools",
	"metrics",
	"topology",
	"sessions",
	"skills",
];

const ENDPOINTS = {
	tasks: "/api/dashboard/tasks",
	memory: "/api/dashboard/memory",
	tools: "/api/dashboard/tools",
	metrics: "/api/dashboard/metrics",
	topology: "/api/dashboard/topology",
	sessions: "/api/dashboard/sessions",
	skills: "/api/dashboard/skills-mcp",
};

function escape(value) {
	if (value == null) return "";
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function badgeClass(status) {
	switch (status) {
		case "ready":
		case "active":
		case "connected":
		case "ok":
			return "badge-ok";
		case "degraded":
		case "warning":
		case "pending_repl_apply":
			return "badge-warn";
		case "booting":
		case "configured":
		case "info":
			return "badge-info";
		case "offline":
		case "disconnected":
		case "error":
		case "failed":
		case "empty":
			return "badge-err";
		default:
			return "badge-info";
	}
}

function badge(status) {
	const cls = badgeClass(String(status ?? "unknown"));
	return `<span class="badge ${cls}">${escape(status ?? "unknown")}</span>`;
}

async function fetchJson(url) {
	const response = await fetch(url, {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`${url} responded ${response.status}`);
	}
	return response.json();
}

function setEmpty(panel, isEmpty) {
	const empty = panel.querySelector(".empty");
	const tableWrap = panel.querySelector(".table-wrap");
	if (empty != null) empty.hidden = !isEmpty;
	if (tableWrap != null) tableWrap.style.display = isEmpty ? "none" : "";
}

function renderKvGrid(container, entries) {
	container.innerHTML = entries
		.map(
			([label, value]) =>
				`<div class="label">${escape(label)}</div><div>${value}</div>`,
		)
		.join("");
}

// Render metric cards.
// `card.value` is treated as text and is auto-escaped (default safe path).
// `card.valueHtml` is treated as already-escaped HTML for callers that need
// inline layout markup (e.g. `<br>` between count and note). Callers that opt
// into `valueHtml` are responsible for escaping every dynamic substring inside
// it; the helper does NOT escape it. When both are provided, `valueHtml` wins.
function renderMetricCards(container, cards) {
	container.innerHTML = cards
		.map((card) => {
			const valueMarkup =
				card.valueHtml != null
					? card.valueHtml
					: escape(String(card.value ?? ""));
			return `
			<div class="metric-card">
				<div class="metric-label">${escape(card.label)}</div>
				<div class="metric-value">${valueMarkup}</div>
			</div>
		`;
		})
		.join("");
}

// === Tasks panel ===
function renderTasks(panel, data) {
	const records = data.records ?? [];
	const summary = panel.querySelector("#tasks-summary");
	renderKvGrid(summary, [
		["Active runs", `<strong>${data.activeRunCount ?? 0}</strong>`],
		["Stale runs", `<strong>${data.staleRunCount ?? 0}</strong>`],
		["Reported events", `<strong>${records.length}</strong>`],
	]);
	const tbody = panel.querySelector("#tasks-table tbody");
	tbody.innerHTML = records
		.map(
			(record) => `
			<tr>
				<td><code>${escape(record.childRunId ?? "-")}</code></td>
				<td><code>${escape(record.taskId ?? "-")}</code></td>
				<td>${badge(record.eventType)}</td>
				<td>${badge(record.severity)}</td>
				<td>${escape(record.title)}</td>
				<td>${escape(record.summary)}</td>
				<td><span class="muted">${escape(record.timestamp)}</span></td>
			</tr>
		`,
		)
		.join("");
	setEmpty(panel, records.length === 0);
}

// === Memory panel ===
function renderMemory(panel, data) {
	const tiers = data.tiers ?? [];
	const container = panel.querySelector("#memory-tiers");
	if (tiers.length === 0) {
		container.innerHTML = "";
		setEmpty(panel, true);
		return;
	}
	renderMetricCards(
		container,
		tiers.map((tier) => ({
			label: tier.name,
			// tier.count and tier.note can both originate from untrusted MCP /
			// TraceStore data, so escape every dynamic field before splicing it
			// into the layout markup.
			valueHtml: `${escape(String(tier.count ?? 0))}<br><span class="muted" style="font-size:.7rem">${escape(tier.note ?? "")}</span>`,
		})),
	);
	setEmpty(panel, false);
}

// === Tools panel ===
function renderTools(panel, data) {
	const tools = data.tools ?? [];
	renderKvGrid(panel.querySelector("#tools-summary"), [
		["Total tools", `<strong>${data.total ?? tools.length}</strong>`],
		[
			"By namespace",
			Object.entries(data.byNamespace ?? {})
				.map(
					([ns, n]) =>
						`<span class="badge badge-info">${escape(ns)}: ${n}</span>`,
				)
				.join(" ") || "<span class='muted'>none</span>",
		],
	]);
	const tbody = panel.querySelector("#tools-table tbody");
	tbody.innerHTML = tools
		.map(
			(tool) => `
			<tr>
				<td><code>${escape(tool.name)}</code></td>
				<td>${escape(tool.namespace ?? "-")}</td>
				<td>${escape(tool.category ?? "-")}</td>
				<td>${badge(tool.riskLevel)}</td>
			</tr>
		`,
		)
		.join("");
	setEmpty(panel, tools.length === 0);
}

// === Metrics panel ===
function renderMetrics(panel, data) {
	const headline = panel.querySelector("#metrics-headline");
	const totals = data.totals ?? {};
	// `value` is the text-only path — renderMetricCards escapes it for us.
	renderMetricCards(headline, [
		{ label: "Total Spans", value: String(totals.spans ?? 0) },
		{ label: "LLM Calls", value: String(totals.llmCalls ?? 0) },
		{ label: "Tokens In", value: String(totals.tokensIn ?? 0) },
		{ label: "Tokens Out", value: String(totals.tokensOut ?? 0) },
		{ label: "Errors", value: String(totals.errors ?? 0) },
		{ label: "Avg Latency (ms)", value: String(totals.avgLatencyMs ?? 0) },
	]);
	const tbody = panel.querySelector("#metrics-tools-table tbody");
	const byTool = data.byTool ?? [];
	tbody.innerHTML = byTool
		.map(
			(row) => `
			<tr>
				<td><code>${escape(row.tool)}</code></td>
				<td>${escape(String(row.calls ?? 0))}</td>
				<td>${escape(String(row.errors ?? 0))}</td>
				<td>${escape(String(row.p50LatencyMs ?? "-"))}</td>
				<td>${escape(String(row.p95LatencyMs ?? "-"))}</td>
			</tr>
		`,
		)
		.join("");
	setEmpty(panel, byTool.length === 0 && (totals.spans ?? 0) === 0);
}

// === Topology panel ===
function renderTopology(panel, data) {
	const summary = panel.querySelector("#topology-summary");
	renderKvGrid(summary, [
		["Supervisor", badge(data.supervisorStatus ?? "unknown")],
		["Active runs", `<strong>${data.activeRunCount ?? 0}</strong>`],
		["Total runs tracked", `<strong>${data.totalRunCount ?? 0}</strong>`],
	]);
	const tbody = panel.querySelector("#topology-table tbody");
	const runs = data.runs ?? [];
	tbody.innerHTML = runs
		.map(
			(run) => `
			<tr>
				<td><code>${escape(run.runId)}</code></td>
				<td><code>${escape(run.taskId ?? "-")}</code></td>
				<td>${escape(run.workerName ?? "-")}</td>
				<td>${badge(run.status)}</td>
				<td><span class="muted">${escape(run.startedAt ?? "-")}</span></td>
			</tr>
		`,
		)
		.join("");
	setEmpty(panel, runs.length === 0);
}

// === Sessions panel ===
function renderSessions(panel, data) {
	const summary = panel.querySelector("#sessions-summary");
	renderKvGrid(summary, [
		["Total sessions", `<strong>${data.total ?? 0}</strong>`],
		["Active", `<strong>${data.activeCount ?? 0}</strong>`],
		["Terminal", `<strong>${data.terminalCount ?? 0}</strong>`],
	]);
	const tbody = panel.querySelector("#sessions-table tbody");
	const sessions = data.sessions ?? [];
	tbody.innerHTML = sessions
		.map(
			(session) => `
			<tr>
				<td><code>${escape(session.sessionId)}</code></td>
				<td>${badge(session.status)}</td>
				<td>${escape(session.source ?? "-")}</td>
				<td>${escape(String(session.turnCount ?? "-"))}</td>
				<td>${escape(String(session.messageCount ?? "-"))}</td>
				<td><span class="muted">${escape(session.lastActiveAt ?? session.createdAt ?? "-")}</span></td>
			</tr>
		`,
		)
		.join("");
	setEmpty(panel, sessions.length === 0);
}

// === Skills / MCP / Config / Providers panel ===
function renderSkillsMcp(panel, data) {
	const skills = data.skills?.catalog ?? [];
	panel.querySelector("#skills-count").textContent = `(${skills.length})`;
	panel.querySelector("#skills-table tbody").innerHTML = skills
		.map(
			(skill) => `
			<tr>
				<td><code>${escape(skill.name)}</code></td>
				<td>${escape(skill.source ?? "-")}</td>
				<td>${escape(skill.trust ?? "-")}</td>
				<td>${skill.mandatory ? "yes" : "no"}</td>
			</tr>
		`,
		)
		.join("");

	const mcp = data.mcp?.servers ?? [];
	panel.querySelector("#mcp-count").textContent = `(${mcp.length})`;
	panel.querySelector("#mcp-table tbody").innerHTML = mcp
		.map(
			(server) => `
			<tr>
				<td><code>${escape(server.id)}</code></td>
				<td>${badge(server.status)}</td>
				<td><code>${escape(server.command)}</code></td>
				<td>${escape(server.defaultRiskLevel ?? "-")}</td>
			</tr>
		`,
		)
		.join("");

	const config = data.config ?? null;
	const configBlock = panel.querySelector("#config-block");
	configBlock.textContent =
		config == null
			? "(no config provider connected)"
			: JSON.stringify(config, null, 2);

	const providers = data.providers ?? [];
	panel.querySelector("#providers-count").textContent = `(${providers.length})`;
	panel.querySelector("#providers-table tbody").innerHTML = providers
		.map(
			(provider) => `
			<tr>
				<td><code>${escape(provider.provider)}</code></td>
				<td>${badge(provider.status)}</td>
				<td>${escape((provider.configuredSources ?? []).join(", ") || "-")}</td>
				<td>${escape(provider.credentialStatus ?? "-")}</td>
			</tr>
		`,
		)
		.join("");
}

const RENDERERS = {
	tasks: renderTasks,
	memory: renderMemory,
	tools: renderTools,
	metrics: renderMetrics,
	topology: renderTopology,
	sessions: renderSessions,
	skills: renderSkillsMcp,
};

async function loadPanel(name) {
	const panel = document.getElementById(`panel-${name}`);
	if (panel == null) return;
	try {
		const data = await fetchJson(ENDPOINTS[name]);
		RENDERERS[name](panel, data);
	} catch (error) {
		const empty = panel.querySelector(".empty");
		if (empty != null) {
			empty.hidden = false;
			empty.textContent = `Failed to load: ${error.message}`;
		}
	}
}

async function refreshAll() {
	const stamp = new Date().toISOString();
	const status = document.getElementById("last-refresh");
	if (status != null) status.textContent = `Refreshing... ${stamp}`;
	await Promise.all(PANELS.map(loadPanel));
	if (status != null) status.textContent = `Last refresh: ${stamp}`;
}

function activateTab(name) {
	for (const panel of PANELS) {
		const tab = document.querySelector(`.tab[data-panel="${panel}"]`);
		const section = document.getElementById(`panel-${panel}`);
		const isActive = panel === name;
		if (tab != null)
			tab.setAttribute("aria-selected", isActive ? "true" : "false");
		if (section != null) {
			section.hidden = !isActive;
			section.setAttribute("aria-hidden", isActive ? "false" : "true");
		}
	}
}

function init() {
	for (const panel of PANELS) {
		const tab = document.querySelector(`.tab[data-panel="${panel}"]`);
		if (tab == null) continue;
		tab.addEventListener("click", () => activateTab(panel));
	}
	const refresh = document.getElementById("refresh-btn");
	if (refresh != null) refresh.addEventListener("click", () => refreshAll());
	activateTab("tasks");
	refreshAll();
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}
