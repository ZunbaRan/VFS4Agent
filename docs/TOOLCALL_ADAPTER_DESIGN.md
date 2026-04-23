# vfs4Agent Tool-Call 适配层设计文档

> **目标**：设计一个统一的抽象层，将各 Agent 框架的 tool_call 消息格式统一转换为沙箱执行指令。
> **作者**：调研规划，不负责执行。
> **日期**：2026-04-23

---

## 目录

1. [背景与问题](#1-背景与问题)
2. [各框架 tool_call 格式对比](#2-各框架-tool_call-格式对比)
3. [核心设计：统一适配层](#3-核心设计统一适配层)
4. [接口设计](#4-接口设计)
5. [各框架适配器详细设计](#5-各框架适配器详细设计)
6. [消息流转架构](#6-消息流转架构)
7. [实现优先级](#7-实现优先级)
8. [参考文档索引](#8-参考文档索引)

---

## 1. 背景与问题

### 1.1 当前状态

vfs4Agent 目前只有一个 `bash` 工具，实现于 `src/agent/adapters/openai.ts`：

```typescript
// LLM 返回的 tool_call 格式（OpenAI）
{
  tool_calls: [{
    id: "call_abc123",
    function: {
      name: "bash",
      arguments: '{"command": "grep -r OAuth /vfs/docs"}'  // JSON 字符串
    }
  }]
}

// Node.js 侧解析
const args = JSON.parse(toolCall.function.arguments);
const command = args.command;
const result = await execBash(command, mountPoint);
```

### 1.2 问题

1. **格式碎片化**：每个框架的 tool_call 消息格式不同，需要各自解析
2. **框架绑定**：当前代码只支持 OpenAI-compatible API
3. **无法复用**：沙箱执行逻辑（bash.ts + FUSE）与解析逻辑耦合
4. **生态隔离**：LangChain、LangGraph、CrewAI、Claude Agent SDK 的用户无法直接使用

### 1.3 目标

```
任意 Agent 框架
    → 各自的 tool_call 消息格式
      → 适配层统一解析
        → 统一的执行指令 { type: "bash", command: "..." }
          → bash.ts → FUSE → VectorStore
          → 统一的执行结果 { stdout, stderr, exitCode }
            → 适配层转换回框架特定格式
              → 发回给 LLM
```

---

## 2. 各框架 tool_call 格式对比

### 2.1 格式对比表

| 框架 | 语言 | tool_call 格式 | 工具定义方式 | 结果返回方式 |
|---|---|---|---|---|
| **OpenAI** | REST API / SDK | `{ tool_calls: [{ id, function: { name, arguments: JSON_STRING } }] }` | OpenAPI JSON Schema | `{ role: "tool", tool_call_id, content: STRING }` |
| **Anthropic Messages API** | REST API / SDK | `{ content: [{ type: "tool_use", id, name, input: OBJECT }] }` | `{ name, description, input_schema: JSON Schema }` | `{ type: "tool_result", tool_use_id, content: STRING }` |
| **Claude Agent SDK** | TypeScript | `{ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }` | `allowedTools: ["Bash", "Read", "Grep", ...]` | SDK 自动处理 |
| **LangChain** | Python | `AIMessage.tool_calls = [{ name, args: DICT, id }]` | `BaseTool` 或 `@tool` 装饰器 | `ToolMessage(content, tool_call_id)` |
| **LangGraph** | Python | 同 LangChain（基于 LangChain messages） | 同 LangChain | 同 LangChain + 图状态流转 |
| **CrewAI** | Python | 内部使用 LiteLLM → 转换为各 provider 格式 | `BaseTool._run()` | 内部处理，返回 Task 结果 |

### 2.2 关键差异

#### OpenAI 格式

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "bash",
          "arguments": "{\"command\": \"ls /vfs/docs\"}"
        }
      }]
    }
  }]
}
```

**特点**：
- `arguments` 是 **JSON 字符串**，需要 `JSON.parse()`
- 工具 ID 是 `call_*` 前缀
- 工具结果通过 `{ role: "tool", tool_call_id: "call_*", content: "..." }` 返回

#### Anthropic Messages API 格式

```json
{
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_abc123",
      "name": "bash",
      "input": { "command": "ls /vfs/docs" }
    }
  ]
}
```

**特点**：
- `input` 是 **JSON 对象**（不是字符串），直接可用
- 工具 ID 是 `toolu_*` 前缀
- 工具结果通过 `{ type: "tool_result", tool_use_id: "toolu_*", content: "..." }` 返回

#### Claude Agent SDK 格式

```typescript
// SDK 返回的消息流
{
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", name: "Bash", input: { command: "ls /vfs/docs" } }
    ]
  }
}
```

**特点**：
- 基于 Anthropic Messages API，但封装了一层
- 通过 `query()` 函数返回异步消息流
- `allowedTools` 声明可用工具，SDK 自动处理 tool_use/tool_result 往返
- 工具结果由 SDK 自动注入到上下文中

#### LangChain / LangGraph 格式

```python
# Python side
from langchain_core.messages import AIMessage

