# Quilin Agent — GitHub Pages Landing Page 设计文档

> **状态**: Approved
> **日期**: 2026-04-15
> **参与方**: Claude Code (设计) + Codex (建议) + 用户 (决策)

---

## 1. 目标

为 quilin-agent 项目创建一个高质量的单页 Landing Page，部署在 GitHub Pages (`<user>.github.io/quilin-agent`)。

- **受众**: 开发者/技术用户 + 投资人/商业受众
- **定位**: 品牌展示 + 技术深度兼顾
- **范围**: V1 极简单页，后续可迭代扩展为文档站

## 2. 技术方案

**纯静态 HTML + CSS + JS，三文件分离。**

```
site/
├── index.html      # 页面结构
├── style.css       # 样式
└── main.js         # 滚动动画 + 轻交互
```

- 零构建依赖，零前端框架
- GitHub Actions 官方 Pages workflow 部署（不用 legacy gh-pages 分支）
- 与现有 CI (`ci.yml`) 完全独立

## 3. 视觉风格

### 3.1 美学方向："terminal × lacquer × manuscript"

克制的东方美学，不堆传统中式素材（云纹、红金宫廷感）。追求"终端中的东方器物"质感。

### 3.2 配色方案

| 用途 | 色值 | 说明 |
|------|------|------|
| 主背景 | `#0a0a0a` | 漆黑底，多层深色 + 极轻暖色径向晕染 + 弱噪点 |
| 金色强调 | `#c9a84c` → `#f0d68a` | 古金到亮金渐变 |
| 正文 | `#e8e6e3` | 暖白 / 骨白 |
| 卡片背景 | `#1a1a2e` | 深蓝黑 |
| 辅助灰 | `#666` | 极少量冷灰点缀 |

### 3.3 字体策略

- **Logo**: 毛笔感字体（仅限 logo，不扩散到全站）
- **正文/标题**: 高可读 sans-serif（如 Inter / system-ui）
- **ASCII art / 数据区**: monospace（如 JetBrains Mono / Fira Code）

### 3.4 边框与装饰

- 1px 半透明暖金 hairline 边框
- 不用厚描边、不用大面积卡片填充
- 不用漂浮粒子、赛博龙纹等花哨特效

### 3.5 动效（仅 3 个）

1. **Hero 入场** — ASCII 麒麟淡入 + 逐行点亮
2. **ASCII 微光** — 金色 shimmer 持续微动
3. **Section reveal** — 滚动时各区块渐入

## 4. 页面分区

### 4.1 Nav（固定顶部）

- 左侧：毛笔字风格「麒麟」+ "Quilin Agent" 文字
- 右侧：GitHub 图标链接
- 半透明黑底，滚动时加深

### 4.2 Hero（全屏）

- 左/中：ASCII 麒麟，用 `<pre aria-hidden="true">` 渲染，金色等宽字体
- 右/下：一句话愿景 + 副标题 + CTA 按钮（"View on GitHub" / "Get Started"）
- ASCII 是视觉装饰，旁边有正常文本承载信息（可访问性）
- JS 只做轻动效（淡入、逐行点亮、shimmer），不负责生成 ASCII

### 4.3 Proof Strip（铭牌条）

Hero 下方，三个高信号数据，克制铭牌风格：

```
12 capability domains  ·  ~100 upstream projects  ·  TS + Python + Rust
```

- 不像 dashboard，像铭牌
- 开发者快速抓到技术规模，投资人快速抓到项目量级

### 4.4 Features（核心亮点）

3-4 张卡片，每张一个核心差异化能力：

1. **自进化引擎** — 监控 12 领域 × Top 10 上游，AI 辅助融合 PR 由人审通过
2. **4 层分级记忆** — OmniMem working/episodic/semantic/skill + 向量 + KG + 自反思
3. **三语言架构** — TS 核心 + Python ML + Rust 基础设施，各取所长
4. **Agent Mesh** — 内置去中心化 Agent 通信网络

卡片样式：暗底 + 1px 暖金 hairline + hover 微发光

### 4.5 Architecture（三列拓扑）

不画传统流程图，用三列法：

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  TypeScript Core │────│ Python Providers │────│    Rust Mesh     │
│  Agent Loop      │     │  OmniMem MCP     │     │  Agent Mesh SDK  │
│  LLM + Context   │     │  ML Services     │     │  WASM Sandbox    │
│  Tools + Router  │     │                  │     │                  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                        │                        │
        └────── MCP stdio ──────┘                        │
                                 └────── gRPC ───────────┘
```

细线 + label 连接，系统拓扑感

### 4.6 Benchmark Targets（目标与计划）

**明确写成目标，不伪装成已有结果。** 项目处于 Phase 0，诚实展示路线。

```
Targeting:
├── Phase 0: SWE-bench Verified / Pro
├── Phase 1: GAIA · BFCL v4 · τ-bench
└── Phase 2+: WebArena · OSWorld · ARC-AGI · AgentHarm
```

用时间线或路线图样式呈现，每个 benchmark 名称可链接到官方页面。

### 4.7 Footer

- MIT License
- GitHub 链接
- "Made with 🐉 by Quilin Team"
- 简洁一行

## 5. 部署方案

### 5.1 GitHub Actions Workflow

新增 `.github/workflows/pages.yml`：

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [master]
    paths: [site/**]

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

### 5.2 前置条件

- Repo Settings → Pages → Source 设为 "GitHub Actions"

## 6. ASCII 麒麟

用 `<pre>` 标签内嵌 ASCII art，金色 monospace 字体渲染。示意（实际会更精细）：

```
            ⠀⠀⠀⠀⠀⠀⣠⣴⣶⣿⣿⣶⣤⡀
         ⠀⠀⠀⠀⣠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄
        ⠀⠀⠀⣴⣿⣿⣿⣿⠿⠛⠉⠉⠛⠿⣿⣿⣿⣦
       ⠀⠀⣾⣿⣿⡿⠋⠁        ⠈⠙⢿⣿⣿⣷
      ⠀⢠⣿⣿⡟⠁     麒麟      ⠈⢻⣿⣿⡄
      ⠀⣿⣿⡟      QUILIN       ⢻⣿⣿
       ⢿⣿⣇                    ⣸⣿⡿
        ⠹⣿⣿⣶⣤⣀⣀⣀⣀⣀⣀⣤⣤⣶⣿⣿⠏
          ⠈⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋
```

实际实现时会创作一个更具东方神兽感的 ASCII 麒麟形象。

## 7. 响应式适配

- **Desktop (>1024px)**: Hero 左右分栏（ASCII 左 + 文案右），Features 横排 3-4 列
- **Tablet (768-1024px)**: Hero 上下布局，Features 2 列
- **Mobile (<768px)**: 全部单列，ASCII 缩小或隐藏，Proof Strip 竖排

## 8. 不做的事情（YAGNI）

- 不加暗色/亮色模式切换（只有深色）
- 不加 i18n（V1 默认英文，README 级别的中文可选）
- 不加博客/文档子页
- 不加分析追踪（GA 等）
- 不加联系表单
- 不用任何 CSS/JS 框架或构建工具
