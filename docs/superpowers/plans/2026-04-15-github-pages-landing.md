# Quilin Agent — GitHub Pages Landing Page 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-page Landing Page for quilin-agent with an Eastern aesthetic (terminal × lacquer × manuscript), deployed via GitHub Pages.

**Architecture:** Pure static HTML + CSS + JS in `site/` directory. No build tools, no frameworks. GitHub Actions official Pages workflow for deployment.

**Tech Stack:** HTML5, CSS3 (custom properties, grid, animations), vanilla JS (IntersectionObserver, CSS class toggling)

**Spec:** [2026-04-15-github-pages-landing-design.md](../specs/2026-04-15-github-pages-landing-design.md)

---

## File Structure

```
site/
├── index.html      # Full page structure (Nav, Hero, Proof Strip, Features, Architecture, Benchmark Targets, Footer)
├── style.css       # All styles: CSS custom properties, layout, animations, responsive
└── main.js         # Scroll-triggered animations (IntersectionObserver) + ASCII shimmer effect

.github/workflows/
└── pages.yml       # GitHub Actions Pages deployment workflow
```

---

### Task 1: GitHub Actions Pages Workflow

**Files:**
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: Create the Pages deployment workflow**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [master]
    paths: ['site/**']

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Verify YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pages.yml'))"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: add GitHub Pages deployment workflow"
```

---

### Task 2: CSS Foundation — Custom Properties + Base Styles

**Files:**
- Create: `site/style.css`

- [ ] **Step 1: Create style.css with custom properties and resets**

```css
/* ============================================================
   Quilin Agent — Landing Page Styles
   Aesthetic: terminal × lacquer × manuscript
   ============================================================ */

:root {
  /* — Palette — */
  --bg-primary: #0a0a0a;
  --bg-card: #1a1a2e;
  --bg-nav: rgba(10, 10, 10, 0.85);
  --gold: #c9a84c;
  --gold-bright: #f0d68a;
  --gold-dim: rgba(201, 168, 76, 0.15);
  --gold-border: rgba(201, 168, 76, 0.3);
  --text-primary: #e8e6e3;
  --text-secondary: #999;
  --gray-muted: #666;

  /* — Typography — */
  --font-body: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;

  /* — Spacing — */
  --section-padding: 6rem 2rem;
  --content-max-width: 1100px;
}

/* — Reset — */
*, *::before, *::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
  font-size: 16px;
}

body {
  font-family: var(--font-body);
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.7;
  overflow-x: hidden;
}

/* — Subtle background warmth — */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background: radial-gradient(
    ellipse 60% 50% at 50% 30%,
    rgba(201, 168, 76, 0.03) 0%,
    transparent 70%
  );
  pointer-events: none;
  z-index: 0;
}

/* — Selection — */
::selection {
  background: var(--gold-dim);
  color: var(--gold-bright);
}

a {
  color: var(--gold);
  text-decoration: none;
  transition: color 0.2s;
}

a:hover {
  color: var(--gold-bright);
}

/* — Section reveal animation — */
.reveal {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity 0.6s ease, transform 0.6s ease;
}