msg = AIMessage(
    content="",
    tool_calls=[{
        "name": "bash",
        "args": {"command": "ls /vfs/docs"},  # 直接是 Python dict
        "id": "abc123",
    }]
)

# Tool result
from langchain_core.messages import ToolMessage
ToolMessage(content="api-reference/\nauth/\nguides/\n", tool_call_id="abc123")
```

**特点**：
- Python 生态，`args` 是 Python dict
- 工具通过 `BaseTool` 类或 `@tool` 装饰器定义
- `ToolMessage` 是工具结果的标准消息类型
- LangGraph 在此基础上增加图状态管理

#### CrewAI 格式

```python
# Python side
from crewai_tools import BaseTool

class VfsBashTool(BaseTool):
    name: str = "vfs_bash"
    description: str = "Execute a bash command in the vfs sandbox"

    def _run(self, command: str) -> str:
        response = requests.post("http://vfs-agent:7801/v1/bash",
            json={"command": command})
        return response.json()["stdout"]
```

**特点**：
- CrewAI 使用 LiteLLM 作为 LLM 抽象层
- 工具通过继承 `BaseTool` 并实现 `_run()` 方法定义
- CrewAI 内部处理 tool_call 的格式转换（调用 LiteLLM → 转为 provider 格式）
- **对 vfs4Agent 来说**：CrewAI 侧不需要适配层，因为它已有 HTTP bridge 模式

### 2.3 共同点（可以抽象的部分）

尽管格式各异，所有框架的 tool_call 都可以归约为 **4 个核心字段**：

| 核心字段 | OpenAI | Anthropic | LangChain | 说明 |
|---|---|---|---|---|
| **tool_id** | `tool_calls[0].id` | `content[0].id` | `tool_calls[0].id` | 唯一标识，用于匹配结果 |
| **tool_name** | `.function.name` | `.name` | `.name` | 工具名称（如 "bash"） |
| **arguments** | `.function.arguments` (JSON 字符串) | `.input` (JSON 对象) | `.args` (Python dict) | 工具参数 |
| **result** | `{ role: "tool", content }` | `{ type: "tool_result", content }` | `ToolMessage(content)` | 执行结果 |

---

## 3. 核心设计：统一适配层

### 3.1 架构分层

```
┌─────────────────────────────────────────────────────────┐
│  Agent 框架层                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ OpenAI   │  │Anthropic │  │LangChain │  │CrewAI  │  │
│  │ SDK      │  │Agent SDK │  │/LangGraph│  │        │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       │              │              │            │       │
│       └──────┬───────┴──────┬───────┘            │       │
│              │              │                    │       │
│     ┌────────┴──────────────┴────────┐   ┌──────┴─────┐ │
│     │  适配层 (src/agent/adapters/)  │   │ HTTP bridge│ │
│     │                                │   │ (已有)     │ │
│     │  ┌──────────────────────────┐  │   └────────────┘ │
│     │  │  ToolCallAdapter 接口     │  │                  │
│     │  │  ┌────────────────────┐   │  │                  │
│     │  │  │ parseToolCall()    │   │  │  框架消息 → 统一格式 │
│     │  │  │ formatToolResult() │   │  │  统一格式 → 框架消息 │
│     │  │  │ toolSchema()       │   │  │  框架特定的工具声明   │
│     │  │  └────────────────────┘   │  │                  │
│     │  └──────────────────────────┘  │                  │
│     │  ┌──────────┐  ┌──────────┐   │                  │
│     │  │ openai   │  │anthropic │   │                  │
│     │  │ adapter  │  │ adapter  │   │                  │
│     │  └──────────┘  └──────────┘   │                  │
│     └──────────────────┬────────────┘                  │
│                        │                                │
│              ┌─────────┴──────────┐                    │
│              │  统一执行指令        │                    │
│              │  { type: "bash",   │                    │
│              │    command: "...", │                    │
│              │    toolId: "...",  │                    │
│              │    toolName: "..." }│                   │
│              └─────────┬──────────┘                    │
│                        │                                │
│              ┌─────────┴──────────┐                    │
│              │  执行层              │                    │
│              │  (src/agent/bash.ts)│                    │
│              │  spawn → FUSE → DB │                    │
│              └─────────┬──────────┘                    │
│                        │                                │
│              ┌─────────┴──────────┐                    │
│              │  统一执行结果        │                    │
│              │  { stdout, stderr, │                    │
│              │    exitCode }      │                    │
│              └────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

