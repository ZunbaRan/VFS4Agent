# vfs4Agent 实现路径 — v2.0（Sandbox-First）

> **一句话定位**：vfs4Agent 是一个**为 LLM Agent 提供的只读 UNIX 沙箱**——Agent 以为自己 SSH 到了一台 Linux 机器，能用完整 bash 命令集（ls/cat/grep/find/awk/sed/管道…）探索挂在 `/docs` 下的文档。底层不是真文件系统，而是向量数据库。**沙箱就是拦截点**：Agent 发出的每一条 `grep` / `cat` / `ls` 都被沙箱翻译成对 DB 的一次查询。
>
> 参考：
> - Mintlify ChromaFs：<https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant>
> - Vercel just-bash：<https://github.com/vercel-labs/just-bash>（内置 ls/cat/awk/sed/管道/重定向，面向 `IFileSystem` 接口）
> - Chroma `$regex` pushdown：原博客作者评论明确指出是选 Chroma 的关键原因
>
> **v2.0 重构原则**（来自用户讨论）：
> 1. **沙箱是第一原语**，不是某个 Agent 框架的工具。先有沙箱，才谈怎么接入框架。
> 2. **Tool 模式和 Shell-Native 模式是进入同一个沙箱的两个入口**，不是两条并行路线。
> 3. **伪装 (realism) 属于沙箱本身的能力**——在早期里程碑就必须有，不是生产化阶段才加。
> 4. **Chroma 是默认后端**（ChromaFs 就是本项目的北极星）。SQLite 只是开发期的零依赖 fallback。
> 5. **生产化是独立的事**（M5+），不应主导里程碑排期。

---

## 〇、分层架构（新）

```
┌──────────────────────────────────────────────────────────────────┐
│  Agent 的视角：一台运行 Ubuntu 22.04 的 Linux 机器               │
│  $ uname -a → Linux docs 5.15.0-1048-aws ... x86_64 GNU/Linux    │
│  $ whoami   → user                                               │
│  $ ls /docs → api-reference/  auth/  guides/                     │
└──────────────────────────────────────────────────────────────────┘
             ▲ Shell-Native：纯文本 chat loop      ▲ Tool mode：HTTP /v1/bash
             │ (src/runner/shellRunner.ts)         │ (src/server.ts, Fastify)
             │                                     │
┌────────────┴─────────────────────────────────────┴───────────────┐
│ §1 沙箱核心 (THE ONE INTERCEPT POINT)                            │
│   ├─ just-bash Bash 实例     ← 完整 bash 语义 / AST / 内置命令   │
│   ├─ MountableFs                                                 │
│   │    ├─ / (base)     = InMemoryFs(realism) ← 伪装的 /etc /proc │
│   │    └─ /docs        = VirtualFs(store)    ← 真正的拦截点      │
│   ├─ baseEnv            = HOME/USER/HOSTNAME/PATH/PWD/...        │
│   └─ customCommands     = grep, tree, uname, whoami, hostname,id │
│                                                                  │
│   → Agent 调 `grep foo /docs` → 沙箱把它变成 store.searchText()  │
│   → Agent 调 `cat /docs/x.md` → 沙箱把它变成 store.getChunks(x)  │
│   → Agent 调 `uname -a`       → 沙箱返回伪造但可信的字符串       │
│   → Agent 调 `echo x > /docs/…` → 沙箱返回 EROFS                 │
└──────────────────────────────┬───────────────────────────────────┘
                               │ VectorStore interface
                               │ (单一抽象层，backend 可换)
┌──────────────────────────────┴───────────────────────────────────┐
│ §2 VectorStore 抽象 (src/types.ts)                               │
│   getPathTree / upsertPathTree                                   │
│   getChunksByPage / bulkGetChunksByPages / upsertChunks          │
│   searchText(pattern, {regex, ignoreCase, pathPrefix, rbac})     │
│   searchVector?(…) ← M4 语义搜索                                 │
└──────────────────────────────┬───────────────────────────────────┘
                               │
           ┌───────────────────┴────────────────────┐
           ▼                   ▼                    ▼
┌─────────────────┐ ┌──────────────────┐ ┌────────────────────┐
│ ChromaStore     │ │ SqliteFtsStore   │ │ …pgvector / Qdrant │
│ (DEFAULT / 北极 │ │ (dev fallback,   │ │  (M4+)             │
│  星, ChromaFs)  │ │  单文件零依赖)   │ │                    │
│ $regex pushdown │ │ FTS5 pushdown    │ │                    │
│ PathTree 作为   │ │ PathTree 作为    │ │                    │
│ 哨兵文档        │ │ 单行 KV 表       │ │                    │
└─────────────────┘ └──────────────────┘ └────────────────────┘
```