.reveal.visible {
  opacity: 1;
  transform: translateY(0);
}
```

- [ ] **Step 2: Commit**

```bash
git add site/style.css
git commit -m "feat(site): add CSS foundation with custom properties and base styles"
```

---

### Task 3: HTML Structure — Full Page Skeleton

**Files:**
- Create: `site/index.html`

- [ ] **Step 1: Create index.html with all 7 sections**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quilin Agent — 麒麟</title>
  <meta name="description" content="A self-evolving Agent framework that fuses the best of 100+ open-source projects. TS + Python + Rust.">
  <link rel="stylesheet" href="style.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
</head>
<body>

  <!-- ==================== Nav ==================== -->
  <nav class="nav" id="nav">
    <div class="nav-inner">
      <div class="nav-brand">
        <span class="nav-logo">麒麟</span>
        <span class="nav-name">Quilin Agent</span>
      </div>
      <a href="https://github.com/user/quilin-agent" class="nav-github" aria-label="GitHub">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
        </svg>
      </a>
    </div>
  </nav>

  <!-- ==================== Hero ==================== -->
  <section class="hero" id="hero">
    <div class="hero-inner">
      <pre class="hero-ascii" aria-hidden="true">
                  ___
                /   \        ╭──────────────────╮
               / ___ \       │                  │
              / /   \ \      │   ██   ██  ██    │
             / /     \_\     │  ██   ██  ██     │
            / /    ___       │  ████████████    │
           / /    /  /       │  ██   ██  ██     │
          / /    /  /        │  ██   ██  ██     │
         / /    /  /___      │                  │
        / /    /      /      ╰──────────────────╯
       / /    /  /\  \
      / /    /  /  \  \         Q U I L I N
     / /    /  /    \  \
    /_/    /__/      \__\       麒    麟
      </pre>
      <div class="hero-content">
        <h1 class="hero-title">
          <span class="hero-title-cn">麒麟</span>
          Quilin Agent
        </h1>
        <p class="hero-subtitle">
          A self-evolving Agent framework that fuses the best of
          <strong>100+ open-source projects</strong> into one living system.
        </p>
        <div class="hero-cta">
          <a href="https://github.com/user/quilin-agent" class="btn btn-primary">View on GitHub</a>
          <a href="#features" class="btn btn-secondary">Learn More</a>
        </div>
      </div>
    </div>
  </section>

  <!-- ==================== Proof Strip ==================== -->
  <section class="proof-strip">
    <div class="proof-inner">
      <div class="proof-item">
        <span class="proof-number">12</span>
        <span class="proof-label">capability domains</span>
      </div>
      <div class="proof-divider">·</div>
      <div class="proof-item">
        <span class="proof-number">~100</span>
        <span class="proof-label">upstream projects</span>
      </div>
      <div class="proof-divider">·</div>
      <div class="proof-item">
        <span class="proof-number">3</span>
        <span class="proof-label">languages: TS + Python + Rust</span>
      </div>
    </div>
  </section>

  <!-- ==================== Features ==================== -->
  <section class="features reveal" id="features">
    <div class="section-inner">
      <h2 class="section-title">Core Capabilities</h2>
      <div class="features-grid">

        <div class="feature-card">
          <div class="feature-icon">⟳</div>
          <h3>Self-Evolving Engine</h3>
          <p>Monitors 12 domains × Top 10 upstream projects. Auto-syncs changes, AI-analyzes diffs, generates fusion patches.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon">◆</div>
          <h3>4-Tier Memory</h3>
          <p>OmniMem working / episodic / semantic / skill with vector + knowledge graph retrieval and auto-reflection.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon">⧉</div>
          <h3>Three-Language Architecture</h3>
          <p>TypeScript core + Python ML providers + Rust infrastructure. Each language where it excels.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon">⬡</div>
          <h3>Agent Mesh</h3>
          <p>Built-in decentralized Agent communication network. Auto-joins mesh at startup via SDK adapter.</p>
        </div>

      </div>
    </div>
  </section>

  <!-- ==================== Architecture ==================== -->
  <section class="architecture reveal" id="architecture">
    <div class="section-inner">
      <h2 class="section-title">Architecture</h2>
      <div class="arch-grid">

        <div class="arch-column">
          <div class="arch-header">TypeScript Core</div>
          <ul class="arch-list">
            <li>Agent Loop</li>
            <li>LLM + Context</li>
            <li>Tools + Router</li>
            <li>Planning</li>
          </ul>
        </div>

        <div class="arch-connector">
          <span class="arch-protocol">MCP stdio</span>
        </div>

        <div class="arch-column">
          <div class="arch-header">Python Providers</div>
          <ul class="arch-list">
            <li>OmniMem MCP</li>
            <li>ML Services</li>
            <li>Vector Store</li>
            <li>KG Engine</li>
          </ul>
        </div>

        <div class="arch-connector">
          <span class="arch-protocol">gRPC</span>
        </div>

        <div class="arch-column">
          <div class="arch-header">Rust Mesh</div>
          <ul class="arch-list">
            <li>Agent Mesh SDK</li>
            <li>WASM Sandbox</li>
            <li>Networking</li>
            <li>Crypto</li>
          </ul>
        </div>

      </div>
    </div>
  </section>

  <!-- ==================== Benchmark Targets ==================== -->
  <section class="benchmarks reveal" id="benchmarks">
    <div class="section-inner">
      <h2 class="section-title">Benchmark Targets</h2>
      <p class="section-desc">Competing on every public leaderboard — honest progress, no premature claims.</p>
      <div class="benchmark-timeline">

        <div class="benchmark-phase">
          <div class="phase-marker phase-active">Phase 0</div>
          <div class="phase-items">
            <span class="benchmark-tag">SWE-bench Verified</span>
            <span class="benchmark-tag">SWE-bench Pro</span>
          </div>
        </div>

        <div class="benchmark-phase">
          <div class="phase-marker">Phase 1</div>
          <div class="phase-items">
            <span class="benchmark-tag">GAIA</span>
            <span class="benchmark-tag">BFCL v4</span>
            <span class="benchmark-tag">τ-bench</span>
          </div>
        </div>

        <div class="benchmark-phase">
          <div class="phase-marker">Phase 2+</div>
          <div class="phase-items">
            <span class="benchmark-tag">WebArena</span>
            <span class="benchmark-tag">OSWorld</span>
            <span class="benchmark-tag">ARC-AGI</span>
            <span class="benchmark-tag">AgentHarm</span>
          </div>
        </div>

      </div>
    </div>
  </section>

  <!-- ==================== Footer ==================== -->
  <footer class="footer">
    <div class="footer-inner">
      <span>MIT License</span>
      <span class="footer-divider">·</span>
      <a href="https://github.com/user/quilin-agent">GitHub</a>
      <span class="footer-divider">·</span>
      <span>Made with 🐉 by Quilin Team</span>
    </div>
  </footer>

  <script src="main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Open in browser and verify structure renders**

Run: `open site/index.html` (macOS) or view in browser
Expected: All 7 sections visible with basic unstyled content

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add HTML structure with all 7 sections"
```