### 3.2 核心抽象：统一指令格式

```typescript
// src/agent/types.ts — 统一指令格式
export interface UnifiedToolCall {
  toolId: string;         // 工具调用唯一 ID
  toolName: string;       // 工具名称（如 "bash"）
  arguments: Record<string, unknown>;  // 解析后的参数对象
}

export interface UnifiedToolResult {
  toolId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  rawOutput: string;      // 原始输出（stdout + stderr）
}
```

---

## 4. 接口设计

### 4.1 ToolCallAdapter 接口

```typescript
// src/agent/adapters/types.ts

/**
 * Unified adapter interface for different Agent frameworks.
 *
 * Each adapter converts between the framework's native tool_call format
 * and the unified { UnifiedToolCall, UnifiedToolResult } format.
 */
export interface ToolCallAdapter<
  RequestMsg = unknown,    // Framework-specific request message type
  ResponseMsg = unknown,   // Framework-specific response message type
> {
  /**
   * Parse a framework-specific message into unified tool calls.
   * Returns null if the message doesn't contain tool calls.
   */
  parseToolCalls(msg: RequestMsg): UnifiedToolCall[] | null;

  /**
   * Format a unified tool result into a framework-specific response message.
   */
  formatToolResult(result: UnifiedToolResult): ResponseMsg;

  /**
   * Return the tool schema/definition in the format expected by this framework.
   * Used when registering tools with the framework.
   */
  toolSchema(toolName: string): unknown;

  /**
   * Framework identifier (for logging/debugging).
   */
  readonly framework: "openai" | "anthropic" | "claude-sdk" | "langchain";
}
```

### 4.2 统一工具声明

```typescript
// src/agent/adapters/tools.ts — vfs4Agent 的工具定义

/**
 * The tools that vfs4Agent exposes to any framework.
 * Currently just `bash`, but designed to be extensible.
 */
export const VFSTools = {
  bash: {
    name: "bash",
    description: "Execute a bash command in the documentation sandbox at /vfs",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute (e.g., ls /vfs/docs, grep -r auth /vfs/docs)",
        },
      },
      required: ["command"],
    },
  },
};
```

---

## 5. 各框架适配器详细设计

### 5.1 OpenAI 适配器

```typescript
// src/agent/adapters/openai_adapter.ts
import type { ToolCallAdapter, UnifiedToolCall, UnifiedToolResult } from "./types.js";
import type OpenAI from "openai";

export class OpenAIAdapter
  implements ToolCallAdapter<
    OpenAI.Chat.ChatCompletionMessage,
    OpenAI.Chat.ChatCompletionToolMessageParam
  >
{
  readonly framework = "openai" as const;

  parseToolCalls(msg: OpenAI.Chat.ChatCompletionMessage): UnifiedToolCall[] | null {
    if (!msg.tool_calls || msg.tool_calls.length === 0) return null;

    return msg.tool_calls.map((tc) => ({
      toolId: tc.id,
      toolName: tc.function.name,
      arguments: JSON.parse(tc.function.arguments), // JSON string → object
    }));
  }

  formatToolResult(result: UnifiedToolResult): OpenAI.Chat.ChatCompletionToolMessageParam {
    return {
      role: "tool",
      tool_call_id: result.toolId,
      content: JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
      }),
    };
  }

  toolSchema(toolName: string): OpenAI.Chat.ChatCompletionTool {
    const tool = VFSTools[toolName as keyof typeof VFSTools];
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }
}
```

