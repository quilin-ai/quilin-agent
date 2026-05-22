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

	// When `QUILIN_STABLE_BUILD=1`, redirect the build artifact to
	// `.next-stable-3008/` so the stable 3008 backend (started via
	// `pnpm start:stable-3008`) doesn't fight over `.next/` with a
	// concurrent `pnpm dev`. Without this, `pnpm build` clobbers the
	// dev server's `.next/` cache and every dev route 500s.
	...(process.env.QUILIN_STABLE_BUILD === "1" ? { distDir: ".next-stable-3008" } : {}),
	// Allow Next webpack to resolve agent-core source .js suffix imports
	// to the corresponding .ts files. agent-core src uses ESM convention
	// `import "./foo.js"` referring to compiled output, but when Next
	// pulls .ts source directly across the pnpm workspace, webpack needs
	// this alias to find .ts when .js doesn't exist.
	webpack(config) {
		config.resolve = config.resolve || {};
		config.resolve.extensionAlias = {
			...(config.resolve.extensionAlias || {}),
			".js": [".ts", ".tsx", ".js"],
		};
		return config;
	},
};

export default config;
