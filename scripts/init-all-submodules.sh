#!/usr/bin/env bash
# =============================================================================
# Quilin Agent — 全部 90 个 upstream submodule 初始化脚本
# =============================================================================
# 9 大能力层 × Top 10 开源项目 = 90 个 submodule
# 部分项目无公开 GitHub 仓库（闭源/SaaS），已用最佳替代或标注跳过
# =============================================================================

set -euo pipefail

echo "=========================================="
echo " Quilin Agent Submodule Initializer"
echo "=========================================="
echo ""

# 用于统计
ADDED=0
SKIPPED=0

add_submodule() {
    local path="$1"
    local url="$2"
    echo "[ADD] $path <- $url"
    if git submodule add --depth 1 "$url" "$path" 2>/dev/null; then
        ADDED=$((ADDED + 1))
    else
        echo "[WARN] Failed to add $path, skipping..."
        SKIPPED=$((SKIPPED + 1))
    fi
}

skip_submodule() {
    local path="$1"
    local reason="$2"
    echo "[SKIP] $path — $reason"
    SKIPPED=$((SKIPPED + 1))
}

# =============================================================================
# Layer 1: Memory（记忆层）— 10 个
# =============================================================================
echo ""
echo "--- Layer 1: Memory ---"
add_submodule "upstreams/memory-mem0"         "https://github.com/mem0ai/mem0.git"
add_submodule "upstreams/memory-hindsight"    "https://github.com/vectorize-io/hindsight.git"
add_submodule "upstreams/memory-letta"        "https://github.com/letta-ai/letta.git"
add_submodule "upstreams/memory-graphiti"     "https://github.com/getzep/graphiti.git"
add_submodule "upstreams/memory-cognee"       "https://github.com/topoteretes/cognee.git"
add_submodule "upstreams/memory-supermemory"  "https://github.com/supermemoryai/supermemory.git"
add_submodule "upstreams/memory-langmem"      "https://github.com/langchain-ai/langmem.git"
add_submodule "upstreams/memory-gbrain"       "https://github.com/garrytan/gbrain.git"
add_submodule "upstreams/memory-mempalace"    "https://github.com/MemPalace/mempalace.git"
add_submodule "upstreams/memory-agentmemory"  "https://github.com/elizaOS/agentmemory.git"

# =============================================================================
# Layer 2: LLM Brain / Inference — 10 个
# =============================================================================
echo ""
echo "--- Layer 2: LLM Brain / Inference ---"
add_submodule "upstreams/llm-vllm"       "https://github.com/vllm-project/vllm.git"
add_submodule "upstreams/llm-sglang"     "https://github.com/sgl-project/sglang.git"
add_submodule "upstreams/llm-ollama"     "https://github.com/ollama/ollama.git"
add_submodule "upstreams/llm-llamacpp"   "https://github.com/ggml-org/llama.cpp.git"
add_submodule "upstreams/llm-tgi"        "https://github.com/huggingface/text-generation-inference.git"
add_submodule "upstreams/llm-bentoml"    "https://github.com/bentoml/BentoML.git"
add_submodule "upstreams/llm-mlx"        "https://github.com/ml-explore/mlx.git"
add_submodule "upstreams/llm-outlines"   "https://github.com/dottxt-ai/outlines.git"
add_submodule "upstreams/llm-vercel-ai"  "https://github.com/vercel/ai.git"
skip_submodule "upstreams/llm-lmstudio"  "LM Studio 应用闭源，仅有 SDK/CLI 开源"