---

### Task 4: CSS — Nav + Hero + Proof Strip

**Files:**
- Modify: `site/style.css`

- [ ] **Step 1: Add Nav styles**

Append to `site/style.css`:

```css
/* ============================================================
   Nav
   ============================================================ */

.nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--bg-nav);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--gold-border);
  transition: background 0.3s;
}

.nav-inner {
  max-width: var(--content-max-width);
  margin: 0 auto;
  padding: 0.75rem 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.nav-brand {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.nav-logo {
  font-size: 1.5rem;
  font-weight: 700;
  background: linear-gradient(135deg, var(--gold), var(--gold-bright));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.nav-name {
  font-family: var(--font-mono);
  font-size: 0.9rem;
  color: var(--text-secondary);
  letter-spacing: 0.05em;
}

.nav-github {
  color: var(--text-secondary);
  transition: color 0.2s;
}

.nav-github:hover {
  color: var(--gold);
}
```

- [ ] **Step 2: Add Hero styles**

Append to `site/style.css`:

```css
/* ============================================================
   Hero
   ============================================================ */

.hero {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6rem 2rem 4rem;
  position: relative;
  z-index: 1;
}

.hero-inner {
  max-width: var(--content-max-width);
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4rem;
  align-items: center;
}

.hero-ascii {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  line-height: 1.3;
  color: var(--gold);
  white-space: pre;
  opacity: 0;
  animation: ascii-fade-in 1.5s ease forwards 0.3s;
  user-select: none;
}

@keyframes ascii-fade-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Shimmer effect */
.hero-ascii::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(240, 214, 138, 0.08) 50%,
    transparent 100%
  );
  animation: shimmer 4s ease-in-out infinite;
  pointer-events: none;
}

@keyframes shimmer {
  0%, 100% { transform: translateX(-100%); }
  50% { transform: translateX(100%); }
}

.hero-content {
  animation: hero-content-in 1s ease forwards 0.5s;
  opacity: 0;
}

@keyframes hero-content-in {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}

.hero-title {
  font-size: 3rem;
  font-weight: 700;
  line-height: 1.2;
  margin-bottom: 1rem;
}

.hero-title-cn {
  display: block;
  font-size: 4rem;
  background: linear-gradient(135deg, var(--gold), var(--gold-bright));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 0.25rem;
}

.hero-subtitle {
  font-size: 1.2rem;
  color: var(--text-secondary);
  max-width: 480px;
  margin-bottom: 2rem;
  line-height: 1.8;
}

.hero-subtitle strong {
  color: var(--gold-bright);
  font-weight: 600;
}

.hero-cta {
  display: flex;
  gap: 1rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  padding: 0.75rem 1.75rem;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 0.9rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  transition: all 0.2s;
}

.btn-primary {
  background: linear-gradient(135deg, var(--gold), var(--gold-bright));
  color: var(--bg-primary);
}

.btn-primary:hover {
  color: var(--bg-primary);
  box-shadow: 0 0 20px var(--gold-dim);
  transform: translateY(-1px);
}

.btn-secondary {
  border: 1px solid var(--gold-border);
  color: var(--gold);
}

.btn-secondary:hover {
  border-color: var(--gold);
  background: var(--gold-dim);
}
```