**解读**：
- 上半框是**一个沙箱**——无论你从 HTTP 进来（CrewAI/LangChain）还是从 chat loop 进来（Shell-Native），都落到同一个 `Bash` + `MountableFs` 实例。
- 下半框是**一条抽象线**——所有对 `/docs` 的访问都收敛到 `VectorStore`。backend 是纯插件。
- `VFS_BACKEND=chroma|sqlite` 环境变量在运行时决定走哪条分支，其余代码零感知。

---

## 一、沙箱作为第一原语 (§1)

### 1.1 为什么沙箱是拦截点，不是"工具"

容器沙箱（Docker/Firecracker）的价值在于**隔离**和**完整 OS 语义**。我们模仿它的两个卖点，但把底层换掉：

| 维度 | 容器沙箱 | vfs4Agent 沙箱 |
|---|---|---|
| 完整 bash 语义 | ✅ 真 bash | ✅ just-bash (AST 级还原) |
| 完整 `/etc` `/proc` | ✅ 真内核 | ✅ realism.ts 伪造 |
| grep/awk/sed 等 | ✅ 真二进制 | ✅ just-bash 内置命令（面向 `IFileSystem`） |
| 真实文件 I/O | ✅ | ❌ 收敛到 `VectorStore` |
| 冷启动延迟 | 秒级～分钟级 | ~100ms |
| 写隔离 | 文件级 | `EROFS` 哨兵 |

**关键**：我们**不是包一层"vfs 工具"给 Agent**，我们是**给 Agent 一个看起来像 Linux 的环境**。Agent 在这个环境里使用标准 UNIX 习惯，我们在环境边界做拦截——这比教 Agent 一套专属 API 更利用预训练知识。

### 1.2 沙箱的六件套（已全部落地）

| 组件 | 文件 | 作用 |
|---|---|---|
| Bash 引擎 | `src/shell.ts` | 持久 `Bash` 实例；baseEnv + customCommands |
| MountableFs | `src/shell.ts` | base=realism fs；mount `/docs` = `VirtualFs` |
| VirtualFs | `src/fs/virtualFs.ts` | just-bash `IFileSystem` → `VectorStore` 桥 |
| Realism layer | `src/runner/realism.ts` | 伪造 `/etc/os-release` `/proc/version` + `uname/whoami/hostname/id` 命令 |
| Grep 拦截 | `src/grep/engine.ts` | 粗筛 (DB `$regex`/FTS) → 精筛 (内存 RegExp) |
| Probe | `src/cli/probe.ts` | 11 条"Agent 会问的环境问题"自动化验证伪装 |

### 1.3 伪装清单 (realism.ts)

沙箱默认把下列路径预填到 base InMemoryFs：

```
/etc/os-release     → Ubuntu 22.04 jammy
/etc/motd           → "Welcome to docs-shell (read-only documentation filesystem)."
/etc/hostname       → docs
/etc/hosts          → 127.0.0.1 localhost / 127.0.1.1 docs
/etc/passwd         → 最小合法条目（root + user:1000）
/proc/version       → Linux 5.15.0-1048-aws ...
/proc/uptime        → 递增模拟值
/proc/cpuinfo       → 4 核 x86_64
```

并注册下列自定义命令（覆盖 bash 默认）：

```
uname [-a|-s|-n|-r|-v|-m|-o]   whoami   hostname   id
```

