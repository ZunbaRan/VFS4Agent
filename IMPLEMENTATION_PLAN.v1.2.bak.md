# vfs4Agent 实现路径

> 目标：构建一个**框架无关**的 Agent 虚拟文件系统（Virtual FileSystem for Agents），让任意 LLM Agent 都能用**完整的 bash 命令集**（不仅仅 ls/cat，还包括 grep/find/head/tail/wc/sort/uniq/awk/sed/管道/重定向读等）探索文档/知识库，底层复用向量数据库，零沙箱开销。
>
> 参考：
> - Mintlify ChromaFs 博客：<https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant>
> - Vercel just-bash：<https://github.com/vercel-labs/just-bash>
> - ZeroZ-lab vkfs：<https://github.com/ZeroZ-lab/vkfs>
>
> 关键洞察（来自原文作者评论）：**Chroma 内置 `$regex` 支持**，这是选择 Chroma 作为默认 backend 的核心原因——grep 的粗筛阶段可以把正则直接下推到 DB 层，无需自己实现 BM25/倒排索引。

---

## 一、设计目标

1. **框架无关**：Claude Code、Codex、Cursor、CrewAI、LangGraph、AutoGen … 都能接
2. **只读安全**：所有写操作返回 `EROFS`，天然无状态、无并发问题
3. **启动即用**：P90 冷启动 ≤ 200ms，对比容器沙箱的 40s+
4. **零边际成本**：复用已有向量库，不新增基础设施
5. **多租户 RBAC**：基于用户身份 prune PathTree，无权限路径对 Agent 完全不可见
6. **双交互模式**（v1.2 新增）：
   - **Tool 模式**：Agent 框架通过 function-calling / MCP 调用 VFS（现有 M2 / M3 路径）
   - **Shell-Native 模式**：LLM 直接"住"在 bash REPL 里，无工具 schema、无 Agent 框架、模型产出的每条消息就是命令（新增 M2.5）

---

## 二、分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  接入层 Adapters (面向 Agent 框架)                           │
│   ├─ MCP Server           (Claude Code / Claude Desktop)    │
│   ├─ OpenAI Function Tool (Codex / Cursor / 通用 OpenAI SDK)│
│   ├─ CrewAI Tool          (crewai_tools.BaseTool)           │
│   ├─ LangChain Tool       (langchain.tools.Tool)            │
│   └─ Vercel AI SDK Tool   (ai.tool)                         │
├─────────────────────────────────────────────────────────────┤
│  Shell 层 just-bash (复用)                                   │
│   ls cat grep find cd head tail wc sort uniq cut tr         │
│   awk sed tee xargs echo basename dirname stat file test    │
│   管道 | 重定向 < 进程替换 <() 条件 && || 子 shell $(...)   │
├─────────────────────────────────────────────────────────────┤
│  VFS Core (本项目核心)                                       │
│   ├─ PathTree         内存目录树 + RBAC pruning              │
│   ├─ ChunkReassembler cat 时按 chunk_index 排序拼页          │
│   ├─ GrepEngine       粗筛 (DB) → 精筛 (内存正则)            │
│   ├─ LazyPointer      S3/HTTP 大文件懒加载                   │
│   ├─ ReadOnlyGuard    所有写操作抛 EROFS                     │
│   └─ CacheLayer       LRU / Redis，chunk 级缓存              │
├─────────────────────────────────────────────────────────────┤
│  Backend Adapters (可插拔)                                   │
│   ├─ VectorStore: Chroma / Qdrant / SQLite+vss / pgvector   │
│   ├─ Embedder:    OpenAI / DashScope / BGE-local / Cohere   │
│   └─ Cache:       in-memory LRU / Redis                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、技术栈

| 组件 | 选型 | 理由 |
|---|---|---|
| 核心语言 | **TypeScript (Node 20+)** | 对齐 just-bash，shell 解析零成本 |
| Shell 引擎 | **just-bash** | Mintlify 原实现用它，IFileSystem 可插拔 |
| 向量库（默认）| **Chroma** | 原博客实现；本地 docker 一行起 |
| 向量库（轻量）| **SQLite + sqlite-vss** | 零依赖单文件，方便 demo/测试 |
| Embedder（默认）| **DashScope `text-embedding-v3`** | 与下文 LLM 统一账号，国内可用 |
| Cache | **lru-cache** → Redis | MVP 用内存，生产切 Redis |
| 包管理 | pnpm + 单仓多包 (`packages/*`) | adapter 独立发包 |
| 测试 | vitest + 真实 Qwen Agent E2E | 真实 LLM 闭环验证 |

