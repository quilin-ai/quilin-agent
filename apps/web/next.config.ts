import type { NextConfig } from "next";

const config: NextConfig = {
	reactStrictMode: true,
	poweredByHeader: false,
	experimental: {
		typedRoutes: true,
	},
	// `@quilin/agent-core` is a Node-only workspace package that bundles
	// native deps (better-sqlite3, fsevents transitively) and uses
	// `import.meta.url` with on-disk assets (observability dashboard UI).
	// Mark it external so Next.js / Turbopack don't try to re-bundle it
	// for the route handler — it's loaded via plain Node `require`/`import`
	// at runtime from `apps/web/node_modules/@quilin/agent-core/dist/`.
	serverExternalPackages: ["@quilin/agent-core"],
	// Quilin Agent uses a localhost-only control plane (per docs/08-observability/web-ui-rebuild-plan §4).
	// Proxy /api/v2/* through the apps/web Node runtime route handler so the browser
	// never talks to the agent-core process directly (CORS + auth shaped at one chokepoint).
};

export default config;
