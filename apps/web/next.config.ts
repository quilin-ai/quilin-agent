import type { NextConfig } from "next";

const config: NextConfig = {
	reactStrictMode: true,
	poweredByHeader: false,
	experimental: {
		typedRoutes: true,
	},
	// Quilin Agent uses a localhost-only control plane (per docs/08-observability/web-ui-rebuild-plan §4).
	// Proxy /api/v2/* through the apps/web Node runtime route handler so the browser
	// never talks to the agent-core process directly (CORS + auth shaped at one chokepoint).
};

export default config;