---

## 四、项目结构

```
vfs4Agent/
├── packages/
│   ├── core/                     # VFS 核心
│   │   ├── src/
│   │   │   ├── fs/chromaFs.ts           # 实现 just-bash IFileSystem
│   │   │   ├── fs/pathTree.ts
│   │   │   ├── fs/reassembler.ts
│   │   │   ├── grep/engine.ts           # 两阶段 grep
│   │   │   ├── rbac/pruner.ts
│   │   │   ├── cache/lru.ts
│   │   │   └── types.ts                 # VectorStore / Embedder interface
│   │   └── package.json
│   │
│   ├── backend-chroma/           # Chroma 适配
│   ├── backend-sqlite/           # SQLite+vss 适配
│   ├── embedder-dashscope/       # 阿里云 DashScope（OpenAI 兼容）
│   ├── embedder-openai/
│   │
│   ├── adapter-mcp/              # → Claude Code / Desktop
│   ├── adapter-openai-tool/      # → Codex / 通用 OpenAI
│   ├── adapter-crewai/           # → CrewAI (Python，通过 HTTP 桥 or 纯 Python 重写)
│   ├── adapter-langchain/
│   └── adapter-ai-sdk/           # → Vercel AI SDK
│
├── apps/
│   ├── ingest-cli/               # 本地 docs → 向量库
│   └── vfs-server/               # 独立 HTTP/stdio 服务（给非 TS Agent 用）
│
├── examples/
│   ├── claude-code-demo/
│   ├── codex-demo/
│   ├── crewai-qwen-demo/         # ← 用 Qwen 做 E2E 测试
│   └── sample-docs/              # 测试文档集
│
├── IMPLEMENTATION_PLAN.md        # 本文档
└── package.json
```

---

## 五、核心接口定义（TypeScript）

```ts
// packages/core/src/types.ts

export interface PathTreeEntry {
  isPublic: boolean;
  groups: string[];
  lazy?: { kind: "s3" | "http"; url: string };
}

export interface Chunk {
  page: string;          // slug，如 "auth/oauth"
  chunk_index: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface PathFilter {
  allowedSlugs?: Set<string>;
  groups?: string[];
}

export interface VectorStore {
  getPathTree(): Promise<Record<string, PathTreeEntry>>;
  upsertPathTree(tree: Record<string, PathTreeEntry>): Promise<void>;

  getChunksByPage(slug: string): Promise<Chunk[]>;
  bulkGetChunksByPages(slugs: string[]): Promise<Map<string, Chunk[]>>;
  upsertChunks(chunks: Chunk[]): Promise<void>;

  /** 子串/正则粗筛，返回命中的 page slug 集合 */
  searchText(pattern: string, opts: {
    regex?: boolean;
    ignoreCase?: boolean;
    filter: PathFilter;
    limit?: number;
  }): Promise<string[]>;

  /** 可选：语义检索（semantic search 命令） */
  searchVector?(queryVec: number[], topK: number, filter: PathFilter): Promise<Chunk[]>;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimension(): number;
}

export interface Session {
  userId?: string;
  groups: string[];
}
```

---

## 六、多 Agent 框架适配策略

这是**本次相对原实现扩展最大的部分**。Mintlify 把 ChromaFs 嵌进自家 Next.js，我们需要对外开放。核心原则：**以协议解耦，一套核心多个 adapter**。

### 6.1 适配矩阵

| 目标 Agent | 适配方式 | 传输 | 状态 |
|---|---|---|---|
| Claude Code / Claude Desktop | **MCP server** (stdio) | JSON-RPC over stdio | M3 必做 |
| Codex / OpenAI Agent SDK | OpenAI **function-calling tool** | in-process or HTTP | M3 |
| Cursor | MCP (同 Claude Code) | stdio | M3 |
| Vercel AI SDK | `tool({ execute })` | in-process | M2 |
| **CrewAI** | `crewai.tools.BaseTool` 子类 | HTTP → vfs-server | **M2（本次新增）** |
| LangChain / LangGraph | `StructuredTool` | HTTP | M4 |
| AutoGen | `register_function` | HTTP | M4 |