baseEnv：

```
HOME=/home/user  USER=user  LOGNAME=user  HOSTNAME=docs
SHELL=/bin/bash  TERM=xterm-256color  LANG=C.UTF-8
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PWD=/home/user
```

**验收**：`pnpm probe` 跑 11 条探针，11/11 必须通过。Chroma / SQLite 两个 backend 都测过。

### 1.4 为什么要在**早期**里程碑就做伪装

用户的原话："**实际的沙箱伪装应该在前几个里程碑就实现了**"。理由：

1. 伪装验证沙箱核心抽象是否收敛——如果 `uname` / `ls /etc` / `$HOME` 要各写特殊分支，说明沙箱边界不清晰。
2. Shell-Native 模式**天然需要伪装**——模型会探查环境，一旦出现 `command not found: uname` 就穿帮。
3. Tool 模式也受益——CrewAI / LangChain 的系统提示经常写 "you are on a Linux machine"，伪装让这句话名副其实。

v2.0 把伪装从 "M3+ 打磨" 提到 **M2**（见 §5）。

### 1.5 两个入口，一个沙箱

两种进入沙箱的方式：

| 入口 | 文件 | 调用方 | 协议 |
|---|---|---|---|
| **Shell-Native runner** | `src/runner/shellRunner.ts` + `src/cli/ask.ts` | 进程内直接持有 `Bash`；chat loop 不传 `tools`；MOTD + PS1 伪装 SSH 登录 | OpenAI chat.completions 纯文本 |
| **Tool-mode server** | `src/server.ts` + Fastify `/v1/bash` | CrewAI / LangChain / MCP / function-calling；Agent 知道它在调工具 | HTTP JSON |

**二者共享同一个 `createShell()` 工厂**（`src/shell.ts`）——任何沙箱层面的改动（加命令、改伪装、换 backend）在两个入口同时生效。

v2.0 明确：**两者不是替代关系，是两种使用场景**：
- Shell-Native：单任务、强模型、低延迟、最大程度利用预训练 shell 知识
- Tool-mode：多 Agent 协作、跨语言客户端、需要集中审计/多租户

---

## 二、VectorStore 抽象 (§2)

### 2.1 接口 (src/types.ts)

```ts
export interface VectorStore {
  // PathTree — 目录结构的唯一真相源
  getPathTree(): Promise<PathTree>;
  upsertPathTree(tree: PathTree): Promise<void>;

  // Chunks — 页面内容
  getChunksByPage(slug: string): Promise<Chunk[]>;
  bulkGetChunksByPages(slugs: string[]): Promise<Map<string, Chunk[]>>;
  upsertChunks(chunks: Chunk[]): Promise<void>;
  deleteChunksByPage(slug: string): Promise<void>;

  // Grep 粗筛 — backend 把正则/子串下推到引擎
  searchText(opts: GrepOptions): Promise<string[]>;   // returns candidate slugs

  // 语义搜索 — M4
  searchVector?(vec: number[], topK: number, filter: RbacFilter): Promise<Chunk[]>;

  close(): void;
}
```

### 2.2 三条设计铁律

1. **PathTree 是目录结构的单一真相源**。所有"哪些文件存在""路径前缀下有哪些 slug"的问题都走 in-memory PathTree，**不走** backend 的元数据 `where`。理由：
   - Chroma 元数据 `where` 不支持 `$regex`（只支持 `$in`/`$eq`/`$ne`/`$gt`/…/`$contains`），做路径前缀匹配必须枚举
   - SQLite FTS5 做路径前缀也需要额外索引
   - PathTree 整棵树一个查询就能取回，用 JS 在内存里做前缀匹配是 O(slugs)
2. **grep 两阶段**：粗筛 push down 到 backend（Chroma `$regex` on document content / SQLite FTS5 `MATCH`），精筛在 JS 里用 `new RegExp()` 逐行判。粗筛的 `pathPrefix` 通过 PathTree 解析成 `$in` slug 列表。
3. **RBAC 在 VirtualFs 层做**，不下沉到 backend——backend 只管回答"有什么/像什么"，"你能看什么"是上层的事。