# =============================================================================
# Layer 3: Perception / Multimodal — 10 个
# =============================================================================
echo ""
echo "--- Layer 3: Perception / Multimodal ---"
add_submodule "upstreams/perception-qwen-vl"      "https://github.com/QwenLM/Qwen2.5-VL.git"
add_submodule "upstreams/perception-glm4v"         "https://github.com/THUDM/GLM-4.git"
add_submodule "upstreams/perception-llama4-scout"  "https://github.com/meta-llama/llama-models.git"
skip_submodule "upstreams/perception-phi4-mm"      "PhiCookBook 10GB 过大，Phi-4 模型可通过 HuggingFace 直接加载"
add_submodule "upstreams/perception-moshi"         "https://github.com/kyutai-labs/moshi.git"
add_submodule "upstreams/perception-llava"         "https://github.com/haotian-liu/LLaVA.git"
add_submodule "upstreams/perception-cogvlm2"       "https://github.com/THUDM/CogVLM2.git"
add_submodule "upstreams/perception-paddleocr"     "https://github.com/PaddlePaddle/PaddleOCR.git"
add_submodule "upstreams/perception-docling"       "https://github.com/docling-project/docling.git"
add_submodule "upstreams/perception-transformers"  "https://github.com/huggingface/transformers.git"

# =============================================================================
# Layer 4: Planning & Reasoning — 10 个
# =============================================================================
echo ""
echo "--- Layer 4: Planning & Reasoning ---"
add_submodule "upstreams/planning-deepseek-r1"     "https://github.com/deepseek-ai/DeepSeek-R1.git"
add_submodule "upstreams/planning-langgraph"        "https://github.com/langchain-ai/langgraph.git"
add_submodule "upstreams/planning-dspy"             "https://github.com/stanfordnlp/dspy.git"
add_submodule "upstreams/planning-qwen3"            "https://github.com/QwenLM/Qwen3.git"
add_submodule "upstreams/planning-react-langchain"  "https://github.com/langchain-ai/langchain.git"
add_submodule "upstreams/planning-tree-of-thought"  "https://github.com/princeton-nlp/tree-of-thought-llm.git"
add_submodule "upstreams/planning-pydantic-ai"      "https://github.com/pydantic/pydantic-ai.git"
add_submodule "upstreams/planning-glm45"            "https://github.com/zai-org/GLM-4.5.git"
add_submodule "upstreams/planning-kimi-k25"         "https://github.com/MoonshotAI/Kimi-K2.5.git"
skip_submodule "upstreams/planning-agent-reasoning" "无对应独立开源项目"

# =============================================================================
# Layer 5: Tools & Action — 10 个
# =============================================================================
echo ""
echo "--- Layer 5: Tools & Action ---"
add_submodule "upstreams/tools-mcp"              "https://github.com/modelcontextprotocol/python-sdk.git"
add_submodule "upstreams/tools-langchain"        "https://github.com/langchain-ai/langchain.git"
add_submodule "upstreams/tools-openai-agents"    "https://github.com/openai/openai-agents-python.git"
add_submodule "upstreams/tools-autogen"          "https://github.com/microsoft/autogen.git"
add_submodule "upstreams/tools-crewai"           "https://github.com/crewAIInc/crewAI-tools.git"
add_submodule "upstreams/tools-haystack"         "https://github.com/deepset-ai/haystack.git"
add_submodule "upstreams/tools-semantic-kernel"  "https://github.com/microsoft/semantic-kernel.git"
add_submodule "upstreams/tools-google-adk"       "https://github.com/google/adk-python.git"
add_submodule "upstreams/tools-apify"            "https://github.com/apify/apify-sdk-python.git"
add_submodule "upstreams/tools-vigil"            "https://github.com/deadbits/vigil-llm.git"

# =============================================================================
# Layer 6: Orchestration — 10 个
# =============================================================================
echo ""
echo "--- Layer 6: Orchestration ---"
add_submodule "upstreams/orch-langgraph"      "https://github.com/langchain-ai/langgraph.git"
add_submodule "upstreams/orch-crewai"         "https://github.com/crewAIInc/crewAI.git"
add_submodule "upstreams/orch-autogen"        "https://github.com/microsoft/autogen.git"
add_submodule "upstreams/orch-dify"           "https://github.com/langgenius/dify.git"
add_submodule "upstreams/orch-openai-agents"  "https://github.com/openai/openai-agents-python.git"
add_submodule "upstreams/orch-llamaindex"     "https://github.com/run-llama/llama_index.git"
add_submodule "upstreams/orch-haystack"       "https://github.com/deepset-ai/haystack.git"
add_submodule "upstreams/orch-mastra"         "https://github.com/mastra-ai/mastra.git"
add_submodule "upstreams/orch-google-adk"     "https://github.com/google/adk-python.git"
add_submodule "upstreams/orch-agno"           "https://github.com/agno-agi/agno.git"