### 6.2 统一工具 schema

所有 adapter 最终暴露给 LLM 的是**同一套工具签名**，保证 prompt 可跨框架复用：

```jsonc
[
  { "name": "vfs_ls",     "args": { "path": "string" } },
  { "name": "vfs_cat",    "args": { "path": "string" } },
  { "name": "vfs_grep",   "args": { "pattern": "string", "path": "string", "regex?": "bool", "ignoreCase?": "bool" } },
  { "name": "vfs_find",   "args": { "path": "string", "name?": "string" } },
  { "name": "vfs_search", "args": { "query": "string", "path": "string", "topK?": "int" } }
]
```

也提供一个**万能 bash 工具**（走 just-bash）：

```jsonc
{ "name": "vfs_bash", "args": { "command": "string" } }
```

> 实验表明：给强模型（Claude Sonnet / Qwen3.6-plus / GPT-5）**只暴露 `vfs_bash` 一个工具**效果最好，让它自己组合 `grep -ril ... | xargs cat`；给中小模型则拆成多个原子工具更稳。

### 6.3 vfs-server（HTTP/stdio 桥）

为非 TS 框架（CrewAI / LangChain Python / AutoGen）提供一个轻量 server：

```
POST /v1/fs/ls      { path }       → { entries: [...] }
POST /v1/fs/cat     { path }       → { content: "..." }
POST /v1/fs/grep    { pattern,... }→ { matches: [{file,line,text}] }
POST /v1/fs/find    { path,name }  → { paths: [...] }
POST /v1/fs/search  { query,topK } → { hits: [...] }
POST /v1/bash       { command }    → { stdout, stderr, exitCode }
Header: X-VFS-Session (JWT 携带 userId/groups)
```

Python 端的 CrewAI tool 就是一层薄 HTTP client。

---

## 七、CrewAI + Qwen E2E 测试方案（本次新增）

### 7.1 配置

在仓库根 `.env.example`：

```ini
# LLM (Qwen via DashScope OpenAI-compatible)
DASHSCOPE_API_KEY=sk-7d82264e78b34a8dae8c29a3b2bf2ddc
OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_API_KEY=${DASHSCOPE_API_KEY}
LLM_MODEL=qwen3.6-plus

# Embedder（复用同账号）
EMBED_MODEL=text-embedding-v3
EMBED_DIMENSION=1024

# VFS Server
VFS_SERVER_URL=http://localhost:7801
VFS_SESSION_TOKEN=dev-token
```

> 安全提示：示例 key 仅限本地开发 / 你自己使用，**不要提交到 git**。`.env` 放进 `.gitignore`。

### 7.2 Python 端 CrewAI Agent（`examples/crewai-qwen-demo/agent.py`）

```python
import os, requests
from crewai import Agent, Task, Crew, LLM
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

# ---- 1. 配置 Qwen LLM ----
llm = LLM(
    model=f"openai/{os.environ['LLM_MODEL']}",   # crewai 用 litellm，openai/ 前缀即 OpenAI 兼容
    base_url=os.environ["OPENAI_API_BASE"],
    api_key=os.environ["OPENAI_API_KEY"],
)

# ---- 2. 封装 vfs-server 为 CrewAI 工具 ----
VFS = os.environ["VFS_SERVER_URL"]
HEADERS = {"X-VFS-Session": os.environ["VFS_SESSION_TOKEN"]}

class BashArgs(BaseModel):
    command: str = Field(..., description="bash command to run against the docs filesystem")

class VfsBashTool(BaseTool):
    name: str = "vfs_bash"
    description: str = (
        "Run UNIX shell commands (ls, cat, grep, find, head, tail, wc, pipes) "
        "against a read-only documentation filesystem mounted at /docs. "
        "Writes are forbidden. Use this to explore and quote exact text."
    )
    args_schema: type[BaseModel] = BashArgs

    def _run(self, command: str) -> str:
        r = requests.post(f"{VFS}/v1/bash", json={"command": command}, headers=HEADERS, timeout=30)
        r.raise_for_status()
        d = r.json()
        return f"exit={d['exitCode']}\n--- stdout ---\n{d['stdout']}\n--- stderr ---\n{d['stderr']}"

# ---- 3. 组装 Agent ----
researcher = Agent(
    role="Docs Researcher",
    goal="Answer user questions with exact quotes from the docs filesystem.",
    backstory="You explore /docs using UNIX commands. You NEVER guess; you cat the relevant file and quote.",
    tools=[VfsBashTool()],
    llm=llm,
    verbose=True,
)

task = Task(
    description="How do I authenticate with OAuth? Give exact code snippet from the docs.",
    expected_output="A concise answer with a verbatim code block copied from /docs.",
    agent=researcher,
)

Crew(agents=[researcher], tasks=[task]).kickoff()
```