### 2.3 工厂与选择 (`src/backend/factory.ts`)

```ts
createBackend({ backend: "chroma" | "sqlite", chromaUrl?, chromaCollection?, sqlitePath? })
  → { store, kind, label }

// 默认读环境变量：
// VFS_BACKEND=chroma (default)
// CHROMA_URL=http://127.0.0.1:8000
// CHROMA_COLLECTION=vfs
// VFS_DB_PATH=./data/vfs.sqlite
```

`ingest` / `ask` / `probe` / `server` 四个入口全部通过工厂拿 store，**不直接 new 具体 backend**。

---

## 三、Backends (§3)

### 3.1 Chroma — 默认 / 北极星 (`src/backend/chroma.ts`)

完全贴合原博客 ChromaFs：

- 一个 VFS 挂载 = 一个 Chroma collection
- PathTree 存为哨兵文档：`id="__path_tree__"`，`metadatas.tree=JSON.stringify(tree)`
- 每个 chunk 一条记录：`id=${slug}::${chunk_index}`，`metadata={page, chunk_index, line_start}`
- `searchText` 下推：
  - `whereDocument` 使用 `{$regex: pattern}` 或 `{$contains: pattern}`（Chroma 支持在文档内容上做正则）
  - `where` **不能**用 `$regex`（Chroma 元数据只支持 `$in/$eq/...`）→ 把 `pathPrefix` 走 PathTree 解析为 `$in` slug 列表
- Embedding：M2/M3 使用零向量占位 embedder（不做语义检索）；M4 换成真实 embedder

**已知陷阱（已踩过）**：
- `new Key(DOCUMENT_KEY).regex(pattern)` 会多套一层对象触发 Chroma schema 校验失败 → 用原生 `{$regex: pattern}`
- Chroma `$regex` 走 Python `re`，`(?i)` 前缀可实现 case-insensitive

### 3.2 SQLite + FTS5 — 开发期 fallback (`src/backend/sqlite.ts`)

- `pages(slug PRIMARY KEY, meta JSON)` + `chunks(slug, chunk_index, content, line_start)` + `chunks_fts(chunks FTS5)` + `path_tree(id=0, tree TEXT)`
- `searchText` 用 `MATCH` + `GLOB` 做路径前缀
- 单文件、零网络依赖；用于离线跑 probe / 单元测试

### 3.3 未来 backend (§M4+)

pgvector / Qdrant 会新增 `searchVector` 实现；接口不变，`ChromaStore` 之外都属于"扩展插件"。

---

## 四、两个入口的细节 (§4)

### 4.1 Shell-Native (`src/runner/shellRunner.ts`)

```ts
runShellAgent({ question, store, llm, model, maxTurns, maxOutputBytes })
  → { answer, transcript }
```

关键点（已实现）：
1. 单个持久 `Bash` 实例，`cwd`/env/history 跨轮保留
2. 首轮 system 不是 "You are an assistant"，是 MOTD + PS1：
   ```
   Last login: Tue ... from 10.0.0.1
   Welcome to docs-shell (read-only documentation filesystem).
   Type `help` for available commands, `answer "..."` when done.
   user@docs:/docs$
   ```
3. `chat.completions.create({tools: undefined})` — **不传工具 schema**
4. `defineCommand("answer", ...)` 抛 `AnswerSignal`，外层 runner 捕获并退出
5. 每轮 stdout > `maxOutputBytes` 自动截断 + 追加 `... (truncated; use head/tail/grep to narrow)`

### 4.2 Tool-mode (`src/server.ts`)

```
POST /v1/bash    { command }                     → { stdout, stderr, exitCode }
POST /v1/ls      { path }                        → { entries }     (便捷 wrapper)
POST /v1/cat     { path }                        → { content }
POST /v1/grep    { pattern, path, regex, … }     → { matches }
GET  /v1/health                                  → { ok, mount, backend }
```

`health.backend` 会返回 `chroma(http://127.0.0.1:8000 :: vfs_docs)` 这类 label，便于观测运行时选了哪个 backend。

