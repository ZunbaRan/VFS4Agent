# vfs4Agent FUSE 重构开发文档

> **目标**：将 vfs4Agent 从 just-bash 模拟器方案重构为基于 FUSE 的虚拟文件系统方案。
> **执行者**：Claude Code 或其他 AI 编程 Agent。
> **最后更新**：2026-04-23

---

## 目录

1. [项目背景与重构动机](#1-项目背景与重构动机)
2. [参考项目分析](#2-参考项目分析)
3. [保留与删除的代码清单](#3-保留与删除的代码清单)
4. [目标架构](#4-目标架构)
5. [依赖项](#5-依赖项)
6. [开发步骤（按执行顺序）](#6-开发步骤按执行顺序)
7. [FUSE 操作详细设计](#7-fuse-操作详细设计)
8. [虚拟搜索目录设计](#8-虚拟搜索目录设计)
9. [容器化与 Docker 配置](#9-容器化与-docker-配置)
10. [Agent SDK 适配层设计](#10-agent-sdk-适配层设计)
11. [验收标准与测试](#11-验收标准与测试)
12. [已知风险与注意事项](#12-已知风险与注意事项)

---

## 1. 项目背景与重构动机

### 1.1 vfs4Agent 是什么

vfs4Agent 是一个为 LLM Agent 提供的只读文档访问层。Agent 以为自己 SSH 到了一台 Linux 机器，可以用 `ls`、`cat`、`grep`、`find` 等标准 bash 命令浏览挂在 `/docs` 下的文档。底层不是真正的文件系统，而是向量数据库（Chroma 或 SQLite）。

### 1.2 当前方案（just-bash 模拟器）的问题

当前方案使用 `just-bash`（一个纯 JS bash 模拟器）来实现 shell 环境：

```
Agent 回复文本 → extractCommand() → just-bash (JS 模拟器)
                                      → VirtualFs (IFileSystem 接口)
                                        → VectorStore (Chroma/SQLite)
```

**核心问题**：
- just-bash 只支持内置命令，不支持真正的 `grep -r`、`find -exec`、管道、`awk`、`sed` 等
- 需要自己实现 grep 引擎（两阶段匹配）、tree 命令等
- Agent 框架（LangGraph、Anthropic SDK、CrewAI 等）都有原生的 Bash tool，能调真正的 subprocess，但它们无法直接使用 just-bash 模拟器
- 模拟器与真实 bash 的行为差异会导致 Agent 困惑

### 1.3 FUSE 方案的优势

FUSE（Filesystem in Userspace）允许在用户态实现一个文件系统，挂载到真实路径上。操作系统负责把 `ls /docs`、`cat /docs/guide.md`、`grep -r "auth" /docs` 翻译成 FUSE 回调函数调用。

```
Agent Bash tool (真正的 subprocess)
  → ls /docs/
  → cat /docs/guide.md
  → grep -r "auth" /docs/
    ↓
Linux 内核 VFS
    ↓
FUSE 用户态进程 (fuse-native, TypeScript)
    ↓
VectorStore (Chroma/SQLite)
```

**优势**：
- 所有 bash 命令都是真实的（`grep -r`、`find -name -exec`、管道、`awk`、`sed`）
- 不需要实现 bash 模拟器、grep 引擎、tree 命令
- 只需实现 6-10 个 FUSE 回调函数（`readdir`、`read`、`getattr`、`open`、`mkdir`、`unlink` 等）
- 任何能调 bash 的 Agent 框架都能直接使用，无需适配

### 1.4 重构原则

1. **保留** VectorStore 抽象层、数据导入管道、HTTP 桥（作为 FUSE 之外的备选入口）
2. **删除** just-bash 模拟器相关的所有代码
3. **新增** FUSE 层、容器化配置、Agent SDK 适配层
4. **一次 commit** 完成转向，git 历史连续

---

## 2. 参考项目分析

### 2.1 agent-fuse（Jakob Emmerling）

- **仓库**：https://github.com/Jakob-em/agent-fuse
- **博客**：https://jakobemmerling.de/posts/fuse-is-all-you-need/
- **技术栈**：TypeScript + fuse-native + PGlite + Anthropic Agent SDK
- **场景**：将邮件数据库暴露为文件系统，Agent 用真实 bash 命令管理邮件

**关键架构**：

```
main.ts
  ├── initDb()              → 初始化 PGlite 内存数据库
  ├── mount("/workspace")   → fuse-native 挂载 FUSE 文件系统
  └── startRepl()           → Anthropic Agent SDK REPL，Agent 调 Bash tool

fuse/ops/
  ├── getattr.ts            → 返回文件/目录元信息
  ├── open.ts               → 打开文件，返回 email.id 作为 fd
  ├── read.ts               → 按 fd 查数据库，返回文件内容切片
  ├── readdir.ts            → 查数据库返回目录列表
  ├── mkdir.ts              → 在数据库建目录
  ├── rename.ts             → 移动邮件到新目录
  ├── symlink.ts            → 创建"星标"软链
  ├── unlink.ts             → 删除星标
  └── readlink.ts           → 解析软链
```

**核心洞察**：
- FUSE `open()` 返回数据库记录 ID 作为文件描述符（fd）
- FUSE `read()` 用 fd 查数据库，按需返回内容切片
- `readdir()` 直接查数据库构建目录列表
- Agent 用的是真实的 `/bin/bash`、`/bin/grep`、`/usr/bin/find`

**已下载的参考文件**（在 `docs/` 目录下）：
- `agent-fuse-index.ts.txt` — FUSE mount 入口
- `agent-fuse-readdir.ts.txt` — 目录读取实现
- `agent-fuse-read.ts.txt` — 文件读取实现
- `agent-fuse-getattr.ts.txt` — 文件属性实现
- `agent-fuse-open.ts.txt` — 文件打开实现
- `agent-fuse-mkdir.ts.txt` — 创建目录实现
- `agent-fuse-rename.ts.txt` — 移动/重命名实现
- `agent-fuse-symlink.ts.txt` — 软链创建实现
- `agent-fuse-unlink.ts.txt` — 删除实现
- `agent-fuse-readlink.ts.txt` — 软链解析实现
- `agent-fuse-main.ts.txt` — 程序入口
- `agent-fuse-agent.ts.txt` — Anthropic SDK 集成
- `agent-fuse-Dockerfile.txt` — Docker 配置
- `agent-fuse-package.json.txt` — 依赖配置
- `fuse-is-all-you-need.md` — 博客文章

### 2.2 ToolFS（IceWhaleTech）

- **仓库**：https://github.com/IceWhaleTech/ToolFS
- **技术栈**：Go + go-fuse + Docker 容器
- **场景**：为 AI Agent 提供标准虚拟文件系统

**关键架构**：
- 使用 `go-fuse` 在操作系统层面挂载虚拟文件系统
- 提供 RAG 搜索入口：`cat /mnt/toolfs/rag/query?text=xxx`
- 提供记忆存储：`echo "hello" > /mnt/toolfs/memory/last_query`
- 提供 Skills 系统：将 Agent 工具调用伪装为文件操作

**对我们的启示**：
- 虚拟搜索目录的设计思路（将语义搜索伪装为文件读取）
- 将各种 Agent 能力统一为文件操作的理念

**已下载的参考文件**：
- `toolfs-core.go.txt` — 核心文件系统实现
- `toolfs-fuse.go.txt` — FUSE 适配器
- `toolfs-sandbox.go.txt` — 沙箱配置
- `toolfs-skills.go.txt` — 技能注册与管理
- `toolfs-skill_api.go.txt` — 技能 API
- `toolfs-builtin_skills.go.txt` — 内置技能（RAG、记忆）

### 2.3 VKFS（ZeroZ-lab）

- **仓库**：https://github.com/ZeroZ-lab/vkfs
- **技术栈**：Go + sqlite-vec + Zilliz/Milvus
- **场景**：Unix-like 文件系统命令覆盖向量数据库，专为 AI Agent 设计

**关键架构**：
- VectorStore 是单一数据源（PathTree + chunks），与 vfs4Agent 同构
- **多后端可插拔**：SQLite（本地零依赖）和 Zilliz/Milvus（云端分布式）是**平级选项**，用户按需选择
- SQLite 后端：用 `sqlite-vec` 扩展存储向量，纯 Go 实现 L2 暴力搜索
- 可插拔嵌入模型（OpenAI、Ollama 等）
- 两阶段 grep（BM25 粗筛 + 正则精筛），与 vfs4Agent 设计一致

**对我们的启示**：
- **SQLite 不是 fallback，是一等公民后端**。适合本地开发、单用户、离线场景、零外部依赖部署
- Chroma 和 SQLite 应作为**两个默认支持的后端**，通过 `VectorStore` 接口统一抽象
- 未来可扩展更多后端（Qdrant、Weaviate 等），用户自行选择
- 参考 VKFS 的 `VectorStore` 接口设计（`Search`、`StoreChunks`、`GetPathTree`、`GetChunks`）

**已下载的参考文件**：
- `vkfs-store.go.txt` — VectorStore 接口定义
- `vkfs-sqlite.go.txt` — SQLite 后端实现（向量存储 + L2 搜索）
- `vkfs-zilliz.go.txt` — Zilliz 后端实现
- `vkfs-factory.go.txt` — 后端工厂选择器
- `vkfs-types.go.txt` — Chunk/PathTree 类型定义
- `vkfs-README.md` — 项目说明

---

## 3. 保留与删除的代码清单

### 3.1 保留的代码（FUSE 方案仍然需要）

| 文件 | 保留原因 | 需要改动？ |
|---|---|---|
| `src/types.ts` | PathTree、Chunk、VectorStore 接口定义 | 可能需要小改（添加 FUSE 相关类型） |
| `src/backend/factory.ts` | 后端工厂，根据 VFS_BACKEND 环境变量创建对应的 VectorStore 实例 | 否 |
| `src/backend/chroma.ts` | ChromaVectorStore 实现（向量索引后端，支持嵌入或 HTTP 模式） | 否 |
| `src/backend/sqlite.ts` | SqliteVectorStore 实现（本地零依赖后端，参考 VKFS 架构） | 否 |
| `src/ingest.ts` | 数据导入管道，将目录分块写入向量库 | 否 |
| `src/server.ts` | HTTP 桥，作为 FUSE 之外的备选入口 | 需要大幅简化（去掉 createShell 依赖） |
| `src/cli/ingest.ts` | 导入命令行入口 | 否 |
| `package.json` | 依赖管理 | 需要更新依赖 |
| `tsconfig.json` | TypeScript 配置 | 否 |
| `DEVELOPER_HANDOFF.md` | 开发者文档 | 需要更新 |
| `IMPLEMENTATION_PLAN.md` | 实施计划 | 需要更新 |

### 3.2 删除的代码（模拟器层核心）

| 文件/目录 | 删除原因 |
|---|---|
| `src/shell.ts` | 创建 just-bash 实例，FUSE 不需要 |
| `src/fs/` 整个目录 | VirtualFs、InMemoryFs、MountableFs → FUSE 有自己的接口 |
| `src/grep/engine.ts` | 两阶段 grep 引擎 → 真实的 `/bin/grep` 替代 |
| `src/runner/shellRunner.ts` | 文本提取命令循环 → 被真实的 Agent Bash tool 替代 |
| `src/runner/realism.ts` | 沙箱伪装层 → FUSE 运行在容器中，有真实系统环境 |
| `src/cli/shell.ts` | 交互式 shell CLI → 被 Agent SDK REPL 替代 |
| `src/cli/ask.ts` | Shell-Native QA CLI → 需要重写为 FUSE 模式 |
| `src/cli/probe.ts` | 11 条探针测试 → 需要重写为 FUSE 测试 |
| `examples/crewai-qwen-demo/` | 基于 HTTP 的外部框架 demo → 保留但需要更新 |

### 3.3 新增的代码

| 文件/目录 | 说明 |
|---|---|
| `src/fuse/index.ts` | FUSE mount 入口 |
| `src/fuse/ops/index.ts` | FUSE 操作注册 |
| `src/fuse/ops/getattr.ts` | 获取文件/目录属性 |
| `src/fuse/ops/open.ts` | 打开文件 |
| `src/fuse/ops/read.ts` | 读取文件内容 |
| `src/fuse/ops/readdir.ts` | 读取目录列表 |
| `src/fuse/ops/mkdir.ts` | 创建目录（可选） |
| `src/fuse/ops/rename.ts` | 重命名（可选） |
| `src/fuse/ops/unlink.ts` | 删除文件（可选） |
| `src/fuse/ops/write.ts` | 写入文件（用于 /search/last_query） |
| `src/fuse/helpers.ts` | FUSE 辅助函数（路径解析、文件名映射等） |
| `src/fuse/search.ts` | 虚拟搜索目录逻辑 |
| `src/agent/main.ts` | Agent 入口（FUSE mount + Agent SDK REPL） |
| `src/agent/adapters/` | Agent 框架适配层 |
| `Dockerfile` | 容器化配置 |
| `docker-compose.yml` | 容器编排 |
| `docs/` | 参考文档目录（已创建） |

---

## 4. 目标架构

### 4.1 整体分层

```
┌──────────────────────────────────────────────────────────────┐
│  Agent 的视角：一台运行 Ubuntu 的 Linux 容器                  │
│  $ ls /docs/        → api/  auth/  guides/                   │
│  $ cat /docs/a.md   → 文件内容                                │
│  $ grep -r "auth" /docs/ → 真实 grep，内核通过 FUSE 读取文件   │
│  $ cat /search/results/* → 语义搜索结果（虚拟目录）            │
└──────────────────────────┬───────────────────────────────────┘
                           │ 真实的 /bin/bash subprocess
                           │ Anthropic SDK / OpenAI SDK / MCP
                           │ 的 Bash tool
┌──────────────────────────┴───────────────────────────────────┐
│  Linux 内核 VFS                                               │
│  将路径操作翻译为 FUSE 回调                                   │
└──────────────────────────┬───────────────────────────────────┘
                           │ FUSE 协议
┌──────────────────────────┴───────────────────────────────────┐
│  §1 FUSE 层 (src/fuse/)                                      │
│  ├── mount("/docs")    → fuse-native 挂载点                  │
│  ├── getattr(path)     → 查 PathTree / chunks 返回文件属性    │
│  ├── open(path)        → 查文件是否存在，返回 chunk 引用 ID     │
│  ├── read(path, fd, buf, len, pos) → 拼接 chunks 返回内容切片 │
│  ├── readdir(path)     → 查 PathTree 返回目录列表             │
│  ├── write(path, ...)  → /search/last_query 写入触发搜索      │
│  └── mkdir(path)       → 在 PathTree 建目录（可选）           │
└──────────────────────────┬───────────────────────────────────┘
                           │ VectorStore interface
                           │ (单一抽象层，backend 可换)
┌──────────────────────────┴───────────────────────────────────┐
│  §2 VectorStore 抽象 (src/types.ts)                          │
│  ├── getPathTree() / upsertPathTree()                        │
│  ├── getChunksByPage() / bulkGetChunksByPages()              │
│  ├── searchText()                                            │
│  └── close()                                                 │
└──────────────────────────┬───────────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
┌──────────────────┐               ┌──────────────────┐
│ ChromaVectorStore │               │ SqliteVectorStore │
│ (向量索引后端)     │               │ (本地零依赖后端)   │
└──────────────────┘               └──────────────────┘
```

### 4.2 多后端可插拔架构

vfs4Agent 的 VectorStore 是一个**抽象接口**，支持多种后端实现。Chroma 和 SQLite 是**两个默认支持的后端**，地位完全平等，用户根据场景自行选择：

| 后端 | 适用场景 | 部署方式 | 特点 |
|---|---|---|---|
| **Chroma** | 需要向量索引、多集合管理 | 嵌入式（默认）或轻量 HTTP 服务 | 内置 HNSW 索引、API 丰富、生态完善 |
| **SQLite** | 本地开发、单用户、离线、零外部依赖 | 完全嵌入式（同一进程） | 零安装、单文件数据库、`sqlite-vec` 扩展 |

两者都是**本地轻量级数据库**，区别在于：
- Chroma 原生支持向量索引（HNSW），适合向量搜索场景
- SQLite 通过 `sqlite-vec` 扩展支持向量搜索，优势是零外部依赖
- 通过 `VFS_BACKEND` 环境变量切换：
```bash
VFS_BACKEND=chroma   # 使用 Chroma（默认）
VFS_BACKEND=sqlite   # 使用 SQLite
```

后端工厂（`src/backend/factory.ts`）根据环境变量创建对应的 VectorStore 实例。FUSE 层只依赖 `VectorStore` 接口，不关心底层实现。

**未来扩展**：参考 VKFS 的多后端设计，可以逐步支持 Qdrant、Weaviate、Milvus 等更多向量数据库，只需实现 `VectorStore` 接口即可接入。

### 4.3 与旧架构的对比

| 维度 | 旧架构 (just-bash) | 新架构 (FUSE) |
|---|---|---|
| Shell 引擎 | just-bash (JS 模拟器) | 真实 /bin/bash |
| 命令支持 | 有限的内置命令 | 所有标准 Linux 命令 |
| grep | 自实现两阶段匹配 | 真实 grep，内核通过 FUSE 读文件 |
| 拦截点 | extractCommand() 文本提取 | FUSE 回调函数 |
| Agent 集成 | HTTP 桥或文本循环 | 任何框架的 Bash tool |
| 部署 | 任何 Node.js 环境 | Docker 容器（需要 FUSE 内核支持） |
| 代码复杂度 | 高（模拟 bash + 自定义命令） | 低（6-10 个 FUSE 回调） |

---

## 5. 依赖项

### 5.1 新增依赖

| 包名 | 版本 | 用途 |
|---|---|---|
| `fuse-native` | ^2.2.6 | Node.js FUSE 实现（核心） |

### 5.2 保留依赖

| 包名 | 版本 | 用途 |
|---|---|---|
| `better-sqlite3` | ^11.7.0 | SQLite VectorStore |
| `chromadb` | ^3.4.3 | Chroma VectorStore |
| `fastify` | ^5.2.0 | HTTP 桥（可选保留） |
| `@fastify/cors` | ^10.0.1 | HTTP 桥 CORS |
| `openai` | ^6.34.0 | Agent SDK（OpenAI 兼容） |
| `dotenv` | ^17.4.2 | 环境变量 |
| `lru-cache` | ^11.0.2 | 文件内容缓存 |

### 5.3 删除依赖

| 包名 | 删除原因 |
|---|---|
| `just-bash` | bash 模拟器，不再需要 |
| `yargs-parser` | CLI 参数解析，简化后不需要 |
| `zod` | 参数校验，FUSE 层不需要 |
| `@xenova/transformers` | 本地 embedder，M4 前不需要 |
| `@chroma-core/default-embed` | 本地 embedder |
| `chromadb-default-embed` | 本地 embedder |

### 5.4 可选新增依赖（Agent 适配层）

| 包名 | 版本 | 用途 | 优先级 |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | ^0.2.4 | Anthropic Agent SDK + Bash tool | P1 |

### 5.5 系统依赖（Docker 容器内）

| 包名 | 用途 |
|---|---|
| `fuse` | FUSE 内核模块 |
| `libfuse2` | FUSE 2 运行库 |
| `libfuse-dev` | FUSE 开发头文件 |

---

## 6. 开发步骤（按执行顺序）

### 步骤 0：清理旧代码

```bash
# 删除模拟器层核心代码
rm -f src/shell.ts
rm -rf src/fs/
rm -f src/grep/engine.ts
rm -f src/runner/shellRunner.ts
rm -f src/runner/realism.ts
rm -f src/cli/shell.ts
rm -f src/cli/probe.ts

# 注意：src/cli/ask.ts 保留但需要重写
# src/server.ts 保留但需要简化
```

### 步骤 1：安装新依赖

```bash
pnpm add fuse-native
pnpm approve-builds fuse-native || true
```

更新 `package.json`：
- 移除 `just-bash`、`yargs-parser`、`zod`、`@xenova/transformers`、`@chroma-core/default-embed`、`chromadb-default-embed`
- 添加 `fuse-native`
- 更新 scripts：移除 `test:m1`，添加 `start`、`docker:build`、`docker:run`

### 步骤 2：创建 FUSE 骨架

创建 `src/fuse/` 目录结构：

```
src/fuse/
  ├── index.ts          → mount() 入口
  ├── helpers.ts        → 路径解析、文件名映射、chunk 拼接
  ├── search.ts         → 虚拟搜索目录逻辑
  └── ops/
      ├── index.ts      → 注册所有 FUSE 操作
      ├── getattr.ts    → 文件/目录属性
      ├── open.ts       → 打开文件
      ├── read.ts       → 读取文件
      ├── readdir.ts    → 读取目录
      ├── write.ts      → 写入文件（/search/last_query）
      ├── mkdir.ts      → 创建目录（可选）
      └── release.ts    → 关闭文件描述符（可选）
```

### 步骤 3：实现 FUSE 操作（详细设计见第 7 节）

每个 FUSE 操作的核心逻辑：

1. **`getattr(path, cb)`**：
   - 如果是目录（PathTree 中有对应条目或虚拟目录）→ 返回 `{ mode: 0o40755, size: 4096, mtime, atime, ctime }`
   - 如果是文件（PathTree 中有对应条目）→ 查 chunks 计算总大小 → 返回 `{ mode: 0o100644, size, mtime, uid, gid, nlink: 1 }`
   - 如果不存在 → 返回 `cb(Fuse.ENOENT)`

2. **`open(path, flags, cb)`**：
   - 查 PathTree 确认文件存在
   - 从 VectorStore 获取该文件的所有 chunks
   - 拼接完整内容，缓存到内存
   - 返回一个唯一的 fd（可以用自增整数或 chunks 的哈希）
   - `cb(0, fd)`

3. **`read(path, fd, buf, len, pos, cb)`**：
   - 用 fd 查找缓存的完整文件内容
   - `slice = content.slice(pos, pos + len)`
   - `bytesRead = buf.write(slice)`
   - `cb(bytesRead)`

4. **`readdir(path, cb)`**：
   - 从 PathTree 中找出该目录下的直接子项
   - 对虚拟目录（如 `/search`）返回硬编码的子目录列表
   - `cb(0, entries)`

5. **`write(path, fd, buf, len, pos, cb)`**（仅用于 `/search/last_query`）：
   - 写入内容到缓冲区
   - 当文件关闭时（release），读取内容触发语义搜索
   - 生成 `/search/results/` 下的虚拟文件

### 步骤 4：实现 helpers.ts

关键辅助函数：

```typescript
// 路径解析：将 FUSE 路径（如 "/docs/auth/login.md"）转为 VectorStore slug（如 "docs/auth/login.md"）
export function fusePathToSlug(path: string, mountPoint: string): string;

// 判断路径是文件还是目录
export async function isDirectory(path: string, tree: PathTree): Promise<boolean>;

// 从 PathTree 获取目录下的直接子项
export function getDirectoryEntries(path: string, tree: PathTree): string[];

// 将 chunks 拼接为完整文件内容
export function assembleChunks(chunks: Chunk[]): string;

// 文件名映射（保持与 slug 一致，不需要特殊转换）
export function slugToFilename(slug: string): string;
```

### 步骤 5：实现虚拟搜索目录（详细设计见第 8 节）

创建 `src/fuse/search.ts`：

```typescript
export interface SearchState {
  lastQuery: string;
  results: SearchResult[];
}

export interface SearchResult {
  slug: string;
  content: string;
  score: number;
}

// 当 /search/last_query 被写入时调用
export async function triggerSearch(query: string, store: VectorStore): Promise<void>;

// 获取搜索结果文件内容
export function getSearchResultContent(index: number): string;
```

### 步骤 6：创建入口 main.ts

创建 `src/agent/main.ts`：

```typescript
import { mount } from "../fuse/index.js";
import { createBackend } from "../backend/factory.js";
import { startRepl } from "./repl.js";

const { store } = createBackend();

await mount("/docs", { store });
console.log("FUSE mounted at /docs");

await startRepl();
```

### 步骤 7：创建 Agent REPL（基于 OpenAI SDK）

创建 `src/agent/repl.ts`：

```typescript
// 类似 agent-fuse 的 REPL，但使用 OpenAI 兼容 SDK
// 因为我们要支持 Qwen/DashScope
```

### 步骤 8：创建 Dockerfile 和 docker-compose.yml

### 步骤 9：重写 src/cli/ask.ts

改为 FUSE 模式：先 mount FUSE，然后用 OpenAI SDK 的 function calling 或文本循环。

### 步骤 10：简化 src/server.ts

移除 `createShell` 依赖，直接操作 VectorStore 或 FUSE 层。

### 步骤 11：更新文档

- 更新 `DEVELOPER_HANDOFF.md`
- 更新 `IMPLEMENTATION_PLAN.md`

---

## 7. FUSE 操作详细设计

### 7.1 挂载架构

vfs4Agent 使用 **两个挂载点**：

```
/docs/          ← VectorStore 挂载（只读，核心功能）
/search/        ← 虚拟搜索目录（读写，语义搜索入口）
```

有两种实现方式：
- **方案 A**：单个 FUSE 挂载到 `/`，内部路由到不同逻辑
- **方案 B**：分别挂载 `/docs` 和 `/search`

推荐 **方案 A**，挂载到 `/vfs`，然后在容器内通过 `ln -s` 创建 `/docs → /vfs/docs` 和 `/search → /vfs/search`。

### 7.2 getattr 详细设计

```typescript
import Fuse from "fuse-native";
import type { VectorStore, PathTree } from "../../types.js";

export async function getattr(
  path: string,
  store: VectorStore,
  mountPoint: string,
  cb: (err: number, stat?: any) => void,
) {
  const tree = await store.getPathTree();
  const slug = fusePathToSlug(path, mountPoint);

  // 1. 检查是否是虚拟目录
  if (isVirtualDirectory(path)) {
    return cb(0, {
      mtime: new Date(),
      atime: new Date(),
      ctime: new Date(),
      size: 4096,
      mode: 0o40755,
      uid: process.getuid(),
      gid: process.getgid(),
      nlink: 2,
    });
  }

  // 2. 检查 PathTree 中是否有该路径对应的目录
  if (isDirectoryInTree(slug, tree)) {
    return cb(0, {
      mtime: new Date(),
      atime: new Date(),
      ctime: new Date(),
      size: 4096,
      mode: 0o40755,
      uid: process.getuid(),
      gid: process.getgid(),
      nlink: 2,
    });
  }

  // 3. 检查是否是文件
  const entry = tree[slug];
  if (entry) {
    // 从 PathTreeEntry 获取 size 和 mtime
    return cb(0, {
      mtime: entry.mtime ? new Date(entry.mtime) : new Date(),
      atime: entry.mtime ? new Date(entry.mtime) : new Date(),
      ctime: entry.mtime ? new Date(entry.mtime) : new Date(),
      size: entry.size ?? 0,
      mode: 0o100644,
      uid: process.getuid(),
      gid: process.getgid(),
      nlink: 1,
    });
  }

  // 4. 特殊文件：/search/last_query, /search/results/*
  if (isSearchPath(path)) {
    return getSearchFileAttr(path, cb);
  }

  // 5. 不存在
  cb(Fuse.ENOENT);
}
```

### 7.3 open 详细设计

```typescript
import Fuse from "fuse-native";
import type { VectorStore } from "../../types.js";

// 全局 fd → 内容缓存
// 注意：生产环境应该用 LRU 缓存并设置上限
const fdCache = new Map<number, string>();
let nextFd = 1;

export async function open(
  path: string,
  flags: number,
  store: VectorStore,
  mountPoint: string,
  cb: (err: number, fd?: number) => void,
) {
  const slug = fusePathToSlug(path, mountPoint);
  const tree = await store.getPathTree();

  // 检查文件是否存在
  if (!tree[slug]) {
    // 检查是否是搜索路径
    if (path === "/search/last_query") {
      const fd = nextFd++;
      fdCache.set(fd, ""); // 空文件
      return cb(0, fd);
    }
    if (path.startsWith("/search/results/")) {
      const fd = nextFd++;
      const content = getSearchResultFileContent(path);
      fdCache.set(fd, content);
      return cb(0, fd);
    }
    return cb(Fuse.ENOENT);
  }

  // 获取所有 chunks 并拼接
  const chunks = await store.getChunksByPage(slug);
  const content = assembleChunks(chunks);

  const fd = nextFd++;
  fdCache.set(fd, content);
  cb(0, fd);
}
```

### 7.4 read 详细设计

```typescript
export async function read(
  path: string,
  fd: number,
  buf: Buffer,
  len: number,
  pos: number,
  cb: (err: number) => void,
) {
  const content = fdCache.get(fd);
  if (content === undefined) {
    return cb(Fuse.EBADF); // 无效文件描述符
  }

  const slice = content.slice(pos, pos + len);
  const bytesRead = buf.write(slice);
  cb(bytesRead);
}
```

### 7.5 readdir 详细设计

```typescript
import Fuse from "fuse-native";
import type { VectorStore, PathTree } from "../../types.js";

export async function readdir(
  path: string,
  store: VectorStore,
  mountPoint: string,
  cb: (err: number, names?: string[]) => void,
) {
  const tree = await store.getPathTree();
  const slug = fusePathToSlug(path, mountPoint);

  // 根目录特殊处理
  if (path === "/") {
    const entries = new Set<string>();
    // 添加 docs 根目录下的直接子目录
    for (const key of Object.keys(tree)) {
      const parts = key.split("/");
      entries.add(parts[0]);
    }
    // 添加虚拟目录
    entries.add("search");
    cb(0, Array.from(entries));
    return;
  }

  // 虚拟搜索目录
  if (path === "/search") {
    return cb(0, ["last_query", "results"]);
  }
  if (path === "/search/results") {
    return cb(0, getSearchResultFilenames());
  }

  // 普通目录：从 PathTree 中提取直接子项
  const prefix = slug === "" ? "" : slug + "/";
  const entries = new Set<string>();

  for (const key of Object.keys(tree)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const firstPart = rest.split("/")[0];
    if (firstPart) entries.add(firstPart);
  }

  if (entries.size === 0 && !isDirectoryInTree(slug, tree)) {
    return cb(Fuse.ENOENT);
  }

  cb(0, Array.from(entries));
}
```

### 7.6 write 详细设计（仅 /search/last_query）

```typescript
// 全局搜索状态
let searchState: { query: string; results: any[] } = { query: "", results: [] };

export async function write(
  path: string,
  fd: number,
  buf: Buffer,
  len: number,
  pos: number,
  cb: (err: number) => void,
) {
  if (path !== "/search/last_query") {
    return cb(Fuse.EROFS); // 只读文件系统
  }

  const existing = fdCache.get(fd) ?? "";
  const newData = buf.slice(0, len).toString("utf8");
  const updated = existing.slice(0, pos) + newData + existing.slice(pos + len);
  fdCache.set(fd, updated);
  cb(len);
}

// 在 release（关闭文件描述符）时触发搜索
export async function release(
  path: string,
  fd: number,
  store: VectorStore,
  cb: (err: number) => void,
) {
  if (path === "/search/last_query") {
    const query = fdCache.get(fd)?.trim() ?? "";
    if (query && query !== searchState.query) {
      searchState.query = query;
      // 执行语义搜索（M4 时用真实 embedder，M3 用 searchText 做关键词匹配）
      const slugs = await store.searchText({ pattern: query, limit: 10 });
      searchState.results = [];
      for (const slug of slugs) {
        const chunks = await store.getChunksByPage(slug);
        searchState.results.push({ slug, content: assembleChunks(chunks) });
      }
    }
  }
  fdCache.delete(fd);
  cb(0);
}
```

---

## 8. 虚拟搜索目录设计

### 8.1 目录结构

```
/search/
  last_query          ← 写入搜索词触发搜索
  results/            ← 搜索结果虚拟目录
    001_api_auth.md   ← 相关度最高的文档
    002_login_flow.md
    003_token_ref.md
    ...
```

### 8.2 搜索触发流程

```
Agent: echo "认证流程" > /search/last_query
         ↓
FUSE write() → 写入缓冲区
         ↓
FUSE release() → 检测到文件关闭
         ↓
触发 store.searchText("认证流程")
         ↓
生成 /search/results/ 下的虚拟文件列表
         ↓
Agent: cat /search/results/*
         ↓
FUSE read() → 返回对应 chunk 内容
```

### 8.3 虚拟文件元数据

`/search/results/001_api_auth.md` 的属性：
- `size`: 对应 chunk 内容的字节数
- `mtime`: 当前搜索时间
- `mode`: 0o100644（普通文件）
- `uid/gid`: 进程用户

### 8.4 M3 与 M4 的搜索差异

| | M3 (关键词搜索) | M4 (语义搜索) |
|---|---|---|
| 搜索方式 | `store.searchText()` | `store.searchVector()` |
| 嵌入向量 | 不需要 | 需要真实 embedder |
| 结果排序 | 按匹配次数 | 按向量相似度 |
| /search/results/ 内容 | 匹配文档的完整内容 | 最相关的 chunk 片段 |

---

## 9. 容器化与 Docker 配置

### 9.1 Dockerfile

参照 agent-fuse 的 Dockerfile，基于 `node:22-bookworm`：

```dockerfile
FROM node:22-bookworm

# 安装 FUSE 2 运行库和开发头文件
RUN apt-get update && apt-get install -y \
    fuse \
    libfuse2 \
    libfuse-dev \
    && rm -rf /var/lib/apt/lists/*

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 复制 package 文件
COPY package.json pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile
RUN pnpm approve-builds fuse-native better-sqlite3 || true

# 复制源码
COPY tsconfig.json ./
COPY src ./src

# 构建 TypeScript
RUN pnpm build

# 创建挂载点
RUN mkdir -p /vfs

# 允许 FUSE 非 root 用户挂载
RUN echo "user_allow_other" >> /etc/fuse.conf

# 运行
CMD ["node", "dist/agent/main.js"]
```

### 9.2 docker-compose.yml

```yaml
version: "3.8"
services:
  vfs-agent:
    build: .
    container_name: vfs4agent
    cap_add:
      - SYS_ADMIN        # FUSE 需要
    devices:
      - /dev/fuse        # FUSE 设备
    security_opt:
      - apparmor:unconfined  # 允许 FUSE 挂载
    volumes:
      - ./data:/app/data     # SQLite 数据库持久化
      - ./docs-content:/app/docs-content  # 待导入的文档目录
    environment:
      - VFS_BACKEND=sqlite
      - VFS_DB_PATH=/app/data/vfs.db
      - VFS_MOUNT=/vfs
      - DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
      - DASHSCOPE_BASE_URL=${DASHSCOPE_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}
      - QWEN_MODEL=${QWEN_MODEL:-qwen-plus}
    stdin_open: true
    tty: true
    working_dir: /app

  # 可选：Chroma 服务
  chroma:
    image: chromadb/chroma:latest
    ports:
      - "8000:8000"
    volumes:
      - chroma-data:/chroma/chroma

volumes:
  chroma-data:
```

### 9.3 构建与运行

```bash
# 构建
docker compose build

# 首次导入数据
docker compose run --rm vfs-agent node dist/cli/ingest.js \
  --dir /app/docs-content --prefix docs

# 启动 Agent REPL
docker compose run --rm -it vfs-agent
```

---

## 10. Agent SDK 适配层设计

### 10.1 Anthropic Agent SDK 适配

参照 agent-fuse 的 `agent.ts`：

```typescript
// src/agent/adapters/anthropic.ts
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const SYSTEM_PROMPT = `You are a documentation assistant.
You have access to a filesystem at /docs containing project documentation.
- Use ls, cat, grep, find to explore documentation
- /search/last_query allows semantic search: echo "your query" > /search/last_query
- Results appear in /search/results/
- All paths should be quoted in shell commands`;

export async function runAnthropicAgent(prompt: string, sessionId?: string) {
  const result = query({
    prompt,
    options: {
      cwd: "/vfs",
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: ["Bash", "Read", "Grep", "Glob"],
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
      },
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });

  for await (const message of result) {
    // 处理消息流...
  }
}
```

### 10.2 OpenAI SDK 适配（function calling 模式）

```typescript
// src/agent/adapters/openai.ts
import OpenAI from "openai";

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Execute a bash command in the documentation sandbox",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
        },
        required: ["command"],
      },
    },
  },
];

export async function runOpenAIAgent(
  llm: OpenAI,
  model: string,
  question: string,
  executeCommand: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
) {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  for (let turn = 0; turn < 20; turn++) {
    const response = await llm.chat.completions.create({
      model,
      messages,
      tools: TOOLS,
    });

    const choice = response.choices[0];

    if (choice.finish_reason === "stop") {
      return choice.message.content;
    }

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.function.name === "bash") {
          const args = JSON.parse(toolCall.function.arguments);
          const result = await executeCommand(args.command);
          messages.push(choice.message);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      }
    }
  }
}
```

### 10.3 MCP 适配（M3 后续）

MCP 适配遵循 MCP 协议，将 bash 命令执行暴露为 `tools/call` 方法。

---

## 11. 验收标准与测试

### 11.1 FUSE 基础功能测试

```bash
# 挂载成功后手动测试
mount | grep /vfs           # 应该看到 fuse 挂载

# 目录浏览
ls /vfs/docs/               # 应返回导入的文档目录
ls /vfs/docs/api/           # 应返回子目录和文件

# 文件读取
cat /vfs/docs/guide.md      # 应返回完整文件内容
head -n 5 /vfs/docs/guide.md  # 应返回前 5 行

# grep（真实的 /bin/grep）
grep -r "认证" /vfs/docs/   # 应返回匹配行
grep -rn "auth" /vfs/docs/api/  # 应返回带行号的匹配行
grep -l "OAuth" /vfs/docs/  # 应返回匹配文件列表

# find
find /vfs/docs -name "*.md"  # 应返回所有 .md 文件
find /vfs/docs -type d       # 应返回所有目录

# 虚拟搜索目录
ls /vfs/search/              # 应返回 last_query 和 results
echo "认证" > /vfs/search/last_query
ls /vfs/search/results/      # 应返回搜索结果文件
cat /vfs/search/results/*    # 应返回相关文档内容
```

### 11.2 Agent 集成测试

```bash
# 启动容器后，Agent REPL 应能正确回答问题
docker compose run --rm -it vfs-agent

# 在 REPL 中输入：
> 认证流程是怎样的？
# Agent 应该：
# 1. 执行 ls /vfs/docs/ 浏览目录
# 2. 执行 grep -r "认证" /vfs/docs/ 搜索
# 3. 执行 cat 读取相关文件
# 4. 给出综合答案
```

### 11.3 性能基准

| 操作 | 目标延迟 |
|---|---|
| `ls /vfs/docs/` (PathTree 1000 条目) | < 50ms |
| `cat /vfs/docs/50kb-file.md` | < 100ms |
| `grep -r "keyword" /vfs/docs/` (100 文件) | < 500ms |
| FUSE mount/unmount | < 200ms |

### 11.4 回归测试（保留功能）

```bash
# ingest 应该仍然正常工作
pnpm ingest --dir ./docs-content --prefix docs

# HTTP 桥应该仍然可用（如果保留）
curl http://localhost:7801/v1/health
curl -X POST http://localhost:7801/v1/fs/cat -d '{"path": "docs/guide.md"}'
```

---

## 12. 已知风险与注意事项

### 12.1 FUSE 平台限制

| 平台 | 支持情况 |
|---|---|
| Linux | ✅ 完整支持 |
| macOS | ✅ 支持（macFUSE，需要额外安装） |
| Windows | ❌ fuse-native 不支持 |

**缓解措施**：开发时使用 Docker 容器，确保环境一致。macOS 开发需要安装 macFUSE。

### 12.2 fuse-native 原生编译

`fuse-native` 需要编译原生模块，可能需要：
```bash
pnpm approve-builds fuse-native
```

如果遇到编译问题，确保系统安装了 C++ 编译器和 FUSE 开发头文件。

### 12.3 FUSE 权限

容器需要以下权限才能挂载 FUSE：
- `cap_add: SYS_ADMIN`
- `devices: /dev/fuse`
- `security_opt: apparmor:unconfined`

### 12.4 文件描述符管理

`open()` 返回的 fd 需要妥善管理：
- 使用 LRU 缓存限制同时打开的文件数
- `release()` 回调中清理缓存
- 防止内存泄漏

### 12.5 并发安全

FUSE 回调可能并发调用：
- `fdCache` 需要是并发安全的（或使用 Mutex）
- `searchState` 需要加锁

### 12.6 与 agent-fuse 的差异

| 维度 | agent-fuse | vfs4Agent |
|---|---|---|
| 数据模型 | 邮件（PGlite 关系型） | 文档 chunks（向量数据库） |
| fd 映射 | email.id（数据库主键） | 自增整数 + 内容缓存 |
| 写入支持 | 移动邮件、建目录 | 只读 + /search/last_query 写入 |
| Agent SDK | Anthropic SDK | OpenAI SDK（兼容 Qwen）+ Anthropic SDK |
| 搜索 | 无（邮件场景不需要） | 有（/search/ 虚拟目录） |

### 12.7 Docker 容器中的 FUSE 挂载注意事项

容器内挂载 FUSE 后，从容器外部（宿主机）**看不到**挂载点。FUSE 挂载只在容器内的进程可见。这意味着：
- Agent SDK 必须在**同一个容器内**运行
- 不能在宿主机上直接 `ls /docs` 来验证

---

## 附录 A：文件结构总览

重构完成后的目录结构：

```
vfs4Agent/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── DEVELOPER_HANDOFF.md
├── IMPLEMENTATION_PLAN.md
├── docs/                          ← 参考文档（已存在）
│   ├── agent-fuse-*.txt
│   ├── toolfs-*.txt
│   └── fuse-is-all-you-need.md
├── data/                          ← SQLite 数据库（gitignore）
├── src/
│   ├── types.ts                   ← 保留（核心类型定义）
│   ├── ingest.ts                  ← 保留（数据导入管道）
│   ├── backend/                   ← 保留（VectorStore 实现）
│   │   ├── factory.ts
│   │   ├── chroma.ts
│   │   └── sqlite.ts
│   ├── fuse/                      ← 新增（FUSE 层）
│   │   ├── index.ts
│   │   ├── helpers.ts
│   │   ├── search.ts
│   │   └── ops/
│   │       ├── index.ts
│   │       ├── getattr.ts
│   │       ├── open.ts
│   │       ├── read.ts
│   │       ├── readdir.ts
│   │       ├── write.ts
│   │       ├── release.ts
│   │       └── mkdir.ts
│   ├── agent/                     ← 新增（Agent 入口）
│   │   ├── main.ts
│   │   ├── repl.ts
│   │   └── adapters/
│   │       ├── openai.ts
│   │       └── anthropic.ts
│   ├── cli/                       ← 保留但调整
│   │   ├── ingest.ts              ← 不变
│   │   └── ask.ts                 ← 重写为 FUSE 模式
│   └── server.ts                  ← 简化（去掉 createShell）
└── examples/
    └── crewai-qwen-demo/          ← 保留（HTTP 模式 demo）
```

## 附录 B：执行检查清单

供执行者逐项确认：

- [ ] 步骤 0：删除模拟器层代码（shell.ts, fs/, grep/, runner/）
- [ ] 步骤 1：更新 package.json（移除旧依赖，添加 fuse-native）
- [ ] 步骤 2：创建 src/fuse/ 目录结构
- [ ] 步骤 3：实现 FUSE ops（getattr, open, read, readdir, write, release）
- [ ] 步骤 4：实现 helpers.ts（路径解析、chunk 拼接）
- [ ] 步骤 5：实现 search.ts（虚拟搜索目录）
- [ ] 步骤 6：创建 src/agent/main.ts（入口）
- [ ] 步骤 7：创建 src/agent/repl.ts（REPL）
- [ ] 步骤 8：创建 Dockerfile 和 docker-compose.yml
- [ ] 步骤 9：重写 src/cli/ask.ts
- [ ] 步骤 10：简化 src/server.ts
- [ ] 步骤 11：更新文档
- [ ] 验证：FUSE 挂载成功
- [ ] 验证：ls / cat / grep 正常工作
- [ ] 验证：虚拟搜索目录正常
- [ ] 验证：Agent REPL 能回答问题
- [ ] 验证：ingest 仍然正常工作
- [ ] 验证：pnpm build 无错误