**关键转换点**：
- `arguments`: JSON **字符串** → `JSON.parse()` → object
- result: object → `JSON.stringify()` → content **字符串**

### 5.2 Anthropic Messages API 适配器

```typescript
// src/agent/adapters/anthropic_adapter.ts
import type { ToolCallAdapter, UnifiedToolCall, UnifiedToolResult } from "./types.js";

interface AnthropicMessage {
  role: "assistant";
  content: Array<{
    type: "text" | "tool_use";
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    text?: string;
  }>;
}

interface AnthropicToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export class AnthropicAdapter
  implements ToolCallAdapter<AnthropicMessage, AnthropicToolResult>
{
  readonly framework = "anthropic" as const;

  parseToolCalls(msg: AnthropicMessage): UnifiedToolCall[] | null {
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) return null;

    return toolUses.map((block) => ({
      toolId: block.id!,
      toolName: block.name!,
      arguments: block.input!, // 已经是 object，不需要 JSON.parse
    }));
  }

  formatToolResult(result: UnifiedToolResult): AnthropicToolResult {
    return {
      type: "tool_result",
      tool_use_id: result.toolId,
      content: result.stdout || result.stderr || `[exit ${result.exitCode}]`,
    };
  }

  toolSchema(toolName: string): unknown {
    const tool = VFSTools[toolName as keyof typeof VFSTools];
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters, // Anthropic 叫 input_schema
    };
  }
}
```

**关键转换点**：
- `input`: 已经是 JSON **对象**，直接使用
- result: 直接返回字符串（不需要 JSON.stringify 包装）

### 5.3 Claude Agent SDK 适配器

```typescript
// src/agent/adapters/claude_sdk_adapter.ts
import type { ToolCallAdapter, UnifiedToolCall, UnifiedToolResult } from "./types.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

interface SDKToolCall {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

export class ClaudeSDKAdapter
  implements ToolCallAdapter<SDKMessage, void>
{
  readonly framework = "claude-sdk" as const;

  parseToolCalls(msg: SDKMessage): UnifiedToolCall[] | null {
    if (msg.type !== "assistant") return null;

    const toolUses = msg.message.content.filter(
      (b): b is SDKToolCall => b.type === "tool_use"
    );
    if (toolUses.length === 0) return null;

    return toolUses.map((block) => ({
      toolId: block.id ?? crypto.randomUUID(), // SDK 可能不提供 id
      toolName: block.name,
      arguments: block.input,
    }));
  }

  formatToolResult(_result: UnifiedToolResult): void {
    // Claude Agent SDK handles tool_result injection automatically
    // through the sandbox + allowedTools mechanism.
    // This adapter is mainly for parsing incoming tool_use events.
    // The SDK manages the result flow internally.
  }

  toolSchema(_toolName: string): string {
    // Claude SDK uses allowedTools string array, not full schemas
    return "Bash";
  }
}
```

**关键特点**：
- Claude Agent SDK **自动处理** tool_use ↔ tool_result 往返
- 适配层只需要解析 `tool_use` 事件
- 工具通过 `allowedTools: ["Bash", "Read", "Grep", "Glob"]` 声明
- SDK 自带沙箱模式（`sandbox.enabled: true`）

### 5.4 LangChain / LangGraph 适配器

LangChain/LangGraph 是 Python 框架，有两种集成方式：

#### 方案 A：HTTP Bridge（推荐，最简单）

CrewAI 现有模式——LangChain 定义一个 Python 工具，通过 HTTP 调用 vfs4Agent：

```python
# Python side (用户自己写，不需要我们实现)
from langchain_core.tools import tool
import requests

@tool
def vfs_bash(command: str) -> str:
    """Execute a bash command in the vfs sandbox."""
    resp = requests.post("http://vfs-agent:7801/v1/bash",
        json={"command": command})
    return resp.json()["stdout"]
```

**优点**：零代码改动，只需 HTTP 服务。
**缺点**：多一次网络跳转，LLM 不知道工具结果是 bash 输出还是别的。