### 7.3 TS 端 vfs-server 启动（`apps/vfs-server`）

```bash
pnpm -C apps/vfs-server dev   # 默认监听 :7801
```

### 7.4 测试闭环验收标准

| 用例 | 期望行为 |
|---|---|
| Agent 问 "how to authenticate" | 先 `grep -ril oauth /docs`，再 `cat` 命中文件，引用原文作答 |
| Agent 尝试 `echo x > /docs/a.md` | 返回 `EROFS: read-only file system` |
| 无权限用户访问 `/internal/*` | `ls /internal` 为空，`cat /internal/billing.mdx` 返回 `ENOENT` |
| 粗筛命中 100 文件 | 网络 1 次 DB query + 1 次 bulk fetch，p95 < 300ms |

---

## 七-bis、Shell-Native Agent 模式（v1.2 新增）

> 场景：**任务单一且确定**（只做文档检索），不需要多 Agent 协作、不需要跨工具编排。此时"用一个 Agent 框架包着一个 VFS 工具"反而成了累赘——多一层 JSON schema、多一次 prompt 往返、多一份"Agent 在用工具"的自我意识。本节定义另一种更极简的交互方式：**让模型以为自己刚 SSH 登录到一台只读的文档服务器上**。

### 7b.1 对比

| 维度 | Tool 模式（M2 已实现） | Shell-Native 模式（M2.5 规划） |
|---|---|---|
| 模型身份 | 一个拿着 `vfs_bash` 工具的 Agent | 一个登录到 `docs-shell` 的用户 |
| 消息载荷 | `ToolCall(vfs_bash, {command})` JSON | 纯文本——每条 assistant 消息就是一行命令 |
| 需要的 LLM 能力 | function-calling | 仅 `chat.completions`，无需任何结构化输出 |
| 会话状态 | 每次 tool call 独立 | 持久 `cwd` / `env` / alias / history |
| 终止条件 | Agent 框架判断任务完成 | 模型调用 shell 内置的 `answer "..."` 命令 |
| 中介层 | CrewAI + HTTP + Fastify | 无，进程内直连 `Bash.exec()` |
| 工具 schema | 有 | **无** |
| 系统提示 | "You are an agent with tool X..." | MOTD + `user@docs:/docs$` 提示符 |

**取舍**：
- ✅ Shell-Native **召回率和推理链路更自然**——因为模型在预训练语料里见过千万次 bash 会话
- ✅ 省掉 Agent 框架 + HTTP 桥两层依赖，延迟更低
- ✅ 审计日志就是一段纯 bash history，人可读
- ❌ 不能做多 Agent 协作（单用户会话）
- ❌ 需要自己实现"轮次控制 + 终止判定 + 输出裁剪"，Agent 框架本来免费送的
- ❌ 模型如果 hallucinate 不存在的命令（`pip install ...`），没有 Agent 框架的纠错反馈回路

### 7b.2 五个关键实现手法（缺一会穿帮）

1. **持久化 bash 会话**：整次对话共享同一个 `Bash` 实例，`cwd` / env / alias / history 跨轮保留。不要每轮 `new Bash()`。
2. **MOTD + PS1**：首轮 system/user message 不再是 "You are an assistant..."，而是：
   ```
   Last login: Tue Apr 22 10:00:00 2026 from 10.0.0.1
   Welcome to docs-shell (read-only docs filesystem).
   Type `help` for available commands, `answer "..."` when you have the final answer.

   user@docs:/docs$ 
   ```
   每次回灌 stdout 后追加新的 `user@docs:<cwd>$ ` 提示符。