### 4.3 两个入口的共享核心

```ts
// 两处都做同一件事：
const { bash, vfs } = createShell({ store, mountPoint: "/docs", realism: true });
```

改沙箱（加命令、调伪装、换 backend）一次改，两边立刻生效。

---

## 五、里程碑（v2.0 重排）

> **v2.0 排期原则**：先盖沙箱（§1 + §2），再插两个入口（§4），然后补 RBAC/多租户，最后做生产化。伪装提到早期。**ChromaFs（默认 backend）和 Shell-Native 是 M2 的双重验收项**——这两个都通不过，项目的北极星没到达。

| 里程碑 | 状态 | 内容 | 验收 |
|---|---|---|---|
| **M1** 沙箱骨架 + 全 bash 命令集 + SQLite dev backend | ✅ 已完成 | ① just-bash + `VirtualFs implements IFileSystem`（readdir/stat/readFile/写抛 EROFS）<br>② MountableFs：`/docs` 挂 VirtualFs，base 留给未来的 realism fs<br>③ `SqliteFtsStore` + ingest CLI + sample-docs<br>④ `pnpm shell`、`pnpm server`、`pnpm ingest` | `ls cat head tail wc sort uniq cut tr awk sed find grep tree` 全部开箱可用；grep 走粗筛+精筛 |
| **M2** 北极星达成：Chroma + Shell-Native + 伪装 | ✅ 已完成 | ① **`ChromaVectorStore`**（§3.1），成为 `VFS_BACKEND=chroma` 默认<br>② **`realism.ts`**（§1.3）——伪造 `/etc/*` `/proc/*` + uname/whoami/hostname/id<br>③ **`shellRunner.ts` + `ask.ts`**（§4.1）——Shell-Native 入口<br>④ **`probe.ts`** 11 条探针——伪装自动化验收<br>⑤ backend factory（§2.3）+ 四个入口全部通过工厂<br>⑥ 两个 demo 对比：`pnpm ask` vs `examples/crewai-qwen-demo/agent.py` 同题跑 | ✅ 11/11 probe 双 backend 通过；✅ Shell-Native 4 turns 答 OAuth 带双引用；✅ CrewAI on Chroma 同题正确作答 |
| **M3** RBAC + MCP + OpenAI Tool 适配 | ⏳ 下一步 | ① `Session { userId, groups }` + PathTree pruning + 查询层 filter<br>② MCP server（stdio）——Claude Code/Cursor 直连<br>③ OpenAI function-calling adapter（同 schema，不同 transport）<br>④ 错误语义打磨（ENOENT vs EACCES vs EROFS）<br>⑤ **RBAC 探针加入 probe**——无权用户 `ls /internal` 必须空 | 无权用户所有命令组合都看不到屏蔽路径；Claude Code 挂 MCP 能跑同一个 OAuth 问题 |
| **M4** 语义搜索 + 懒加载 + 更多 backend | 规划 | ① `searchVector` 在 Chroma backend 落地 + 真实 embedder（DashScope `text-embedding-v3`）<br>② `defineCommand("search", ...)` —— 自定义 bash 命令做语义检索<br>③ `LazyPointer`：S3/HTTP 大文件懒加载<br>④ `pgvector` / `Qdrant` backend（验证抽象足够稳） | "search" 返回 topK + 引用；S3 上 100MB PDF 冷启动 < 500ms |
| **M5** 生产化 | 规划 | ① Redis cache / LRU 策略<br>② PathTree 增量更新（webhook/CDC）<br>③ 指标（启动/grep/cat/cache hit/token 用量对比）<br>④ `docker-compose up` 一键<br>⑤ benchmark：vs 容器沙箱的 46s 冷启动 | 单容器 QPS；全链路 p95 延迟表 |

### 5.1 M1→M2 变化总结