#### 方案 B：Node.js 侧 MCP Server（更深度集成）

通过 MCP 协议，将 bash 工具暴露为 MCP tool：

```typescript
// src/agent/adapters/mcp_server.ts
// MCP (Model Context Protocol) server that exposes vfs bash as a tool.
// LangChain, Claude Desktop, and other MCP clients can connect via stdio or SSE.
```

这是 M3 任务，不在当前范围内。

### 5.5 CrewAI 集成

CrewAI 已经通过 HTTP Bridge 模式集成（`examples/crewai-qwen-demo/agent.py`）：

```python
class VfsBashTool(BaseTool):
    def _run(self, command: str) -> str:
        response = requests.post("http://vfs-agent:7801/v1/bash",
            json={"command": command})
        return response.json()["stdout"]
```

**不需要适配层代码**——CrewAI 通过 Python 侧的 `BaseTool` 自己处理 tool_call 格式转换。

---

## 6. 消息流转架构

### 6.1 完整的适配层流程

```
┌─ OpenAI SDK ────────────────────────────────────────────────────┐
│                                                                 │
│  User: "搜索 OAuth 文档"                                          │
│    → POST chat/completions (tools: [{function: {name: "bash"}}])│
│    ← { tool_calls: [{id:"call_1", function: {name:"bash",       │
│         arguments:'{"command":"grep -r OAuth /vfs/docs"}'}}] }   │
│                                                                 │
│    ↓ Node.js 侧 OpenAIAdapter.parseToolCalls()                  │
│    → UnifiedToolCall {                                          │
│         toolId: "call_1",                                       │
│         toolName: "bash",                                       │
│         arguments: { command: "grep -r OAuth /vfs/docs" }       │
│      }                                                          │
│                                                                 │
│    ↓ 执行层 (bash.ts)                                            │
│    → spawn("/bin/bash", ["-c", "grep -r OAuth /vfs/docs"])      │
│    → FUSE → VectorStore → DB                                   │
│    ← { stdout: "oauth.md:5:## OAuth 2.0...", exitCode: 0 }      │
│                                                                 │
│    ↓ OpenAIAdapter.formatToolResult()                           │
│    → { role: "tool", tool_call_id: "call_1",                    │
│         content: '{"stdout":"oauth.md:5:...",...}' }            │
│                                                                 │
│    → POST chat/completions (messages: [..., tool_response])     │
│    ← { content: "找到 4 个提及 OAuth 的文件..." }                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 不同框架的差异只在适配层

```
框架特定消息     →    适配层 parse    →    统一指令    →    执行层    →    统一结果    →    适配层 format    →    框架特定消息

OpenAI:         OpenAIAdapter         UnifiedToolCall   bash.ts       UnifiedResult   OpenAIAdapter         {role:"tool",...}
{tool_calls}    .parseToolCalls()     {toolId,name,     spawn→FUSE    {stdout,stderr, .formatToolResult()
                →                     arguments}        →DB           exitCode}       →

Anthropic:      AnthropicAdapter      (same)            (same)        (same)          AnthropicAdapter      {type:"tool_result",...}
{type:"tool_use" .parseToolCalls()                                       .formatToolResult()
 input:{}}      →                                                       →

Claude SDK:     ClaudeSDKAdapter      (same)            (same)        (same)          (SDK auto)            SDK 自动注入
{SDKMessage}    .parseToolCalls()                                       不需要手动转换