# =============================================================================
# Layer 7: Observability & Feedback — 10 个
# =============================================================================
echo ""
echo "--- Layer 7: Observability & Feedback ---"
add_submodule "upstreams/obs-mlflow"       "https://github.com/mlflow/mlflow.git"
add_submodule "upstreams/obs-langfuse"     "https://github.com/langfuse/langfuse.git"
add_submodule "upstreams/obs-phoenix"      "https://github.com/Arize-ai/phoenix.git"
add_submodule "upstreams/obs-langsmith"    "https://github.com/langchain-ai/langsmith-sdk.git"
add_submodule "upstreams/obs-helicone"     "https://github.com/Helicone/helicone.git"
add_submodule "upstreams/obs-confident-ai" "https://github.com/confident-ai/deepeval.git"
add_submodule "upstreams/obs-braintrust"   "https://github.com/braintrustdata/braintrust-sdk-python.git"
add_submodule "upstreams/obs-galileo"      "https://github.com/rungalileo/galileo-python.git"
add_submodule "upstreams/obs-maxim"        "https://github.com/maximhq/maxim-py.git"
add_submodule "upstreams/obs-deepeval"     "https://github.com/confident-ai/deepeval.git"

# =============================================================================
# Layer 8: Guardrails & Safety — 10 个
# =============================================================================
echo ""
echo "--- Layer 8: Guardrails & Safety ---"
add_submodule "upstreams/guard-guardrails-ai"    "https://github.com/guardrails-ai/guardrails.git"
add_submodule "upstreams/guard-nemo-guardrails"  "https://github.com/NVIDIA-NeMo/Guardrails.git"
add_submodule "upstreams/guard-pydantic-ai"      "https://github.com/pydantic/pydantic-ai.git"
add_submodule "upstreams/guard-vigil"            "https://github.com/deadbits/vigil-llm.git"
skip_submodule "upstreams/guard-stelp"           "无法找到对应开源项目"
add_submodule "upstreams/guard-semantic-kernel"  "https://github.com/microsoft/semantic-kernel.git"
add_submodule "upstreams/guard-langgraph"        "https://github.com/langchain-ai/langgraph.git"
add_submodule "upstreams/guard-openai-agents"    "https://github.com/openai/openai-agents-python.git"
add_submodule "upstreams/guard-backdoor-defense" "https://github.com/lancopku/agent-backdoor-attacks.git"
add_submodule "upstreams/guard-nemo"             "https://github.com/NVIDIA-NeMo/NeMo.git"

# =============================================================================
# Layer 9: Deployment / Runtime — 10 个
# =============================================================================
echo ""
echo "--- Layer 9: Deployment / Runtime ---"
add_submodule "upstreams/deploy-agno"             "https://github.com/agno-agi/agno.git"
add_submodule "upstreams/deploy-dify"             "https://github.com/langgenius/dify.git"
add_submodule "upstreams/deploy-n8n"              "https://github.com/n8n-io/n8n.git"
add_submodule "upstreams/deploy-fastapi-template" "https://github.com/fastapi/full-stack-fastapi-template.git"
add_submodule "upstreams/deploy-langgraph-helm"   "https://github.com/langchain-ai/helm.git"
add_submodule "upstreams/deploy-modal"            "https://github.com/modal-labs/modal-client.git"
add_submodule "upstreams/deploy-flyio-fastapi"    "https://github.com/fly-apps/hello-fastapi.git"
add_submodule "upstreams/deploy-langgraph"        "https://github.com/langchain-ai/langgraph.git"
add_submodule "upstreams/deploy-bentoml"          "https://github.com/bentoml/BentoML.git"
add_submodule "upstreams/deploy-viam"             "https://github.com/viamrobotics/rdk.git"

# =============================================================================
# 汇总
# =============================================================================
echo ""
echo "=========================================="
echo " 初始化完成！"
echo " 成功添加: $ADDED 个 submodule"
echo " 跳过:     $SKIPPED 个（闭源/未找到）"
echo "=========================================="