3. **无 tool schema**：调用 `chat.completions.create` 时**不传** `tools` / `functions`。让模型输出纯文本——文本的每一行就是下一条命令。可选：从代码块里提取（允许模型用 \`\`\`bash ... \`\`\` 包裹）。
4. **`answer` 内置命令**：shell 注册一条 `defineCommand("answer", ...)`，执行时把参数作为最终答案抛一个特殊哨兵信号（`AnswerSignal`），由外层 runner 捕获并结束循环。这是唯一"打破第四面墙"的出口。
5. **输出裁剪**：每轮 stdout 超过 N 行（例如 200 行 / 4KB）自动截断 + 追加 `... (truncated; use head/tail/grep to narrow)`。否则模型会被自己 `cat` 出的长文本淹死导致 context 爆炸。

### 7b.3 额外"沉浸感"细节（可选，按需加）

| 细节 | 作用 |
|---|---|
| 虚构的 `uname -a` / `hostname` / `whoami` | 模型若探索环境，得到的是可信的 Linux 输出而非 `command not found` |
| 虚构的 `/etc/motd` `/etc/os-release` `/proc/version` | 同上，in-memory fs 预填 |
| `history` 命令工作 | 让模型能 `!grep` 重放；just-bash 已内置 |
| `help` 命令 | 列出可用命令清单；对齐"像 shell" |
| 命令未找到时返回 `bash: xxx: command not found` | 精确复制真 bash 的错误文案 |
| 速率限制 | 单轮命令数上限（例如 30 条）防死循环 |

### 7b.4 终止信号的三种实现（选一）

| 方案 | 实现 | 优缺点 |
|---|---|---|
| **A. 内置 `answer` 命令** | `defineCommand("answer", (args) => { throw new AnswerSignal(args.join(" ")); })` | ✅ 简洁，模型预训练里见过 `echo` 这种命令形态 |
| B. 检测特殊 EOF 字符串 | 模型输出 `<<<EOF>>>` 时终止 | ❌ 要 prompt 明确说明，不够 shell-like |
| C. 连续 N 轮无命令 | 超时终止 | ❌ 浪费 token，可能漏答 |

**默认选 A**。

### 7b.5 目标代码形态（`src/runner/shellRunner.ts`，M2.5 实现）

```ts
export async function runShellAgent(opts: {
  question: string;
  store: VectorStore;
  llm: OpenAI;                     // DashScope OpenAI-compatible
  model: string;                   // e.g. "qwen-plus"
  maxTurns?: number;               // default 30
  maxOutputBytes?: number;         // default 4096
}): Promise<{ answer: string; transcript: Turn[] }> {
  const { bash, vfs } = createShell({ store: opts.store });
  installAnswerCommand(bash);      // defineCommand("answer", ...)
  const motd = renderMotd(opts.question);

  const messages: ChatMessage[] = [
    { role: "system", content: SHELL_SYSTEM_PROMPT },
    { role: "user", content: motd + `\nuser@docs:/docs$ ` },
  ];

  for (let turn = 0; turn < (opts.maxTurns ?? 30); turn++) {
    const resp = await opts.llm.chat.completions.create({
      model: opts.model, messages, temperature: 0.2,
      // NO tools / functions —— pure text completion
    });
    const cmd = extractCommand(resp.choices[0].message.content ?? "");
    messages.push({ role: "assistant", content: cmd });

    try {
      const r = await bash.exec(cmd);
      const out = truncate(r.stdout + (r.stderr ? `\n${r.stderr}` : ""), opts.maxOutputBytes);
      messages.push({ role: "user", content: `${out}\nuser@docs:${bash.cwd}$ ` });
    } catch (e) {
      if (e instanceof AnswerSignal) return { answer: e.text, transcript: /* ... */ };
      messages.push({ role: "user", content: formatBashError(e) });
    }
  }
  throw new Error("max turns exceeded");
}
```

### 7b.6 系统提示（shell 登录风格）

```
You are interacting via a real bash shell. Each of your replies must be exactly
one shell command (no explanation, no markdown fences). The session runs against
a read-only documentation filesystem mounted at /docs. /tmp is writable scratch.

When you have a final answer for the user, call:
    answer "<your final answer, with citations like /docs/auth/oauth.md>"

