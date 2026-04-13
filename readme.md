# Quilin Agent — 拼布麒麟

> **Quilin** = Quilt（拼布/缝合）+ Qilin（麒麟，中华神话最早的缝合神兽）
>
> 融合全球最强 Agent 开源项目精华的自进化 Agent 框架

**愿景**：  
我们不再手动追逐某个框架。我们要打造一个**永远站在 SOTA 最前沿的动态 Agent 框架**：实时监控 Agent 生态 10 大工程领域的 Top 10 最强开源项目，一旦上游有更新，就自动拉取 → Claude Code 智能分析 diff → 自动生成融合 patch → 缝合进我们的核心代码 → 发布新版本。

最终产物是一个**活的、持续进化的"终极 Agent 操作系统"**（Quilin Agent），每一层都吸收了全生态最强思想，组合方式永远跟随最新 Agent Engineering 最佳实践。

## 10 大工程领域（每层 Top 10 最强开源项目）

1. **LLM 接入** — 单一模型封装、ThinkingMode、InferenceConfig
2. **上下文工程** — 系统提示组装、上下文生命周期、token 预算
3. **记忆工程** — 4 层分级存储、向量+KG 检索、自动反思
4. **规划工程** — 意图识别、任务分解、推理策略切换
5. **工具工程** — 4 类混合动作空间、MCP 客户端、浏览器
6. **多 Agent 工程** — 编排模式、SubAgent、A2A 协议
7. **安全护栏** — 4 层验证、权限分级、Hooks
8. **可观测性** — OTel 追踪、指标、结构化日志
9. **部署运行时** — Docker 沙箱、CLI、配置管理
10. **自进化** — 轨迹分析、scaffold 自修改、技能自创

## 项目目录结构

```
quilin-agent/
├── upstreams/                  # ~100 个 submodule（实时同步）
│   ├── memory-mem0/
│   ├── memory-hindsight/
│   ├── ... (全部 ~100 个)
├── quilin/                     # 核心代码（所有缝合结果）
│   ├── core/                   # Harness 主循环 (E-T-C-S-L-V)
│   ├── layers/                 # 每层 provider 适配器
│   ├── plugins/                # 可插拔 Top10 实现
│   └── config.yaml             # 一键切换 SOTA 组合
├── docs/
│   ├── architecture/           # 架构总览 + 融合索引
│   ├── engineering/            # 10 大工程领域详细规格
│   └── research/               # 6 模型设计参考
├── scripts/
│   ├── sync-upstreams.py       # 每 5 分钟监控 + 自动 pull
│   ├── merge-with-claude.sh    # 调用 Claude Code 智能缝合
│   ├── release.sh              # 自动 commit / tag / push
│   └── init-all-submodules.sh  # 首次初始化脚本
├── .gitmodules
├── Dockerfile                  # 一键部署整个框架
└── README.md
```

## 快速启动

```bash
# 初始化 submodule
bash scripts/init-all-submodules.sh
git submodule update --init --recursive

# 运行核心 harness
python -m quilin.core.Harness

# 同步上游（单次检查）
python scripts/sync-upstreams.py

# 同步上游（daemon 模式，每 5 分钟）
python scripts/sync-upstreams.py --daemon

# Docker 部署
docker build -t quilin-agent .
docker run -d -e ANTHROPIC_API_KEY=your_key quilin-agent
```

## 工作流程

1. `sync-upstreams.py` 检测到任意 upstream 有新 commit → pull 最新代码
2. `merge-with-claude.sh` 触发 → 把变更 diff + 当前 quilin 代码一起发给 Claude Code
3. Claude 生成融合 patch（例如"把 Hindsight 新 Reflect 机制无缝接入 Tier-2 记忆层"）
4. 自动 apply → 测试通过 → `release.sh` 打 tag 发布新版本

## 核心设计哲学

- **中央编排**：永远以 **LangGraph** 作为状态图核心
- **分层记忆**：短时（in-prompt）→ 中时（Hindsight Reflect）→ 长时（OmniMem + KG）→ 超长时（gbrain）
- **插件化**：每层 Top 10 都实现统一的 Provider 接口，支持一键切换或投票融合
- **协议标准**：全部使用 **MCP**（统一工具/感知协议）
- **持续进化**：框架本身也是一个可监控层，自动缝合最新 Agent Engineering 最佳实践

## 为什么叫 Quilin？

**麒麟**是中华神话中最早的「缝合神兽」—— 鹿角、牛尾、龙鳞、马蹄，融合多种生物的精华于一身，却和谐统一、自成一体。

我们的 Agent 框架也是如此：融合 90+ 顶级开源项目的精华，通过智能缝合形成一个有机的整体。名字本身就是在「缝合」—— **Quilt**（拼布）+ **Qilin**（麒麟）= **Quilin**。

---

MIT License