v1.2 里 M2 是 "grep 优化 + AI SDK + CrewAI E2E"，默认 backend 还是 SQLite。v2.0 M2 的北极星改成：
1. **Chroma 是默认** —— `VFS_BACKEND=chroma` 省掉即是 Chroma
2. **Shell-Native 是沙箱第一等公民** —— 不是 v1.2 里 "M2.5" 补丁，而是 M2 的核心验收项之一
3. **伪装是早期能力** —— realism.ts 在 M2 落地，不等 M3/M5

M1/M2 都已完成；v2.0 的真正工作起点是 M3。

---

## 六、关键实现注意点

1. **"能用 just-bash 内置的就不要自己写"**：awk/sed/sort/uniq/head/tail/wc/xargs 都已经是用 TS 重实现并走 `IFileSystem` 的。**唯一值得拦截的是 grep**（性能）和 **`uname`/`whoami`/`hostname`/`id`**（伪装）以及写操作（EROFS）。
2. **Chroma 元数据 `where` 不支持 `$regex`**——这是我们踩过的坑。所有涉及 `page` 字段的过滤必须通过 PathTree 解析成 `$in` 列表。
3. **PathTree 是目录结构的单一真相源**——所有结构查询（ls / find / 路径前缀）都不查 backend 的元数据，走内存 tree。
4. **Chunk 切分不按固定 token**——按 Markdown 段落/heading；ingest 时记录每个 chunk 的起始行号，精筛阶段拼页后再打行号，避免跨 chunk 命中时漏行号。
5. **只读即无状态**——所有对 `/docs` 的写操作抛 `EROFS`；`/home/user` 和 `/tmp` 走 base InMemoryFs 可写 scratch。
6. **两个入口改一处**——改沙箱只改 `src/shell.ts`；改 backend 只改 `src/backend/*`；改伪装只改 `src/runner/realism.ts`。任何"要同时在 shellRunner 和 server.ts 两边加代码"的需求，十有八九是抽象漏了。
7. **伪装的验收永远用 probe**——不是靠"跑一下看看"。加命令就加探针，加探针就跑 `pnpm probe`。
8. **BRE vs ERE 语义**：grep 默认是 BRE，`\|` 才是 alternation；LLM 经常写 `'foo\|bar'`。我们的 grep 拦截器当前把这种模式当 JS RegExp 处理，`\|` 变成字面量 `|`——跟真 grep 默认 BRE 一致（非 `-E` 时 `|` 是字面量）。真 grep 用户写 `grep 'foo\|bar'` 同样匹配不到。这是预期行为，不是 bug；若模型反馈 exit 1，会自然回退到 `-E` 或直接读文件。
9. **Embedding 一致性**（M4 起）：ingest 和 query 必须同 `EMBED_MODEL`/同维度，跨模型迁移需全量 re-embed。
10. **Chroma server 起法**：`chroma run --path ./data/chroma --port 8000`；连接串由 `CHROMA_URL` 覆盖；`client.getMaxBatchSize()` 要尊重（upsert 大批量时分片）。

---

## 七、下一步行动

1. **M3 RBAC**：`Session` 挂到 `createShell()` 参数 → PathTree pruning → grep/cat 过滤；probe 加"无权探针"
2. **M3 MCP adapter**：`packages/adapter-mcp/`，stdio JSON-RPC；跑 Claude Code 接同一个沙箱
3. **M3 OpenAI function-calling adapter**：对外 schema 跟 Fastify server 对齐（只是换 transport）
4. **M4 `searchVector`**：Chroma 真 embedder + `defineCommand("search", ...)`
5. **M5 生产化**：benchmarks + docker-compose + Redis

---

*Document version: v2.0 — 2026-04-23*  
*v2.0 changelog: 按 sandbox-first 框架重构。沙箱升为第一原语 (§1)，VectorStore 为单一抽象层 (§2)，Chroma 为默认后端 (§3)，Tool 与 Shell-Native 降为两个入口 (§4)。realism layer 从 v1.2 的 M3+ 提前到 M2。Chroma `$regex on metadata` 陷阱纳入"关键实现注意点"。生产化明确为 M5 专项。v1.2 备份保留为 `IMPLEMENTATION_PLAN.v1.2.bak.md`。*