Available: ls cat head tail wc find grep tree awk sed sort uniq cut tr xargs
          basename dirname echo printf history help answer
```

### 7b.7 与现有代码的复用关系

- `SqliteVectorStore`、`VirtualFs`、`createShell`、`defineCommand`：**零改动**，直接复用
- `grep/engine.ts`：**零改动**
- `src/server.ts`（Fastify）、`examples/crewai-qwen-demo/`：**保留**（Tool 模式仍有用，比如多 Agent 协作场景）
- 新增：`src/runner/shellRunner.ts` + `src/runner/motd.ts` + `src/runner/answer.ts` + `src/cli/ask.ts`（CLI：`pnpm ask "问题"`）
- 新增依赖：`openai`（已安装）

### 7b.8 Shell-Native 模式下 MCP / Tool 接入的意义重估

既然这种模式下 Agent 对 VFS 无感知，那 HTTP / MCP 还有意义吗？有，但意义缩小为：

1. **多用户共享同一个 VFS 实例**——server 模式下内存常驻，省去每次 re-ingest
2. **跨语言** —— Python/Go/Rust 写的 runner 也能驱动同一个 shell 后端
3. **可观测性** —— 集中收集所有 bash history 做审计

但**单机单用户"问答一次"场景下，Shell-Native 模式直接进程内运行就是最优解**，不需要 HTTP 也不需要 MCP。

---

## 八、命令覆盖矩阵（本次重写）

核心原则：**能复用 just-bash 内置命令的绝不重写**。just-bash 已经完整实现了 awk/sed/sort/uniq/head/tail/wc/xargs/cut/tr/tee/test 以及管道、重定向、进程替换、命令替换、逻辑运算符——这些**只要我们的 `IFileSystem` 接口的 `readFile/readdir/stat` 实现正确，所有这些命令自动可用**。

| 命令 | 是否需拦截 | 实现思路 |
|---|---|---|
| `ls` `cd` `pwd` `stat` `test` `file` `basename` `dirname` | 不拦截 | just-bash 内置 → 调用我们的 `readdir/stat`（函内存 PathTree） |
| `cat` `head` `tail` `wc` `sort` `uniq` `cut` `tr` `rev` `tac` | 不拦截 | just-bash 内置 → 调用我们的 `readFile`（chunk 重组 + cache） |
| `find` | 可选拦截 | 小规模树直接让 just-bash 走 readdir；数万文件时拦截改走 PathTree 内存遍历 |
| `grep` `grep -r` `grep -E` `grep -P` | **必拦截** | 粗筛：Chroma `$regex` / `$contains` → 精筛：交回 just-bash 内存正则 |
| `awk` `sed` | 不拦截 | just-bash 内置在读出的 chunk 内容上跑，天然支持管道 |
| `xargs` `tee` `echo` `printf` | 不拦截 | just-bash 内置；tee 写到 `/tmp` 可行（MountableFs 挂一个 InMemoryFs） |
| 管道 `\|` / 重定向 `<` / `>` / `>>` | 写拍截 | 读管道全开；写 `>` `>>` 到 ChromaFs 路径抛 `EROFS`，写到 `/tmp`（InMemoryFs）放行 |
| `echo $(cmd)` `<(cmd)` `&&` `\|\|` `;` | 不拦截 | just-bash AST 已处理 |
| `search` （语义） | 自定义 | `defineCommand('search', ...)` 调 `VectorStore.searchVector` |
| `tree` | 自定义 | `defineCommand`：走内存 PathTree 直接渲染 |
| `curl` `sqlite3` `python3` `js-exec` | **默认关** | just-bash 需单独 opt-in；文档探索场景不需要 |
| 任意写文件到 VFS 路径 | 拦截 | `ReadOnlyGuard` 包裹的路径全部抛 `EROFS` |

### 关键技巧：`MountableFs` 混装

利用 just-bash 的 `MountableFs` 把两个 fs 合在一个 namespace：

```ts
const fs = new MountableFs({
  base: new InMemoryFs({ files: {} }),      // /tmp、/home/user 等工作区
  mounts: [
    { mountPoint: "/docs",     filesystem: new ChromaFs({ store, session }) },
    { mountPoint: "/internal", filesystem: new ChromaFs({ store, session, collection: "internal" }) },
  ],
});
const bash = new Bash({ fs, cwd: "/home/user" });
```

这样 Agent 可以：
- `grep -rl "token" /docs | tee /tmp/hits.txt`（读 VFS，写内存 scratch）
- `cat /tmp/hits.txt | xargs -I{} head -20 {}`（复杂管道，纯内存执行）
- `echo hi > /docs/a.md` → `EROFS`
- `echo hi > /tmp/a.md` → OK

---

## 九、里程碑（重新编排——尽早交付完整命令集）

| 里程碑 | 内容 | 产出 |
|---|---|---|
| **M1** Walking Skeleton——**全命令可用** | ① 接入 just-bash + `ChromaFs implements IFileSystem`（readdir/stat/readFile/写招 EROFS）<br>② MountableFs：`/docs` 挂 ChromaFs，`/tmp` `/home/user` 挂 InMemoryFs<br>③ ingest CLI（本地 md → chunk → Chroma + `__path_tree__`）<br>④ **验收：`ls cat head tail wc sort uniq cut tr awk sed find tree` 全部开箱可用**（它们自动调 IFileSystem，无需单独实现）<br>⑤ 临时 grep 走默认暴力遍历（等 M2 优化） | `packages/core`，`apps/ingest-cli`，`examples/sample-docs` |
| **M2** Grep 优化 + AI SDK + **CrewAI/Qwen E2E** | ① **拦截 grep**：`defineCommand('grep')` 或 AST transform plugin<br>② 粗筛：利用 **Chroma `$regex`**（原文作者评论明确推荐）+ `$contains` 拿候选 slugs<br>③ `bulkPrefetch` 候选 chunks 进 LRU<br>④ 重写命令交回 just-bash 内存精筛（行级正则）<br>⑤ Vercel AI SDK tool + `vfs-server`(Fastify)<br>⑥ **CrewAI + Qwen3.6-plus demo 跑通** | `adapter-ai-sdk`，`apps/vfs-server`，`examples/crewai-qwen-demo`，grep p95 benchmark |
| **M2.5**（v1.2 新增）**Shell-Native Agent** | ① `src/runner/shellRunner.ts`：多轮 chat loop + 持久 `Bash` 会话<br>② `installAnswerCommand(bash)`：`defineCommand('answer', ...)` 抛 `AnswerSignal`<br>③ MOTD + PS1 + 输出裁剪 + 命令提取（支持 \`\`\`bash fences）<br>④ `src/cli/ask.ts`：`pnpm ask "how do I authenticate?"`，零 Agent 框架依赖<br>⑤ 系统提示按"shell 登录"风格写，`tools=[]` 纯 chat completion<br>⑥ `examples/shell-native-qwen/` 对比 demo：同一问题分别用 CrewAI 和 shell-native 跑，对比 token 用量 / 响应延迟 / 召回准确度 | `src/runner/`，`src/cli/ask.ts`，`examples/shell-native-qwen/`，token & latency benchmark |
| **M3** MCP + OpenAI Tool + RBAC | ① MCP server（stdio）— Claude Code / Cursor 直接挂<br>② OpenAI function-calling adapter — Codex / 通用 OpenAI SDK<br>③ `Session { userId, groups }` + PathTree pruning + query filter<br>④ 错误语义打磨（ENOENT vs EACCES vs EROFS） | `adapter-mcp`，`adapter-openai-tool`，`rbac` 模块 |
| **M4** 多 backend + 懒加载 + 语义搜索 | ① `VectorStore` 抽象落地：SQLite+vss / Qdrant / pgvector<br>② `LazyPointer`：S3/HTTP 懒加载大文件<br>③ 自定义 `search` 命令（语义检索，topK + 引用）<br>④ 自定义 `tree` `du` | `backend-sqlite`，`backend-qdrant`，`embedder-dashscope` |
| **M5** 生产化 | ① Redis cache<br>② PathTree 增量更新（webhook/CDC）<br>③ 指标（启动/grep/cat/cache hit）<br>④ `docker-compose up` 一键跑通<br>⑤ 端到端 benchmark（对比沙箱方案的 46s vs 我们的 100ms） | `deploy/`，`benchmarks/`，完整 README |

### 为什么 M1 就能有全命令集？

因为 **just-bash 的所有内置命令都是面向 `IFileSystem` 接口编写的**（它们调 `fs.readFile / fs.readdir / fs.stat`）。只要 ChromaFs 实现了这 3 个方法，`awk / sed / sort | uniq -c | sort -rn | head` 这种复杂管道自动就能跑。原文的 ChromaFs 并不是自己实现 awk/sed，而是用 just-bash 内置的。

M1 唯一留给 M2 的是 **grep 的性能**：不拦截的话 grep 会暴力 readFile 每个文件，网络打爆；拦截后走 Chroma `$regex` 粗筛才能做到毫秒级。

---

## 十、关键实现注意点

1. **“能用 just-bash 内置的就不要自己写”**：awk/sed/sort/uniq/head/tail/wc/xargs 都已经是用 TS 重实现并走 IFileSystem 的。**唯一值得拦截的是 grep**（性能）和写操作（安全）。
2. **利用 Chroma 原生 `$regex`**（原文作者评论明确推荐）：把正则下推到 DB 粗筛阶段。方言差异：Chroma `$regex` 是 RE2 语法，**不支持 lookaround/backreference**，遇到不支持的模式应降级为 `$contains`（取子串字面量）再交给内存精筛。
3. **MountableFs 混装**：`/docs` 挂 ChromaFs（只读）、`/tmp` `/home/user` 挂 InMemoryFs（可写 scratch）。这样 `grep ... | tee /tmp/hits.txt` 这种常见管道天然支持。
4. **PathTree 压缩**：整棵树 gzip 后作为一条特殊记录 `__path_tree__` 存在向量库里，**向量库是唯一真相源**。
5. **Chunk 切分策略**：Markdown 按段落 + heading 边界；其他文本按行。**不按固定 token 切**，否则 grep 跨 chunk 命中时会漏行号。ingest 时记录每个 chunk 的起始行号，精筛阶段拼页后再打行号。
6. **只读即无状态**：所有对 VFS 挂载点的写操作 `throw EROFS`，**无需 session 生命周期管理**。
7. **Agent prompt 对齐 UNIX**：system prompt 明确列出可用命令和挂载点（`/docs` 只读、`/tmp` 可写），让 LLM 的预训练 bash 知识直接迁移。
8. **错误信息透传**：`grep: invalid regex`、`ENOENT`、`EROFS`、`EACCES` 原样给 Agent，避免无意义重试。
9. **关闭高危内置**：`curl`、`sqlite3`、`python3`、`js-exec` 默认不开（just-bash 已默认 off）；文档探索场景不需要。
10. **Embedding 一致性**：ingest 和 query 必须用同一个 `EMBED_MODEL` + 同一维度，跨模型迁移需全量 re-embed。
11. **安全**：vfs-server 的 `X-VFS-Session` 走 JWT；HTTP 暴露公网前加 rate limit；必须强制 `isPathWithinRoot` 检查（just-bash 已有该保护，不要绕开）。

---

## 十一、下一步行动

按优先级（v1.2 更新后）：

1. ~~搭 M1 骨架~~ ✅ 已完成（SQLite + VirtualFs + 全 bash 命令集）
2. ~~M2 grep 拦截 + CrewAI/Qwen E2E~~ ✅ 已完成
3. **M2.5 Shell-Native Agent**（本次新增重点）—— `src/runner/shellRunner.ts` + `src/cli/ask.ts`，让 Qwen 直接"登录"到 bash 里做文档问答，再跑一个 token / latency 对比 benchmark 对照 Tool 模式
4. M3 MCP adapter — 接 Claude Code 做演示
5. M3 OpenAI function-calling adapter — 接 Codex / 通用 OpenAI SDK
6. M4 多 backend + 语义搜索 `search` 自定义命令

---

*Document version: v1.2 — 2026-04-22*  
*v1.1 changelog: 扩大 bash 命令覆盖，新增命令矩阵；M1 即交付全命令集；补充 Chroma `$regex` 原生支持的优势分析；增加 MountableFs 混装方案。*  
*v1.2 changelog: 新增 §7-bis **Shell-Native Agent 模式**，与 Tool 模式并列；设计目标补充"双交互模式"；里程碑插入 M2.5（shellRunner + ask CLI + 对比 benchmark）；重估 HTTP/MCP 在 shell-native 场景下的意义（缩小为多用户/跨语言/审计三点）。*