- [ ] **Step 3: Add Proof Strip styles**

Append to `site/style.css`:

```css
/* ============================================================
   Proof Strip
   ============================================================ */

.proof-strip {
  border-top: 1px solid var(--gold-border);
  border-bottom: 1px solid var(--gold-border);
  padding: 2rem;
  position: relative;
  z-index: 1;
}

.proof-inner {
  max-width: var(--content-max-width);
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2rem;
  flex-wrap: wrap;
}

.proof-item {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.proof-number {
  font-family: var(--font-mono);
  font-size: 1.5rem;
  font-weight: 700;
  background: linear-gradient(135deg, var(--gold), var(--gold-bright));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.proof-label {
  font-size: 0.9rem;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

.proof-divider {
  color: var(--gold-border);
  font-size: 1.5rem;
}
```

- [ ] **Step 4: Verify in browser**

Run: Open `site/index.html` in browser
Expected: Nav with gold gradient logo, full-screen Hero with ASCII art and CTA buttons, Proof Strip with 3 data points

- [ ] **Step 5: Commit**

```bash
git add site/style.css
git commit -m "feat(site): style Nav, Hero, and Proof Strip sections"
```

---

### Task 5: CSS — Features + Architecture + Benchmark Targets + Footer

**Files:**
- Modify: `site/style.css`

- [ ] **Step 1: Add Features styles**

Append to `site/style.css`:

```css
/* ============================================================
   Sections — shared
   ============================================================ */

.section-inner {
  max-width: var(--content-max-width);
  margin: 0 auto;
  padding: var(--section-padding);
}

.section-title {
  font-size: 2rem;
  font-weight: 600;
  margin-bottom: 1rem;
  background: linear-gradient(135deg, var(--gold), var(--gold-bright));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  display: inline-block;
}

.section-desc {
  color: var(--text-secondary);
  margin-bottom: 3rem;
  max-width: 600px;
}

/* ============================================================
   Features
   ============================================================ */

.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1.5rem;
}

.feature-card {
  padding: 2rem;
  border: 1px solid var(--gold-border);
  border-radius: 8px;
  background: var(--bg-card);
  transition: border-color 0.3s, box-shadow 0.3s;
}

.feature-card:hover {
  border-color: var(--gold);
  box-shadow: 0 0 24px var(--gold-dim);
}

.feature-icon {
  font-size: 1.5rem;
  color: var(--gold);
  margin-bottom: 1rem;
}

.feature-card h3 {
  font-size: 1.1rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: var(--text-primary);
}

.feature-card p {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.7;
}
```

- [ ] **Step 2: Add Architecture styles**

Append to `site/style.css`:

```css
/* ============================================================
   Architecture
   ============================================================ */

.arch-grid {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 0;
  flex-wrap: wrap;
}

.arch-column {
  flex: 1;
  min-width: 200px;
  max-width: 280px;
  padding: 2rem;
  border: 1px solid var(--gold-border);
  border-radius: 8px;
  background: var(--bg-card);
}

.arch-header {
  font-family: var(--font-mono);
  font-size: 1rem;
  font-weight: 600;
  color: var(--gold);
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--gold-border);
}

.arch-list {
  list-style: none;
}

.arch-list li {
  font-size: 0.9rem;
  color: var(--text-secondary);
  padding: 0.35rem 0;
}

.arch-list li::before {
  content: '›';
  color: var(--gold);
  margin-right: 0.5rem;
}

.arch-connector {
  display: flex;
  align-items: center;
  padding: 0 1rem;
}

.arch-protocol {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--gold);
  background: var(--gold-dim);
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  white-space: nowrap;
}
```

