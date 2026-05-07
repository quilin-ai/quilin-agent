import type {
	ControlPlaneAgentView,
	ControlPlaneMcpServerView,
	ControlPlaneMcpStatusView,
	ControlPlaneSessionSummary,
	ControlPlaneSkillSummary,
	ControlPlaneSkillsCatalogView,
	ControlPlaneSnapshot,
} from "../control-plane/snapshot.js";
import type { ProviderLiveMatrixEntry } from "../llm/types.js";

const DASHBOARD_TITLE = "Quilin Agent — Control Plane";

function htmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function badgeClass(status: string): string {
	switch (status) {
		case "ready":
		case "active":
		case "connected":
			return "badge-ok";
		case "degraded":
		case "pending_repl_apply":
			return "badge-warn";
		case "booting":
		case "configured":
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

function renderAgentSection(agent: ControlPlaneAgentView): string {
	const cap = agent.capabilities;
	const rt = agent.runtime;

	return `
	<section class="card">
		<h2>Agent Status</h2>
		<div class="kv-grid">
			<div class="kv-label">Status</div>
			<div><span class="badge ${badgeClass(agent.status)}">${htmlEscape(agent.status)}</span></div>
			<div class="kv-label">Generation</div>
			<div>${cap?.generation ?? rt.generation}</div>
			<div class="kv-label">Booted</div>
			<div>${rt.booted ? "yes" : "no"}</div>
			<div class="kv-label">Watching</div>
			<div>${cap?.watching ?? false ? "on" : "off"}</div>
			<div class="kv-label">In Flight</div>
			<div>${rt.inFlight || (cap?.inFlight === true) ? "yes" : "no"}</div>
			<div class="kv-label">Last Reload</div>
			<div>${cap?.lastSuccess == null ? "none" : htmlEscape(`${cap.lastSuccess.operation}/${cap.lastSuccess.trigger}`)}</div>
			<div class="kv-label">Last Failure</div>
			<div>${cap?.lastFailure == null ? "none" : htmlEscape(`${cap.lastFailure.errorName}: ${cap.lastFailure.errorMessage}`)}</div>
		</div>
	</section>`;
}

function renderSessionsTable(
	sessions: readonly ControlPlaneSessionSummary[],
): string {
	if (sessions.length === 0) {
		return `
	<section class="card">
		<h2>Recent Sessions</h2>
		<p class="muted">No sessions recorded yet.</p>
	</section>`;
	}

	const rows = sessions
		.map(
			(session) => `
		<tr>
			<td><code>${htmlEscape(session.sessionId)}</code></td>
			<td><span class="badge ${badgeClass(session.status)}">${htmlEscape(session.status)}</span></td>
			<td>${htmlEscape(session.source)}</td>
			<td>${session.turnCount ?? "-"}</td>
			<td>${session.messageCount ?? "-"}</td>
			<td>${session.lastActiveAt ?? session.createdAt ?? "-"}</td>
		</tr>`,
		)
		.join("");

	return `
	<section class="card">
		<h2>Recent Sessions (${sessions.length})</h2>
		<div class="table-wrap">
		<table>
			<thead><tr>
				<th>Session ID</th>
				<th>Status</th>
				<th>Source</th>
				<th>Turns</th>
				<th>Messages</th>
				<th>Last Active</th>
			</tr></thead>
			<tbody>${rows}</tbody>
		</table>
		</div>
	</section>`;
}

function renderSkillsSection(skills: ControlPlaneSkillsCatalogView): string {
	if (skills.total === 0) {
		return `
	<section class="card">
		<h2>Skills Catalog</h2>
		<p class="muted">No skills discovered.</p>
	</section>`;
	}

	const sourceCounts = Object.entries(skills.countsBySource)
		.map(
			([source, count]) =>
				`<span class="badge badge-info">${htmlEscape(source)}: ${count}</span>`,
		)
		.join(" ");

	const trustCounts = Object.entries(skills.countsByTrust)
		.map(
			([trust, count]) =>
				`<span class="badge badge-info">${htmlEscape(trust)}: ${count}</span>`,
		)
		.join(" ");

	const recentSkills =
		skills.recentSkillNames.length > 0
			? skills.recentSkillNames.map((name) => `<code>${htmlEscape(name)}</code>`).join(", ")
			: "none";

	const topRows = skills.catalog
		.slice(0, 20)
		.map(
			(skill: ControlPlaneSkillSummary) => `
		<tr>
			<td><code>${htmlEscape(skill.name)}</code></td>
			<td>${htmlEscape(skill.source)}</td>
			<td>${skill.trust ?? "-"}</td>
			<td>${skill.userInvocable ? "yes" : "no"}</td>
			<td>${skill.modelInvocable ? "yes" : "no"}</td>
			<td>${skill.mandatory ? "yes" : "no"}</td>
		</tr>`,
		)
		.join("");

	return `
	<section class="card">
		<h2>Skills Catalog (${skills.total})</h2>
		<div class="kv-grid">
			<div class="kv-label">By Source</div>
			<div>${sourceCounts || "none"}</div>
			<div class="kv-label">By Trust</div>
			<div>${trustCounts || "none"}</div>
			<div class="kv-label">Recent</div>
			<div>${recentSkills}</div>
		</div>
		${skills.total > 0 ? `
		<h3>Top 20 Skills</h3>
		<div class="table-wrap">
		<table>
			<thead><tr>
				<th>Name</th>
				<th>Source</th>
				<th>Trust</th>
				<th>User Invocable</th>
				<th>Model Invocable</th>
				<th>Mandatory</th>
			</tr></thead>
			<tbody>${topRows}</tbody>
		</table>
		</div>` : ""}
	</section>`;
}

function renderMcpSection(mcp: ControlPlaneMcpStatusView): string {
	if (mcp.configuredServers.length === 0) {
		return `
	<section class="card">
		<h2>MCP Servers</h2>
		<p class="muted">No MCP servers configured.</p>
	</section>`;
	}

	const serverRows = mcp.configuredServers
		.map(
			(server: ControlPlaneMcpServerView) => `
		<tr>
			<td><code>${htmlEscape(server.id)}</code></td>
			<td><span class="badge ${badgeClass(server.status)}">${htmlEscape(server.status)}</span></td>
			<td><code>${htmlEscape(server.command)}</code></td>
			<td>${server.args.map(htmlEscape).join(" ")}</td>
			<td>${server.defaultRiskLevel ?? "-"}</td>
		</tr>`,
		)
		.join("");

	const toolRows = mcp.tools
		.slice(0, 50)
		.map(
			(tool) => `
		<tr>
			<td><code>${htmlEscape(tool.name)}</code></td>
			<td>${htmlEscape(tool.namespace ?? "-")}</td>
			<td>${htmlEscape(tool.category)}</td>
			<td>${htmlEscape(tool.riskLevel)}</td>
		</tr>`,
		)
		.join("");

	return `
	<section class="card">
		<h2>MCP Servers (${mcp.configuredServers.length})</h2>
		<div class="kv-grid">
			<div class="kv-label">Overall Status</div>
			<div><span class="badge ${badgeClass(mcp.status)}">${htmlEscape(mcp.status)}</span></div>
			<div class="kv-label">Total Tools</div>
			<div>${mcp.toolCount}</div>
		</div>
		<div class="table-wrap">
		<table>
			<thead><tr>
				<th>Server ID</th>
				<th>Status</th>
				<th>Command</th>
				<th>Args</th>
				<th>Risk Level</th>
			</tr></thead>
			<tbody>${serverRows}</tbody>
		</table>
		</div>
		${mcp.tools.length > 0 ? `
		<h3>Tools (showing ${Math.min(mcp.tools.length, 50)}/${mcp.tools.length})</h3>
		<div class="table-wrap">
		<table>
			<thead><tr>
				<th>Tool Name</th>
				<th>Namespace</th>
				<th>Category</th>
				<th>Risk Level</th>
			</tr></thead>
			<tbody>${toolRows}</tbody>
		</table>
		</div>` : ""}
	</section>`;
}

function renderProvidersSection(
	providers: readonly ProviderLiveMatrixEntry[],
): string {
	if (providers.length === 0) {
		return `
	<section class="card">
		<h2>Provider Matrix</h2>
		<p class="muted">No providers available.</p>
	</section>`;
	}

	const rows = providers
		.map(
			(entry) => `
		<tr>
			<td><code>${htmlEscape(entry.provider)}</code></td>
			<td><span class="badge ${entry.status === "available" ? "badge-ok" : "badge-err"}">${htmlEscape(entry.status)}</span></td>
			<td>${entry.models.map((m) => htmlEscape(m)).join(", ")}</td>
			<td>${entry.credentialSource ?? "-"}</td>
		</tr>`,
		)
		.join("");

	return `
	<section class="card">
		<h2>Provider Matrix</h2>
		<div class="table-wrap">
		<table>
			<thead><tr>
				<th>Provider</th>
				<th>Status</th>
				<th>Models</th>
				<th>Credential Source</th>
			</tr></thead>
			<tbody>${rows}</tbody>
		</table>
		</div>
	</section>`;
}

export function renderControlPlaneDashboardHtml(
	snapshot: ControlPlaneSnapshot,
): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(DASHBOARD_TITLE)}</title>
<style>
:root {
	--bg: #0d1117;
	--bg-card: #161b22;
	--border: #30363d;
	--text: #c9d1d9;
	--text-muted: #8b949e;
	--accent: #58a6ff;
	--ok: #3fb950;
	--warn: #d29922;
	--err: #f85149;
	--info: #58a6ff;
	--code-bg: #1c2128;
}
*,*::before,*::after{box-sizing:border-box}
body{
	margin:0;
	font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
	background:var(--bg);
	color:var(--text);
	line-height:1.5;
}
header{
	background:var(--bg-card);
	border-bottom:1px solid var(--border);
	padding:1rem 2rem;
	display:flex;
	align-items:center;
	justify-content:space-between;
}
header h1{
	margin:0;
	font-size:1.25rem;
	color:var(--accent);
}
header .generated{
	font-size:0.75rem;
	color:var(--text-muted);
}
main{
	max-width:72rem;
	margin:0 auto;
	padding:1.5rem 2rem;
	display:flex;
	flex-direction:column;
	gap:1.5rem;
}
.card{
	background:var(--bg-card);
	border:1px solid var(--border);
	border-radius:6px;
	padding:1.25rem 1.5rem;
}
.card h2{
	margin:0 0 1rem;
	font-size:1rem;
	color:var(--accent);
	border-bottom:1px solid var(--border);
	padding-bottom:0.5rem;
}
.card h3{
	margin:1.25rem 0 0.75rem;
	font-size:0.875rem;
	color:var(--text);
}
.kv-grid{
	display:grid;
	grid-template-columns:max-content 1fr;
	gap:0.5rem 1.5rem;
}
.kv-label{
	color:var(--text-muted);
}
.badge{
	display:inline-block;
	padding:0.125rem 0.5rem;
	border-radius:10px;
	font-size:0.75rem;
	font-weight:600;
	text-transform:uppercase;
}
.badge-ok{background:color-mix(in srgb,var(--ok) 20%,transparent);color:var(--ok)}
.badge-warn{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn)}
.badge-err{background:color-mix(in srgb,var(--err) 20%,transparent);color:var(--err)}
.badge-info{background:color-mix(in srgb,var(--info) 20%,transparent);color:var(--info)}
.table-wrap{overflow-x:auto}
table{
	width:100%;
	border-collapse:collapse;
	font-size:0.8125rem;
}
th,td{
	padding:0.5rem 0.75rem;
	text-align:left;
	border-bottom:1px solid var(--border);
	white-space:nowrap;
}
th{
	color:var(--text-muted);
	font-weight:600;
	text-transform:uppercase;
	font-size:0.6875rem;
	letter-spacing:0.05em;
}
tbody tr:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
code{
	background:var(--code-bg);
	padding:0.125rem 0.375rem;
	border-radius:4px;
	font-size:0.8125rem;
}
.muted{color:var(--text-muted)}
footer{
	text-align:center;
	padding:1.5rem;
	color:var(--text-muted);
	font-size:0.75rem;
	border-top:1px solid var(--border);
	margin-top:1.5rem;
}
@media(max-width:640px){
	header,main{padding:1rem}
	.kv-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>
<header>
	<h1>${htmlEscape(DASHBOARD_TITLE)}</h1>
	<span class="generated">Snapshot: ${htmlEscape(snapshot.generatedAt)}</span>
</header>
<main>
	${renderAgentSection(snapshot.agent)}
	${renderSessionsTable(snapshot.sessions)}
	${renderSkillsSection(snapshot.skills)}
	${renderMcpSection(snapshot.mcp)}
	${renderProvidersSection(snapshot.providers)}
</main>
<footer>Quilin Agent &middot; Control Plane &middot; v0.0.3</footer>
</body>
</html>
`;
}