LangChain:      HTTP Bridge         (框架自己处理)     HTTP POST     HTTP Response   (框架自己处理)         ToolMessage
(Python)        不需要 Node.js 适配层                  →/v1/bash     JSON                                   (Python)
```

---

## 7. 实现优先级

### P0 — 立即实现（当前 OpenAI 适配器重构）

| 任务 | 说明 | 文件 |
|---|---|---|
| 定义 `UnifiedToolCall` / `UnifiedToolResult` | 统一类型 | `src/agent/adapters/types.ts` |
| 定义 `ToolCallAdapter` 接口 | 适配层接口 | `src/agent/adapters/types.ts` |
| 重构 `openai.ts` 为 `OpenAIAdapter` | 实现 OpenAI 适配 | `src/agent/adapters/openai_adapter.ts` |
| 定义 `VFSTools` 工具声明 | 统一工具定义 | `src/agent/adapters/tools.ts` |
| 更新 `repl.ts` 使用适配层 | REPL 调用适配层 | `src/agent/repl.ts` |

### P1 — Anthropic 支持

| 任务 | 说明 | 文件 |
|---|---|---|
| 实现 `AnthropicAdapter` | Anthropic Messages API 适配 | `src/agent/adapters/anthropic_adapter.ts` |
| 实现 `ClaudeSDKAdapter` | Claude Agent SDK 适配 | `src/agent/adapters/claude_sdk_adapter.ts` |
| 创建 Anthropic REPL | 基于 Anthropic API 的 REPL | `src/agent/adapters/anthropic_repl.ts` |

### P2 — LangChain / LangGraph 支持

| 任务 | 说明 | 文件 |
|---|---|---|
| 更新 HTTP Bridge | 确保 `/v1/bash` 端点格式清晰 | `src/server.ts` |
| 提供 Python 工具示例 | LangChain `@tool` 示例 | `examples/langchain-vfs/` |
| MCP Server（可选） | 深度集成 | `src/agent/adapters/mcp_server.ts` |

### P3 — 扩展

| 任务 | 说明 |
|---|---|
| 增加更多工具 | 除了 `bash`，可能增加 `search`（语义搜索）、`read`（直接读取）等工具 |
| 工具组合 | `bash` + `search` 组合使用 |
| 权限控制 | 工具级别的 RBAC |

---

## 8. 参考文档索引

### 已下载的参考文件

| 文件 | 来源 | 说明 |
|---|---|---|
| `agent-fuse-agent.ts.txt` | github.com/Jakob-em/agent-fuse | Claude Agent SDK 集成示例（参考 REPL 模式） |
| `langchain-tool-base.py.txt` | github.com/langchain-ai/langchain | LangChain BaseTool 源码参考 |

### 在线参考

| 资源 | URL | 说明 |
|---|---|---|
| OpenAI Function Calling | https://platform.openai.com/docs/guides/function-calling | tool_calls JSON 格式定义 |
| Anthropic Tool Use | https://docs.anthropic.com/docs/en/agents-and-tools/tool-use/overview | tool_use/tool_result 消息格式 |
| Anthropic Bash Tool | https://docs.anthropic.com/docs/en/agents-and-tools/tool-use/bash-tool | 内置 Bash 工具规范 |
| Claude Agent SDK | https://github.com/anthropics/claude-code | Agent SDK TypeScript 实现 |
| LangChain Tools | https://python.langchain.com/docs/concepts/tools/ | BaseTool / @tool 抽象 |
| LangGraph Tools | https://langchain-ai.github.io/langgraph/concepts/tools/ | 图节点中的工具调用 |
| CrewAI Tools | https://docs.crewai.com/concepts/tools | BaseTool._run() 模式 |
| MCP Protocol | https://modelcontextprotocol.io/specification | tools/call 协议 |

---

## 附录 A：设计决策记录

### 为什么不在各框架 SDK 内部适配？

因为我们提供的是**沙箱基础设施**，不是 Agent 框架。适配层应该在我们的代码里，而不是要求用户修改他们的框架代码。

### 为什么统一格式是 `{ type: "bash", command: "..." }`？

因为 FUSE 层的价值就是让**真实的 bash** 来处理一切。我们不需要解析具体命令（`ls`/`cat`/`grep`），只需把命令字符串交给 bash，FUSE 负责拦截文件操作。

### 为什么 CrewAI 不需要适配层？

CrewAI 通过 `BaseTool._run()` 自己处理一切，HTTP Bridge 就是它的集成点。适配层的意义是消除 HTTP 跳转，但 CrewAI 用户已经习惯了这种模式。

### 为什么 LangChain/LangGraph 推荐 HTTP Bridge？

因为它们是 Python 框架，Node.js 适配层无法直接嵌入 Python 进程。HTTP Bridge 是跨语言集成的最简方案。如果用户需要更深集成，可以用 MCP Server（P2）。

### 为什么不直接支持 MCP？

MCP 是一个单独的协议/服务器，复杂度较高。先做好 OpenAI/Anthropic 适配层，MCP Server 作为后续扩展项。