- [ ] **Step 3: Add Benchmark Targets styles**

Append to `site/style.css`:

```css
/* ============================================================
   Benchmark Targets
   ============================================================ */

.benchmark-timeline {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  position: relative;
  padding-left: 2rem;
}

.benchmark-timeline::before {
  content: '';
  position: absolute;
  left: 0.5rem;
  top: 0.5rem;
  bottom: 0.5rem;
  width: 1px;
  background: var(--gold-border);
}

.benchmark-phase {
  display: flex;
  align-items: flex-start;
  gap: 1.5rem;
}

.phase-marker {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-card);
  border: 1px solid var(--gold-border);
  padding: 0.25rem 0.75rem;
  border-radius: 4px;
  white-space: nowrap;
  position: relative;
}

.phase-marker::before {
  content: '';
  position: absolute;
  left: -1.75rem;
  top: 50%;
  transform: translateY(-50%);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gold-border);
  border: 2px solid var(--bg-primary);
}

.phase-active {
  color: var(--gold);
  border-color: var(--gold);
}

.phase-active::before {
  background: var(--gold);
  box-shadow: 0 0 8px var(--gold-dim);
}

.phase-items {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding-top: 0.15rem;
}

.benchmark-tag {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--text-secondary);
  background: var(--bg-card);
  border: 1px solid rgba(201, 168, 76, 0.15);
  padding: 0.25rem 0.75rem;
  border-radius: 4px;
}
```

- [ ] **Step 4: Add Footer styles**

Append to `site/style.css`:

```css
/* ============================================================
   Footer
   ============================================================ */

.footer {
  border-top: 1px solid var(--gold-border);
  padding: 2rem;
  position: relative;
  z-index: 1;
}

.footer-inner {
  max-width: var(--content-max-width);
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
  flex-wrap: wrap;
}

.footer-divider {
  color: var(--gold-border);
}
```

- [ ] **Step 5: Verify full page in browser**

Run: Open `site/index.html` in browser
Expected: Complete styled page — all 7 sections with gold-on-black theme, feature cards with hover glow, architecture columns with connectors, benchmark timeline

- [ ] **Step 6: Commit**

```bash
git add site/style.css
git commit -m "feat(site): style Features, Architecture, Benchmark Targets, and Footer"
```

---

### Task 6: CSS — Responsive Breakpoints

**Files:**
- Modify: `site/style.css`

- [ ] **Step 1: Add responsive styles**

Append to `site/style.css`:

```css
/* ============================================================
   Responsive
   ============================================================ */

@media (max-width: 1024px) {
  .hero-inner {
    grid-template-columns: 1fr;
    text-align: center;
    gap: 2rem;
  }

  .hero-ascii {
    font-size: 0.5rem;
    margin: 0 auto;
  }

  .hero-subtitle {
    margin-left: auto;
    margin-right: auto;
  }

  .hero-cta {
    justify-content: center;
  }

  .arch-grid {
    flex-direction: column;
    align-items: center;
  }

  .arch-connector {
    transform: rotate(90deg);
    padding: 0.5rem 0;
  }
}

@media (max-width: 768px) {
  :root {
    --section-padding: 4rem 1.5rem;
  }

  .hero-title {
    font-size: 2rem;
  }

  .hero-title-cn {
    font-size: 2.5rem;
  }

  .hero-ascii {
    display: none;
  }

  .proof-inner {
    flex-direction: column;
    gap: 1rem;
  }

  .proof-divider {
    display: none;
  }

  .proof-item {
    justify-content: center;
  }

  .features-grid {
    grid-template-columns: 1fr;
  }

  .arch-column {
    max-width: 100%;
    width: 100%;
  }

  .hero-cta {
    flex-direction: column;
    align-items: center;
  }

  .btn {
    width: 100%;
    justify-content: center;
  }
}
```

- [ ] **Step 2: Verify responsive layouts in browser**

Run: Open `site/index.html` and resize browser
Expected: Desktop → tablet → mobile layouts all render correctly. ASCII hidden on mobile, proof strip stacks vertically.

- [ ] **Step 3: Commit**

```bash
git add site/style.css
git commit -m "feat(site): add responsive breakpoints for tablet and mobile"
```

---

### Task 7: JavaScript — Scroll Animations

**Files:**
- Create: `site/main.js`

- [ ] **Step 1: Create main.js with IntersectionObserver and nav scroll effect**

```javascript
/* ============================================================
   Quilin Agent — Landing Page Scripts
   ============================================================ */

(function () {
  'use strict';

  // — Section reveal on scroll —
  const revealElements = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    revealElements.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Fallback: show everything immediately
    revealElements.forEach(function (el) {
      el.classList.add('visible');
    });
  }

  // — Nav background on scroll —
  var nav = document.getElementById('nav');

  if (nav) {
    window.addEventListener(
      'scroll',
      function () {
        if (window.scrollY > 50) {
          nav.classList.add('nav-scrolled');
        } else {
          nav.classList.remove('nav-scrolled');
        }
      },
      { passive: true }
    );
  }
})();
```

- [ ] **Step 2: Add nav-scrolled style to style.css**

Append to `site/style.css` (before the responsive section):

```css
/* — Nav scroll state — */
.nav-scrolled {
  background: rgba(10, 10, 10, 0.95);
}
```

- [ ] **Step 3: Verify in browser**

Run: Open `site/index.html`, scroll down
Expected: Features, Architecture, and Benchmark sections fade in when scrolled into view. Nav darkens on scroll.

- [ ] **Step 4: Commit**

```bash
git add site/main.js site/style.css
git commit -m "feat(site): add scroll animations and nav scroll effect"
```

---

### Task 8: Polish — ASCII Art Refinement + Final Tweaks

**Files:**
- Modify: `site/index.html` — refine ASCII art
- Modify: `site/style.css` — minor polish

- [ ] **Step 1: Refine the ASCII 麒麟 in index.html**

Replace the `<pre class="hero-ascii">` content with a more detailed ASCII art that evokes the mythical qilin — antlers, scales, hooves. The exact art will be crafted during implementation. Keep it under 20 lines tall for layout balance.

- [ ] **Step 2: Add hero-ascii position:relative for shimmer overlay**

In `site/style.css`, update `.hero-ascii`:

```css
.hero-ascii {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  line-height: 1.3;
  color: var(--gold);
  white-space: pre;
  opacity: 0;
  animation: ascii-fade-in 1.5s ease forwards 0.3s;
  user-select: none;
  position: relative;  /* for shimmer overlay */
}
```

- [ ] **Step 3: Full page review in browser**

Run: Open `site/index.html`
Expected: Complete, polished landing page. All sections render, animations work, responsive layout correct.

- [ ] **Step 4: Commit**

```bash
git add site/index.html site/style.css
git commit -m "feat(site): polish ASCII art and final visual tweaks"
```

---

### Task 9: Final Commit — Spec + Plan

**Files:**
- Add: `docs/superpowers/specs/2026-04-15-github-pages-landing-design.md`
- Add: `docs/superpowers/plans/2026-04-15-github-pages-landing.md`

- [ ] **Step 1: Commit spec and plan documents**

```bash
git add docs/superpowers/specs/2026-04-15-github-pages-landing-design.md \
        docs/superpowers/plans/2026-04-15-github-pages-landing.md
git commit -m "docs: add GitHub Pages landing page spec and implementation plan"
```

---

## Summary

| Task | Description | New Files |
|------|-------------|-----------|
| 1 | GitHub Actions Pages workflow | `pages.yml` |
| 2 | CSS foundation + custom properties | `style.css` |
| 3 | HTML structure — all 7 sections | `index.html` |
| 4 | CSS — Nav + Hero + Proof Strip | — |
| 5 | CSS — Features + Arch + Benchmarks + Footer | — |
| 6 | CSS — Responsive breakpoints | — |
| 7 | JS — Scroll animations | `main.js` |
| 8 | Polish — ASCII art + final tweaks | — |
| 9 | Commit spec + plan docs | — |

Total: 4 new files (`pages.yml`, `index.html`, `style.css`, `main.js`) + 2 doc files.
