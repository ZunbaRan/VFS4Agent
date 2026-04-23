# Command Optimizer 设计文档

> **目标**：在 FUSE 兜底的基础上，为高频/高代价命令提供可选的数据库直查优化路径。
> **核心原则**：FUSE 保证正确性，Optimizer 保证性能。两者独立，Optimizer 可随时关闭。
> **日期**：2026-04-23

---

## 目录

### 第一部分：Command Optimizer — 命令性能优化层

1. [问题背景](#1-问题背景)
2. [架构设计](#2-架构设计)
3. [CommandOptimizer 接口](#3-commandoptimizer-接口)
4. [可优化命令清单](#4-可优化命令清单)
5. [GrepOptimizer 详细设计](#5-grepoptimizer-详细设计)
6. [其他优化器设计](#6-其他优化器设计)
7. [后端能力声明](#7-后端能力声明)
8. [集成方式](#8-集成方式)
9. [实施计划](#9-实施计划)

### 第二部分：服务化架构扩展 — Agent 解耦 + 数据库远程连接

10. [问题背景与目标](#c1-问题背景)
11. [数据库远程连接扩展](#c2-数据库远程连接扩展)
12. [Agent 环境解耦 — HTTP 沙箱服务](#c3-agent-环境解耦--http-沙箱服务)
13. [两种部署模式并存](#c4-两种部署模式并存)
14. [完整架构图](#c5-完整架构图合并后)
15. [服务化实施计划](#c6-实施计划)
16. [设计决策记录](#c7-设计决策记录)

### 附录

- [A: 旧版 grep 引擎复用](#附录-a旧版-grep-引擎复用)
- [B: 设计决策记录（Optimizer）](#附录-b设计决策记录)
- [C: 服务化架构扩展（同上第二部分）](#附录-c服务化架构扩展--agent-解耦--数据库远程连接)

---

## 1. 问题背景

### 1.1 纯 FUSE 模式的性能瓶颈

在纯 FUSE 架构下，Agent 执行 `grep -r "OAuth" /vfs/docs` 的真实代价：

```
grep 进程遍历 /vfs/docs 下 N 个文件
  → 每个文件触发: FUSE open → FUSE read → VectorStore.getChunksByPage()
  → N 次数据库往返 + N 次 chunks 拼接 + N 次内存正则匹配
  → 耗时: O(N × 数据库延迟)
```

**实测数据**（来自 ChromaFs 社区讨论）：
- 100 文件树：~2-3 秒
- 500 文件树：~8-15 秒
- 1000+ 文件树：**超时崩溃**

社区原话：
> "简单的虚拟 grep 会变成 N 次数据库调用——对大型树进行递归 grep 会很快崩溃。粗略过滤 → 预取 → 进程内精细过滤是任何虚拟文件系统的正确结构。"

### 1.2 其他有类似问题的命令

| 命令 | FUSE 路径代价 | 场景 |
|---|---|---|
| `grep -r "pattern" /vfs/docs` | N 次 open + N 次 read | 高频，Agent 最常用搜索方式 |
| `find /vfs/docs -name "*.md"` | M 次 readdir + M 次 getattr（M = 目录数） | 中频 |
| `tree /vfs/docs` | 递归 readdir + getattr | 中频 |
| `wc -l /vfs/docs/**/*.md` | N 次 open + N 次 read 全文 | 低频 |
| `ls -laR /vfs/docs` | M 次 readdir + N 次 getattr | 低频 |
| `du -s /vfs/docs` | N 次 getattr（获取每个文件 size） | 低频 |

### 1.3 设计目标

1. **不修改 FUSE**：FUSE 层保持通用性，永远作为兜底路径
2. **可插拔**：每个优化器独立注册，后端按需选择启用
3. **透明降级**：后端不支持优化能力时，自动退回 FUSE 路径
4. **环境开关**：通过环境变量 `VFS_OPTIMIZERS=grep,find` 控制启用哪些优化器

---

## 2. 架构设计

### 2.1 整体分层

```
Agent tool_call: { command: "grep -rn OAuth /vfs/docs" }
    ↓
┌─────────────────────────────────────────────┐
│  bash.ts (执行层)                             │
│                                               │
│  执行前 → 遍历 CommandOptimizer 注册表          │
│    │                                          │
│    ├── GrepOptimizer.match() → 命中 ✅          │
│    │   → 检查后端能力: store.capabilities       │
│    │   ├── supportsTextSearch: true            │
│    │   │  → GrepOptimizer.execute(store)       │
│    │   │  → 1 次 searchText + 1 次 bulkGet     │
│    │   │  → 进程内精筛 → 返回结果               │
│    │   └── supportsTextSearch: false           │
│    │      → 跳过优化器 → 走 FUSE 兜底            │
│    │                                          │
│    ├── FindOptimizer.match() → 不匹配 ❌        │
│    │                                          │
│    └── 无优化器命中 → spawn 真实 bash → FUSE     │
└─────────────────────────────────────────────┘
```

### 2.2 关键设计决策

| 决策 | 理由 |
|---|---|
| 优化器在 `bash.ts` 执行前拦截 | 避免启动子进程开销，直接走数据库 |
| 每个优化器独立实现 `match()` | 只拦截简单常见模式，复杂命令放过走 FUSE |
| 后端能力运行时检测 | 同一命令在不同后端有不同优化路径 |
| 默认关闭，环境变量开启 | 安全优先，方便对比测试和排查问题 |
| 旧版 `src/grep/engine.ts` 可复用 | 两阶段匹配逻辑几乎可以直接搬过来 |

---

## 3. CommandOptimizer 接口

### 3.1 核心接口

```typescript
// src/agent/commands/types.ts

/**
 * A command optimizer intercepts specific bash commands and executes them
 * via optimized database queries instead of spawning a real subprocess + FUSE.
 *
 * Design principle: the optimizer is an OPTIONAL fast path. If the backend
 * doesn't support the required capability, the command falls through to
 * the real bash + FUSE path which is always correct.
 */
export interface CommandOptimizer {
  /**
   * Human-readable name for logging/debugging.
   */
  readonly name: string;

  /**
   * Return true if this optimizer should handle the given command.
   * Should be conservative — only match patterns you can correctly emulate.
   * Complex flags or edge cases should return false and fall through to FUSE.
   */
  match(command: string): boolean;

  /**
   * Execute the command via optimized database queries.
   * Must return a result isomorphic to what bash would produce
   * (same stdout format, same exit code semantics).
   */
  execute(
    command: string,
    store: VectorStore,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;

  /**
   * Optional: the backend capabilities required for this optimizer to work.
   * If the store doesn't have these capabilities, the optimizer is skipped.
   */
  requiredCapabilities?: string[];
}
```

### 3.2 注册表

```typescript
// src/agent/commands/registry.ts
import type { CommandOptimizer } from "./types.js";
import type { VectorStore } from "../types.js";

export class OptimizerRegistry {
  private optimizers: CommandOptimizer[] = [];

  register(optimizer: CommandOptimizer): void {
    this.optimizers.push(optimizer);
  }

  /**
   * Try to find an optimizer for the given command.
   * Returns the first matching optimizer whose required capabilities
   * are satisfied by the store. Returns null if no optimizer matches.
   */
  find(
    command: string,
    store: VectorStore,
  ): CommandOptimizer | null {
    for (const opt of this.optimizers) {
      if (!opt.match(command)) continue;

      // Check required capabilities
      if (opt.requiredCapabilities) {
        const caps = (store as any).capabilities ?? {};
        const missing = opt.requiredCapabilities.filter((c) => !caps[c]);
        if (missing.length > 0) continue; // Skip, fall through to FUSE
      }

      return opt;
    }
    return null;
  }

  /**
   * List all registered optimizers (for debugging).
   */
  list(): string[] {
    return this.optimizers.map((o) => o.name);
  }
}
```

### 3.3 与 bash.ts 集成

```typescript
// src/agent/bash.ts — 在 spawn 前检查优化器

import { OptimizerRegistry } from "./commands/registry.js";
import type { VectorStore } from "../types.js";

const registry = new OptimizerRegistry();

export function registerOptimizer(optimizer: CommandOptimizer): void {
  registry.register(optimizer);
}

export async function execBash(
  command: string,
  mountPoint: string,
  store: VectorStore,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Check optimizer registry first
  const optimizer = registry.find(command, store);
  if (optimizer) {
    return optimizer.execute(command, store);
  }

  // Fall through to real bash subprocess + FUSE
  return spawnBash(command, mountPoint);
}
```

### 3.4 环境变量控制

```bash
# 启用所有优化器（默认关闭）
VFS_OPTIMIZERS=all

# 只启用 grep 优化器
VFS_OPTIMIZERS=grep

# 启用多个
VFS_OPTIMIZERS=grep,find,tree

# 全部禁用（纯 FUSE 模式）
VFS_OPTIMIZERS=none  # 或 unset
```

---

## 4. 可优化命令清单

### 4.1 优先级评估

| 命令 | Agent 使用频率 | FUSE 路径代价 | 优化收益 | 实现难度 | 优先级 |
|---|---|---|---|---|---|
| `grep -r` | ⭐⭐⭐⭐⭐ | O(N) 次 DB 查询 | 10-50x 加速 | 中 | **P0** |
| `find` | ⭐⭐⭐ | O(M) 次 readdir + getattr | 5-10x 加速 | 低 | **P1** |
| `tree` | ⭐⭐⭐ | O(M) 次 readdir + getattr | 5-10x 加速 | 低 | **P1** |
| `wc -l` / `wc -c` | ⭐⭐ | O(N) 次 open + read | 10-100x 加速 | 低 | **P2** |
| `ls -laR` | ⭐⭐ | O(M+N) 次 readdir + getattr | 5-10x 加速 | 低 | **P2** |
| `du -s` | ⭐ | O(N) 次 getattr | 10-50x 加速 | 低 | **P3** |
| `head -n K` | ⭐⭐⭐⭐ | 已较高效（FUSE read 带 offset/len） | 2-3x | 低 | **P4（可选）** |

### 4.2 各命令优化原理

#### grep -r (P0)
- **FUSE 路径**：遍历每个文件 → open → read → 内存正则匹配 → O(N) 次 DB 查询
- **优化路径**：`searchText()` 粗筛 → `bulkGet()` 预取 → 进程内精筛 → **2 次 DB 查询**

#### find (P1)
- **FUSE 路径**：递归 readdir 每个目录 + getattr 每个文件 → O(M+N) 次 DB 查询
- **优化路径**：直接从 PathTree 内存结构过滤 → **0 次 DB 查询**（PathTree 已在缓存）

#### tree (P1)
- **FUSE 路径**：递归 readdir + getattr 构建层级 → O(M+N) 次 DB 查询
- **优化路径**：从 PathTree 构建层级结构 → **0 次 DB 查询**

#### wc -l / wc -c (P2)
- **FUSE 路径**：打开每个文件 → 读取全文 → 数行数/字节数 → O(N) 次 DB 查询
- **优化路径**：从 PathTree 元数据读取 `lines` / `size` 字段 → **0 次 DB 查询**
- **前提**：ingest 时需要在 PathTreeEntry 中记录 `lines` 和 `size`（当前已有）

#### ls -laR (P2)
- **FUSE 路径**：递归 readdir + getattr 每个条目 → O(M+N) 次 DB 查询
- **优化路径**：从 PathTree 批量构建输出 → **0 次 DB 查询**

#### du -s (P3)
- **FUSE 路径**：getattr 每个文件获取 size → O(N) 次 DB 查询
- **优化路径**：从 PathTree 元数据求和 size → **0 次 DB 查询**

---

## 5. GrepOptimizer 详细设计

### 5.1 三阶段执行模型

```
┌─────────────────────────────────────────────────────────┐
│  GrepOptimizer.execute("grep -rn OAuth /vfs/docs")       │
│                                                         │
│  Stage 1: 粗筛 (数据库侧)                                 │
│  ┌───────────────────────────────────────────────┐      │
│  │ store.searchText({                            │      │
│  │   pattern: "OAuth",                           │      │
│  │   regex: false,                               │      │
│  │   pathPrefix: "docs",                         │      │
│  │   limit: 100                                  │      │
│  │ })                                            │      │
│  │ → Chroma: $contains / $regex on whereDocument  │      │
│  │ → SQLite: FTS5 MATCH / LIKE                    │      │
│  │ → 返回: ["docs/auth/oauth.md",                  │      │
│  │          "docs/auth/api-keys.md",               │      │
│  │          "docs/auth/token-refresh.md",          │      │
│  │          "docs/guides/getting-started.md"]     │      │
│  └───────────────────────────────────────────────┘      │
│                         ↓                               │
│  Stage 2: 预取 (批量拉取)                                │
│  ┌───────────────────────────────────────────────┐      │
│  │ store.bulkGetChunksByPages(candidateSlugs)    │      │
│  │ → Chroma: collection.get({page: {$in: [...]}}) │      │
│  │ → SQLite: WHERE page IN (...)                  │      │
│  │ → 返回: Map<slug, Chunk[]>                     │      │
│  └───────────────────────────────────────────────┘      │
│                         ↓                               │
│  Stage 3: 精筛 (进程内 JS)                               │
│  ┌───────────────────────────────────────────────┐      │
│  │ for (slug, chunks) of chunksMap:              │      │
│  │   content = assembleChunks(chunks)             │      │
│  │   lines = content.split("\n")                  │      │
│  │   for (line, idx) of lines:                    │      │
│  │     if (regex.test(line))                      │      │
│  │       matches.push(formatLine(slug, idx, line))│      │
│  │                                               │      │
│  │ return formatGrepOutput(matches)              │      │
│  └───────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

### 5.2 完整实现

```typescript
// src/agent/commands/grep_optimizer.ts
import type { CommandOptimizer } from "./types.js";
import type { VectorStore } from "../../types.js";
import { assembleChunks } from "../../fuse/helpers.js";

interface GrepResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Supported grep flags that the optimizer can correctly emulate.
 * Complex flags like -A/-B/-C (context lines) fall through to FUSE.
 */
const SUPPORTED_FLAGS = /^[rRnliHv]*$/;

/**
 * Parse a grep command into structured components.
 * Handles: grep [-flags] "pattern" path
 */
function parseGrepCommand(cmd: string): {
  flags: string;
  pattern: string;
  vfsPath: string;
} | null {
  // Match: grep [-flags] "pattern" /vfs/...path
  // or:    grep [-flags] 'pattern' /vfs/...path
  const m = cmd.match(
    /^grep\s+(?:-([a-zA-Z]+)\s+)?(?:"([^"]*)"|'([^']*)'|(\S+))\s+(\/vfs\/\S+)$/,
  );
  if (!m) return null;

  return {
    flags: m[1] ?? "",
    pattern: m[2] ?? m[3] ?? m[4],
    vfsPath: m[5],
  };
}

/**
 * Convert grep flags to RegExp.
 */
function buildRegExp(pattern: string, flags: string): RegExp {
  const reFlags = flags.includes("i") ? "gi" : "g";
  // If -F flag (fixed string), escape regex special chars
  const effective = flags.includes("F")
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : pattern;
  return new RegExp(effective, reFlags);
}

export class GrepOptimizer implements CommandOptimizer {
  readonly name = "grep-optimizer";
  readonly requiredCapabilities = ["supportsTextSearch"];

  match(command: string): boolean {
    // Only intercept recursive grep on /vfs paths
    if (!command.includes("/vfs/")) return false;
    if (!command.startsWith("grep")) return false;

    const parsed = parseGrepCommand(command);
    if (!parsed) return false;

    // Only handle -r/-R (recursive) patterns
    if (!parsed.flags.includes("r") && !parsed.flags.includes("R")) {
      return false;
    }

    // Only handle supported flags
    const unsupportedFlags = parsed.flags.replace(/rR/g, "");
    if (!SUPPORTED_FLAGS.test(unsupportedFlags)) {
      return false; // -A/-B/-C/-Z/-P etc. → fall through to FUSE
    }

    return true;
  }

  async execute(command: string, store: VectorStore): Promise<GrepResult> {
    const parsed = parseGrepCommand(command);
    if (!parsed) {
      return { stdout: "", stderr: "grep: failed to parse command\n", exitCode: 2 };
    }

    const { flags, pattern, vfsPath } = parsed;
    const slugPrefix = vfsPath.replace("/vfs/", "").replace(/\/+$/, "");

    // --- Stage 1: Coarse filter (database-side) ---
    const candidateSlugs = await store.searchText({
      pattern,
      regex: false, // Always use substring match for coarse filter
      ignoreCase: flags.includes("i"),
      pathPrefix: slugPrefix,
      limit: 200,
    });

    if (candidateSlugs.length === 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    // --- Stage 2: Prefetch (batch fetch) ---
    const chunksMap = await store.bulkGetChunksByPages(candidateSlugs);

    // --- Stage 3: Fine filter (in-process) ---
    const regex = buildRegExp(pattern, flags);
    const matches: Array<{ slug: string; lineNum: number; line: string }> = [];

    for (const [slug, chunks] of chunksMap) {
      const content = assembleChunks(chunks);
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (regex.test(line)) {
          matches.push({ slug, lineNum: i + 1, line });
        }
      }
    }

    if (matches.length === 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    // --- Format output ---
    const showLineNumbers = flags.includes("n");
    const showFilenamesOnly = flags.includes("l");
    const invertMatch = flags.includes("v");
    const caseInsensitive = flags.includes("i");

    if (showFilenamesOnly) {
      const uniqueFiles = [...new Set(matches.map((m) => m.slug))];
      return {
        stdout: uniqueFiles.map((f) => `/vfs/${f}`).join("\n") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }

    const outputLines = matches.map((m) => {
      const prefix = showLineNumbers
        ? `/vfs/${m.slug}:${m.lineNum}:`
        : `/vfs/${m.slug}:`;
      return `${prefix}${m.line}`;
    });

    return {
      stdout: outputLines.join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  }
}
```

### 5.3 后端具体实现

#### Chroma 后端

Chroma 的 `searchText` 已经实现了粗筛能力（`src/backend/chroma.ts` 第 168-201 行）：

```typescript
// ChromaVectorStore.searchText() — 当前已有实现
async searchText(opts: GrepOptions): Promise<string[]> {
  const whereDocument = opts.regex
    ? { $regex: pattern }          // Chroma 原生正则匹配
    : opts.ignoreCase
      ? { $regex: `(?i)${pattern}` }  // 大小写不敏感
      : { $contains: pattern };     // 子串匹配（最快）

  const r = await col.get({
    whereDocument,
    limit: opts.limit,
  });

  // 返回去重后的 slug 列表
  return [...new Set(r.metadatas.map(m => m.page))];
}
```

**Chroma 的优势**：
- `$contains`：底层使用 Python `in` 运算符，非常快
- `$regex`：使用 Python `re` 引擎，支持完整正则语法
- `whereDocument`：直接在文档内容上过滤，不需要先拉取再匹配

**性能特征**（Chroma HTTP 模式）：
- `searchText("OAuth")`：~50-100ms（1000 chunks 数据集）
- `bulkGetChunksByPages(50 slugs)`：~100-200ms
- 总计：~150-300ms vs FUSE 路径 3-15 秒

#### SQLite 后端

SQLite 的 `searchText` 使用 FTS5 全文索引（`src/backend/sqlite.ts` 第 150-200 行）：

```typescript
// SqliteVectorStore.searchText() — 当前已有实现
async searchText(opts: GrepOptions): Promise<string[]> {
  if (!opts.regex) {
    // FTS5 MATCH — 基于词元的全文搜索（快，但不支持子串）
    const ftsTerm = ftsQueryForSubstring(pattern);
    if (ftsTerm) {
      sql = `SELECT DISTINCT c.page FROM chunks c
             JOIN chunks_fts f ON f.rowid = c.id
             WHERE f.content MATCH ?`;
    } else {
      // FTS5 无法处理时，退回 LIKE
      sql = `SELECT DISTINCT page FROM chunks WHERE content LIKE ?`;
    }
  } else {
    // 正则模式 — 需要 sqlite REGEXP 扩展
    sql = `SELECT DISTINCT page FROM chunks WHERE content REGEXP ?`;
  }
  // ...
}
```

**SQLite 的优势**：
- FTS5 MATCH：极快（倒排索引），天然大小写不敏感
- `bulkGetChunksByPages`：单次 SQL `WHERE page IN (...)`，零网络开销
- 零外部依赖，单文件数据库

**性能特征**（SQLite 本地模式）：
- `searchText("OAuth")`：~5-20ms（FTS5 MATCH）
- `bulkGetChunksByPages(50 slugs)`：~5-10ms
- 总计：~10-30ms vs FUSE 路径 2-8 秒

### 5.4 不支持的场景（退回 FUSE）

| 场景 | 原因 | 处理方式 |
|---|---|---|
| `grep -A 3 "auth"`（上下文行） | 需要匹配行前后 3 行，逻辑复杂 | `match()` 返回 false → FUSE |
| `grep -B 2 "auth"`（前置行） | 同上 | `match()` 返回 false → FUSE |
| `grep -C 5 "auth"`（前后上下文） | 同上 | `match()` 返回 false → FUSE |
| `grep -P "lookahead"`（PCRE） | JS 正则不支持 PCRE 特性 | `match()` 返回 false → FUSE |
| `grep -z`（null 分隔符） | 输出格式不同 | `match()` 返回 false → FUSE |
| `grep --color` | 需要 ANSI 着色输出 | `match()` 返回 false → FUSE |
| `grep "pattern" file.md`（非递归） | 单文件，FUSE 已经很快 | 不拦截，直接 FUSE |

### 5.5 性能对比

| 数据集 | FUSE 路径 | Chroma 优化 | SQLite 优化 |
|---|---|---|---|
| 10 文件 | ~200ms | ~150ms | ~15ms |
| 100 文件 | ~2s | ~250ms | ~25ms |
| 500 文件 | ~8s | ~400ms | ~50ms |
| 1000 文件 | ~15s (超时风险) | ~600ms | ~80ms |
| 5000 文件 | 崩溃 | ~2s | ~200ms |

---

## 6. 其他优化器设计

### 6.1 FindOptimizer (P1)

```typescript
// src/agent/commands/find_optimizer.ts

/**
 * Optimizes: find /vfs/docs -name "*.md"
 *             find /vfs/docs -type f
 *             find /vfs/docs -name "*.md" -type f
 *
 * Fallback:  find with -exec, -mtime, -size, -maxdepth → FUSE
 */
export class FindOptimizer implements CommandOptimizer {
  readonly name = "find-optimizer";
  // No required capabilities — PathTree is always available

  match(command: string): boolean {
    if (!command.includes("/vfs/")) return false;
    if (!command.startsWith("find")) return false;

    // Only intercept simple patterns
    const simple = /^find\s+\/vfs\/\S+(\s+-name\s+["']?[^"'\s]+["']?)?(\s+-type\s+[fd])?$/;
    return simple.test(command);
  }

  async execute(command: string, store: VectorStore): Promise<GrepResult> {
    const tree = await store.getPathTree(); // From cache, ~0ms

    // Parse: find /vfs/docs -name "*.md" -type f
    const parsed = parseFindCommand(command);
    const prefix = parsed.vfsPath.replace("/vfs/", "");

    const results: string[] = [];
    for (const slug of Object.keys(tree)) {
      if (prefix && !slug.startsWith(prefix)) continue;

      // -type f: skip directories
      if (parsed.type === "f" && isDirectory(slug, tree)) continue;
      // -type d: skip files
      if (parsed.type === "d" && !isDirectory(slug, tree)) continue;

      // -name pattern match
      if (parsed.namePattern) {
        const filename = slug.split("/").pop()!;
        if (!globMatch(filename, parsed.namePattern)) continue;
      }

      results.push(`/vfs/${slug}`);
    }

    return {
      stdout: results.sort().join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  }
}
```

**性能对比**：
- FUSE 路径：O(M) 次 `readdir` + O(N) 次 `getattr` → M+N 次查询
- 优化路径：0 次查询（PathTree 已在内存缓存）

### 6.2 TreeOptimizer (P1)

```typescript
// src/agent/commands/tree_optimizer.ts

/**
 * Optimizes: tree /vfs/docs
 *             tree -L 2 /vfs/docs
 *
 * Fallback:  tree with -a, -i, -p, -s → FUSE
 */
export class TreeOptimizer implements CommandOptimizer {
  readonly name = "tree-optimizer";

  match(command: string): boolean {
    return /^tree(\s+-L\s+\d+)?(\s+\/vfs\/\S+)?$/.test(command);
  }

  async execute(command: string, store: VectorStore): Promise<GrepResult> {
    const tree = await store.getPathTree();
    const parsed = parseTreeCommand(command);
    const prefix = parsed.vfsPath?.replace("/vfs/", "") ?? "";
    const maxDepth = parsed.maxDepth ?? Infinity;

    // Build tree structure from flat PathTree
    const root = buildTree(tree, prefix, maxDepth);

    // Format as `tree` output
    const output = formatTree(root, { showHidden: false });
    const stats = countEntries(root);

    return {
      stdout: `${output}\n\n${stats.directories} directories, ${stats.files} files\n`,
      stderr: "",
      exitCode: 0,
    };
  }
}
```

**性能对比**：
- FUSE 路径：O(M) 次 `readdir` + O(N) 次 `getattr` → 递归查询
- 优化路径：0 次查询，纯内存操作（PathTree 遍历 + 格式化）

### 6.3 WcOptimizer (P2)

```typescript
// src/agent/commands/wc_optimizer.ts

/**
 * Optimizes: wc -l /vfs/docs/auth/oauth.md
 *             wc -c /vfs/docs/**/*.md
 *
 * Prerequisite: ingest must populate PathTreeEntry.lines and .size
 * Fallback:  wc without -l/-c flags → FUSE
 */
export class WcOptimizer implements CommandOptimizer {
  readonly name = "wc-optimizer";

  match(command: string): boolean {
    if (!command.includes("/vfs/")) return false;
    return /^wc\s+(-[lc]+)\s+/.test(command);
  }

  async execute(command: string, store: VectorStore): Promise<GrepResult> {
    const tree = await store.getPathTree();
    const parsed = parseWcCommand(command);

    // Resolve globs and collect files
    const files = resolvePaths(parsed.paths, tree);

    const results: Array<{ lines?: number; bytes?: number; path: string }> = [];
    let totalLines = 0, totalBytes = 0;

    for (const slug of files) {
      const entry = tree[slug];
      if (!entry || isDirectory(slug, tree)) continue;

      const lines = entry.lines ?? 0;
      const bytes = entry.size ?? 0;
      totalLines += lines;
      totalBytes += bytes;

      results.push({
        ...(parsed.flags.includes("l") ? { lines } : {}),
        ...(parsed.flags.includes("c") ? { bytes } : {}),
        path: `/vfs/${slug}`,
      });
    }

    // Format output
    const output = results
      .map((r) => {
        const parts = [];
        if (parsed.flags.includes("l")) parts.push(String(r.lines).padStart(7));
        if (parsed.flags.includes("c")) parts.push(String(r.bytes).padStart(7));
        parts.push(r.path);
        return parts.join(" ");
      })
      .join("\n");

    if (results.length > 1) {
      const totalParts = [];
      if (parsed.flags.includes("l")) totalParts.push(String(totalLines).padStart(7));
      if (parsed.flags.includes("c")) totalParts.push(String(totalBytes).padStart(7));
      totalParts.push("total");
      return { stdout: output + "\n" + totalParts.join(" ") + "\n", stderr: "", exitCode: 0 };
    }

    return { stdout: output + "\n", stderr: "", exitCode: 0 };
  }
}
```

**性能对比**：
- FUSE 路径：O(N) 次 `open` + O(N) 次 `read` 全文 → N 次查询
- 优化路径：0 次查询（元数据已在 PathTree 缓存中）

### 6.4 LsRecursiveOptimizer (P2)

```typescript
// src/agent/commands/ls_recursive_optimizer.ts

/**
 * Optimizes: ls -laR /vfs/docs
 *             ls -lR /vfs/docs
 *
 * Fallback:  ls without -R → already fast via FUSE (single readdir)
 */
export class LsRecursiveOptimizer implements CommandOptimizer {
  readonly name = "ls-recursive-optimizer";

  match(command: string): boolean {
    return /^ls\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(\/vfs\/\S+)$/.test(command);
  }

  async execute(command: string, store: VectorStore): Promise<GrepResult> {
    const tree = await store.getPathTree();
    const prefix = extractPath(command).replace("/vfs/", "");

    // Group entries by directory
    const dirs = new Map<string, Array<{ name: string; entry: PathTreeEntry }>>();
    for (const [slug, entry] of Object.entries(tree)) {
      if (prefix && !slug.startsWith(prefix)) continue;
      const dir = slug.substring(0, slug.lastIndexOf("/")) || ".";
      const name = slug.split("/").pop()!;
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir)!.push({ name, entry });
    }

    // Format output
    const output: string[] = [];
    for (const [dir, entries] of dirs) {
      output.push(`\n/vfs/${dir}:`);
      for (const { name, entry } of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const perms = isDirectoryInTree(`${dir}/${name}`, tree) ? "drwxr-xr-x" : "-rw-r--r--";
        const size = String(entry.size ?? 4096).padStart(8);
        const mtime = formatMtime(entry.mtime);
        output.push(`${perms}  1 root root  ${size} ${mtime} ${name}`);
      }
    }

    return { stdout: output.join("\n") + "\n", stderr: "", exitCode: 0 };
  }
}
```

### 6.5 DuOptimizer (P3)

```typescript
// src/agent/commands/du_optimizer.ts

/**
 * Optimizes: du -s /vfs/docs
 *             du -sh /vfs/docs
 *
 * Uses PathTreeEntry.size metadata — no file reading needed.
 */
export class DuOptimizer implements CommandOptimizer {
  readonly name = "du-optimizer";

  match(command: string): boolean {
    return /^du\s+(-[shkmb]*\s+)?\/vfs\//.test(command);
  }

  async execute(command: string, store: VectorStore): Promise<GrepResult> {
    const tree = await store.getPathTree();
    const prefix = extractPath(command).replace("/vfs/", "");

    let totalBytes = 0;
    for (const [slug, entry] of Object.entries(tree)) {
      if (prefix && !slug.startsWith(prefix) && slug !== prefix) continue;
      if (isDirectory(slug, tree)) continue; // Directories don't have size
      totalBytes += entry.size ?? 0;
    }

    const humanReadable = command.includes("-h");
    const size = humanReadable ? humanSize(totalBytes) : String(Math.ceil(totalBytes / 1024));
    const suffix = humanReadable ? "" : "K";

    return {
      stdout: `${size}${suffix}\t/vfs/${prefix}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
}
```

---

## 7. 后端能力声明

### 7.1 扩展 VectorStore 接口

```typescript
// src/types.ts — 扩展

export interface VectorStoreCapabilities {
  /** Supports searchText() for coarse text filtering */
  supportsTextSearch?: boolean;
  /** Supports native regex in searchText (e.g. Chroma $regex) */
  supportsRegex?: boolean;
  /** Supports bulkGetChunksByPages() for batch prefetch */
  supportsBulkPrefetch?: boolean;
  /** PathTree entries have accurate line counts */
  hasLineCounts?: boolean;
  /** PathTree entries have accurate byte sizes */
  hasByteSizes?: boolean;
}

export interface VectorStore {
  // ... existing methods ...

  /** Runtime capability introspection. Optimizers check this before executing. */
  readonly capabilities?: VectorStoreCapabilities;
}
```

### 7.2 各后端能力声明

| 能力 | Chroma | SQLite |
|---|---|---|
| `supportsTextSearch` | ✅ `$contains` / `$regex` on whereDocument | ✅ FTS5 MATCH / LIKE |
| `supportsRegex` | ✅ Python `re` 引擎，完整正则 | ⚠️ 需要 `sqlite-regex` 扩展，否则退回 LIKE |
| `supportsBulkPrefetch` | ✅ `collection.get({page: {$in: [...]}})` | ✅ `WHERE page IN (...)` |
| `hasLineCounts` | ✅ PathTreeEntry.lines（ingest 时写入） | ✅ 同上 |
| `hasByteSizes` | ✅ PathTreeEntry.size（ingest 时写入） | ✅ 同上 |

### 7.3 能力声明在代码中的使用

```typescript
// src/backend/chroma.ts
export class ChromaVectorStore implements VectorStore {
  readonly capabilities = {
    supportsTextSearch: true,
    supportsRegex: true,       // Chroma $regex on whereDocument
    supportsBulkPrefetch: true,
    hasLineCounts: true,
    hasByteSizes: true,
  };
  // ...
}

// src/backend/sqlite.ts
export class SqliteVectorStore implements VectorStore {
  readonly capabilities = {
    supportsTextSearch: true,
    supportsRegex: false,      // SQLite REGEXP needs extension
    supportsBulkPrefetch: true,
    hasLineCounts: true,
    hasByteSizes: true,
  };
  // ...
}
```

---

## 8. 集成方式

### 8.1 启动时注册优化器

```typescript
// src/agent/main.ts — Agent 入口

import { OptimizerRegistry } from "./commands/registry.js";
import { GrepOptimizer } from "./commands/grep_optimizer.js";
import { FindOptimizer } from "./commands/find_optimizer.js";
import { TreeOptimizer } from "./commands/tree_optimizer.js";

const enabledOptimizers = (process.env.VFS_OPTIMIZERS ?? "").toLowerCase();

function shouldEnable(name: string): boolean {
  if (!enabledOptimizers || enabledOptimizers === "none") return false;
  if (enabledOptimizers === "all") return true;
  return enabledOptimizers.split(",").includes(name);
}

const registry = new OptimizerRegistry();

if (shouldEnable("grep")) registry.register(new GrepOptimizer());
if (shouldEnable("find")) registry.register(new FindOptimizer());
if (shouldEnable("tree")) registry.register(new TreeOptimizer());

console.log(`[main] Optimizers enabled: ${registry.list().join(", ") || "none"}`);
```

### 8.2 日志与调试

```typescript
// 优化器命中时的日志
export async function execBash(
  command: string,
  mountPoint: string,
  store: VectorStore,
) {
  const optimizer = registry.find(command, store);
  if (optimizer) {
    const start = Date.now();
    const result = await optimizer.execute(command, store);
    const elapsed = Date.now() - start;
    console.log(
      `[optimizer] ${optimizer.name} handled "${command.slice(0, 60)}..." ` +
      `in ${elapsed}ms (exit=${result.exitCode})`,
    );
    return result;
  }

  // Fall through to FUSE
  return spawnBash(command, mountPoint);
}
```

### 8.3 测试方式

```bash
# 测试纯 FUSE 模式（基准）
VFS_OPTIMIZERS=none docker compose run --rm vfs-agent \
  node -e "..."

# 测试优化器模式
VFS_OPTIMIZERS=grep docker compose run --rm vfs-agent \
  node -e "..."

# 对比输出一致性
# 优化器输出必须与 FUSE 输出完全一致（格式 + exit code）
```

---

## 9. 实施计划

### P0 — GrepOptimizer（立即实现）

| 步骤 | 任务 | 文件 | 预计工作量 |
|---|---|---|---|
| 1 | 定义 `CommandOptimizer` 接口 + `OptimizerRegistry` | `src/agent/commands/types.ts`, `registry.ts` | 1h |
| 2 | 实现 `GrepOptimizer` | `src/agent/commands/grep_optimizer.ts` | 2h |
| 3 | 实现 `parseGrepCommand()` 解析器 | `src/agent/commands/grep_optimizer.ts` | 1h |
| 4 | 集成到 `bash.ts` | `src/agent/bash.ts` | 30min |
| 5 | 添加环境变量控制 | `src/agent/main.ts` | 30min |
| 6 | 添加能力声明到 VectorStore | `src/types.ts`, `backend/chroma.ts`, `backend/sqlite.ts` | 30min |
| 7 | Docker 测试对比 | `docs/` 测试脚本 | 1h |
| **总计** | | | **~6h** |

### P1 — FindOptimizer + TreeOptimizer

| 步骤 | 任务 | 文件 | 预计工作量 |
|---|---|---|---|
| 1 | 实现 `FindOptimizer` | `src/agent/commands/find_optimizer.ts` | 1h |
| 2 | 实现 `TreeOptimizer` | `src/agent/commands/tree_optimizer.ts` | 1h |
| 3 | 实现 `globMatch()` / `formatTree()` 辅助函数 | `src/agent/commands/helpers.ts` | 1h |
| 4 | Docker 测试 | | 30min |
| **总计** | | | **~3.5h** |

### P2 — WcOptimizer + LsRecursiveOptimizer

| 步骤 | 任务 | 预计工作量 |
|---|---|---|
| 1 | 实现 `WcOptimizer` | 1h |
| 2 | 实现 `LsRecursiveOptimizer` | 1h |
| 3 | 确保 ingest 写入 lines/size 元数据 | 30min |
| 4 | 测试 | 30min |
| **总计** | | **~3h** |

### P3 — DuOptimizer

| 步骤 | 任务 | 预计工作量 |
|---|---|---|
| 1 | 实现 `DuOptimizer` | 30min |
| 2 | 实现 `humanSize()` 辅助函数 | 15min |
| 3 | 测试 | 15min |
| **总计** | | **~1h** |

### 全部完成预计：~13.5 小时开发时间

---

## 附录 A：旧版 grep 引擎复用

旧版 `src/grep/engine.ts`（已在重构中删除）实现了两阶段匹配逻辑：

```typescript
// 旧版核心逻辑（可复用）
async function twoStageGrep(pattern: string, store: VectorStore) {
  // Stage 1: Coarse (DB-side)
  const candidateSlugs = await store.searchText({ pattern, limit: 100 });

  // Stage 2: Fine (in-memory)
  const chunksMap = await store.bulkGetChunksByPages(candidateSlugs);
  const regex = new RegExp(pattern, "g");
  const matches = [];

  for (const [slug, chunks] of chunksMap) {
    const content = assembleChunks(chunks);
    for (const line of content.split("\n")) {
      if (regex.test(line)) matches.push({ slug, line });
    }
  }
  return matches;
}
```

这个逻辑几乎可以直接搬过来作为 `GrepOptimizer.execute()` 的核心。

## 附录 B：设计决策记录

### 为什么不在 FUSE 层做优化？

因为 FUSE 层的职责是"通用文件系统接口"，不应该知道上层命令的语义。优化器是"命令语义层"，知道 `grep`/`find`/`wc` 等命令的意图，可以针对性优化。两者职责不同，不应耦合。

### 为什么只做部分 flag 支持？

因为优化器的目标是加速**常见场景**，不是完美模拟所有行为。`grep -A/-B/-C`、`--color`、`-z` 等复杂 flag 使用频率低，直接退回 FUSE 路径更简单可靠。

### 为什么默认关闭？

1. 优化器可能有 bug，默认关闭更安全
2. 方便 A/B 测试：对比优化器 vs FUSE 的输出一致性和性能差异
3. 排查问题时可以先关闭优化器，确认是优化器问题还是 FUSE 问题

### 为什么 GrepOptimizer 不处理非递归 grep？

非递归 `grep "pattern" single_file.md` 只触发一次 FUSE open + read，已经很快（~10-50ms）。优化器的价值主要体现在递归场景（N 次文件访问 → 2 次 DB 查询）。

---

## 附录 C：服务化架构扩展 — 数据库远程连接 + Agent 环境解耦

> **核心思路**：将沙箱从"嵌入式库"升级为"可独立部署的 HTTP 服务"，实现 Agent 与 FUSE 容器的解耦，支持多 Agent 共享同一数据源。

### C.1 问题背景

#### 当前架构的局限性

当前 vfs4Agent 是**嵌入式架构**：Agent REPL 和 FUSE 挂载必须在同一个 Docker 容器内。

```
[单个 Docker 容器]
┌──────────────────────────────────────────┐
│  Agent REPL (Node.js)                     │
│    → spawn("/bin/bash")                   │
│    → Linux VFS → FUSE → VectorStore → DB │
└──────────────────────────────────────────┘
```

**局限性**：
1. **Agent 必须在沙箱容器内**：无法从外部连接
2. **多 Agent 无法共享数据**：每个 Agent 需要独立容器，各自 mount FUSE
3. **SQLite 单文件限制**：多个容器无法安全共享同一个 SQLite 文件
4. **每个容器需要 SYS_ADMIN**：FUSE 挂载需要内核权限

#### 目标架构

```
[Agent A 容器] ──┐
[Agent B 容器] ──┼── HTTP POST /v1/bash → [沙箱服务容器] → FUSE → 远程数据库
[Agent C 本地] ──┘
```

### C.2 数据库远程连接扩展

#### 当前后端连接模式

| 后端 | 本地模式 | 远程模式 | 说明 |
|---|---|---|---|
| **Chroma** | `http://127.0.0.1:8000` | `http://chroma-server:8000` | 已是 HTTP 服务，天然支持远程 |
| **SQLite** | `/app/data/vfs.db` | ⚠️ 可 NFS 挂载但不推荐 | 单文件数据库，网络并发写入有风险 |
| **PostgreSQL** | — | 🆕 待实现 | 原生网络访问 + pgvector 向量搜索 |

#### 扩展设计

Chroma 已经是 HTTP 服务，远程连接只需改 `CHROMA_URL` 环境变量。真正需要新增的是 **PostgreSQL 后端**，它解决 SQLite 无法多实例共享的问题：

```typescript
// src/backend/factory.ts — 扩展

function createBackend(): { store: VectorStore } {
  const backend = process.env.VFS_BACKEND ?? "chroma";
  switch (backend) {
    case "chroma":
      return { store: new ChromaVectorStore({
        url: process.env.CHROMA_URL ?? "http://127.0.0.1:8000",
      })};
    case "sqlite":
      return { store: new SqliteVectorStore({
        path: process.env.VFS_DB_PATH ?? "./data/vfs.db",
      })};
    case "postgres":  // ← 新增
      return { store: new PostgresVectorStore({
        host: process.env.PG_HOST ?? "127.0.0.1",
        port: Number(process.env.PG_PORT ?? 5432),
        database: process.env.PG_DATABASE ?? "vfs",
        user: process.env.PG_USER ?? "postgres",
        password: process.env.PG_PASSWORD,
        collection: process.env.PG_COLLECTION ?? "vfs_docs",
      })};
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }
}
```

#### PostgreSQL 后端设计要点

PostgreSQL + `pgvector` 扩展可以直接替代 Chroma 的向量搜索能力：

```sql
-- 初始化
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunks 表
CREATE TABLE chunks (
  id SERIAL PRIMARY KEY,
  page TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536)  -- OpenAI embedding dim
);

-- 全文索引（替代 SQLite FTS5）
CREATE INDEX chunks_content_idx ON chunks USING gin (to_tsvector('english', content));

-- PathTree 表
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- 粗筛查询（替代 Chroma searchText）
SELECT DISTINCT page FROM chunks
WHERE content ILIKE '%OAuth%';

-- 向量搜索（M4 语义搜索）
SELECT page, content FROM chunks
ORDER BY embedding <-> '[0.1, 0.2, ...]'
LIMIT 10;
```

#### 后端能力矩阵（扩展后）

| 能力 | Chroma 远程 | SQLite 本地 | PostgreSQL 远程 |
|---|---|---|---|
| `supportsTextSearch` | ✅ `$contains`/`$regex` | ✅ FTS5 MATCH | ✅ `ILIKE` / `@@` 全文搜索 |
| `supportsRegex` | ✅ `$regex` | ✅ 自定义 REGEXP 函数 | ✅ `~` 正则匹配 |
| `supportsBulkPrefetch` | ✅ HTTP batch | ✅ `WHERE IN` | ✅ `WHERE IN` |
| **多实例共享** | ✅ HTTP 天然支持 | ❌ 单文件锁 | ✅ 原生并发 |
| **远程连接** | ✅ 改 CHROMA_URL | ⚠️ NFS 不推荐 | ✅ 原生 TCP |
| **零外部依赖** | ❌ 需要 Chroma 服务 | ✅ 嵌入式 | ❌ 需要 PG 服务 |

#### 适用场景

| 后端 | 适用场景 | 不适用场景 |
|---|---|---|
| **SQLite** | 本地开发、单用户、离线、零依赖 | 多 Agent 共享、远程访问、高并发写入 |
| **Chroma** | 中小型部署、向量搜索、HTTP 集成 | 需要复杂 SQL 查询的场景 |
| **PostgreSQL** | 多 Agent 共享、高并发、复杂查询、生产部署 | 零依赖要求、极简部署 |

### C.3 Agent 环境解耦 — HTTP 沙箱服务

#### 解耦架构

```
┌───────────────────────────┐      ┌───────────────────────────────┐
│  Agent 运行环境             │      │  沙箱服务容器                   │
│  (任何地方都行)              │ HTTP │  (需要 SYS_ADMIN + /dev/fuse)  │
│                            │─────→│                               │
│  ┌──────────────┐  POST    │      │  ┌──────────────────────┐     │
│  │ Agent REPL   │ /v1/bash │      │  │ Fastify Server :7801 │     │
│  │              │──────────┼─────→│  │ POST /v1/bash        │     │
│  │ Bash Tool:   │          │      │  │   ↓                  │     │
│  │ HTTP POST    │←─────────┼──────│  │ Command Optimizer    │     │
│  │ to sandbox   │ response │      │  │   ↓ (if enabled)     │     │
│  └──────────────┘          │      │  │ spawn("/bin/bash")   │     │
│                            │      │  │   ↓                  │     │
│                            │      │  │ Linux VFS → FUSE     │     │
│                            │      │  │   ↓                  │     │
│                            │      │  │ VectorStore → DB     │     │
│                            │      │  └──────────────────────┘     │
└───────────────────────────┘      └───────────────────────────────┘
      Agent 无感知                        FUSE 在这里，只需要一个容器
      以为自己在调 bash
```

#### 沙箱服务端实现

改造 `src/server.ts`，让它在启动时 mount FUSE，然后通过 HTTP 接收命令：

```typescript
// src/server.ts — 解耦架构下的沙箱服务

import Fastify from "fastify";
import cors from "@fastify/cors";
import { mount, unmount } from "./fuse/index.js";
import { createBackend } from "./backend/factory.js";
import { execBash } from "./agent/bash.js";
import { OptimizerRegistry } from "./agent/commands/registry.js";
import { GrepOptimizer } from "./agent/commands/grep_optimizer.js";

const app = Fastify({ logger: true });
await app.register(cors());

const { store } = createBackend();
const MOUNT_POINT = process.env.VFS_MOUNT ?? "/vfs";
const registry = new OptimizerRegistry();

// Register optimizers based on env
const enabledOptimizers = (process.env.VFS_OPTIMIZERS ?? "").toLowerCase();
if (enabledOptimizers === "all" || enabledOptimizers.includes("grep")) {
  registry.register(new GrepOptimizer());
}

// Mount FUSE once at startup
console.log(`[server] Mounting FUSE at ${MOUNT_POINT}...`);
await mount({ store, mountPoint: MOUNT_POINT });
console.log(`[server] FUSE mounted. Optimizers: ${registry.list().join(", ") || "none"}`);

// --- API Endpoints ---

/**
 * POST /v1/bash
 * Execute a bash command in the sandbox.
 * This is the primary interface for remote Agents.
 */
app.post("/v1/bash", async (req, reply) => {
  const { command } = req.body as { command: string };
  if (!command) {
    return reply.code(400).send({ error: "Missing 'command' in request body" });
  }

  const start = Date.now();

  // Check optimizer registry first
  const optimizer = registry.find(command, store);
  if (optimizer) {
    const result = await optimizer.execute(command, store);
    console.log(`[optimizer] ${optimizer.name} handled in ${Date.now() - start}ms`);
    return result;
  }

  // Fall through to real bash + FUSE
  const result = await execBash(command, MOUNT_POINT, store);
  console.log(`[bash] ${command.slice(0, 80)} → exit=${result.exitCode} (${Date.now() - start}ms)`);
  return result;
});

/**
 * POST /v1/fs/cat
 * Direct file read (alternative to bash for simple cases).
 */
app.post("/v1/fs/cat", async (req, reply) => {
  const { path } = req.body as { path: string };
  if (!path) return reply.code(400).send({ error: "Missing 'path'" });

  try {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(`${MOUNT_POINT}/${path}`, "utf8");
    return { content };
  } catch (e: any) {
    return reply.code(404).send({ error: e.message });
  }
});

/**
 * POST /v1/fs/ls
 * Direct directory listing.
 */
app.post("/v1/fs/ls", async (req, reply) => {
  const { path } = req.body as { path: string };
  if (!path) return reply.code(400).send({ error: "Missing 'path'" });

  try {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(`${MOUNT_POINT}/${path}`);
    return { entries };
  } catch (e: any) {
    return reply.code(404).send({ error: e.message });
  }
});

/**
 * GET /v1/health
 */
app.get("/v1/health", async () => ({
  status: "ok",
  backend: process.env.VFS_BACKEND ?? "chroma",
  mount: MOUNT_POINT,
  optimizers: registry.list(),
  uptime: process.uptime(),
}));

// --- Lifecycle ---

const port = Number(process.env.PORT ?? 7801);
await app.listen({ host: "0.0.0.0", port });
console.log(`[server] Listening on :${port}`);

// Graceful shutdown
const shutdown = async () => {
  console.log("[server] Shutting down...");
  await unmount(MOUNT_POINT);
  store.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

#### Agent 侧的 Bash Tool 实现

Agent 只需要一个极简的 HTTP Bash Tool：

**Python (CrewAI / LangChain)**：
```python
import requests

class SandboxBashTool(BaseTool):
    name: str = "sandbox_bash"
    description: str = "Execute a bash command in the vfs sandbox"
    sandbox_url: str = "http://vfs-sandbox:7801/v1/bash"

    def _run(self, command: str) -> str:
        resp = requests.post(self.sandbox_url, json={"command": command})
        data = resp.json()
        if data["exitCode"] != 0:
            return f"Error (exit {data['exitCode']}): {data['stderr']}"
        return data["stdout"]
```

**TypeScript (Claude Agent SDK)**：
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: "搜索 OAuth 文档",
  options: {
    allowedTools: ["Bash"],
    sandbox: { enabled: false }, // 不用 SDK 自带的沙箱
  },
  // 自定义 Bash 工具执行器
  hooks: {
    onBashCommand: async (command) => {
      const resp = await fetch("http://vfs-sandbox:7801/v1/bash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      return (await resp.json()).stdout;
    },
  },
});
```

#### 性能分析

| 操作 | 嵌入式模式 | HTTP 解耦模式 | 差异 |
|---|---|---|---|
| `ls /vfs/docs` | ~5ms | ~7ms（+2ms HTTP 开销） | 可忽略 |
| `cat /vfs/docs/a.md` | ~20ms | ~25ms（+5ms HTTP 开销） | 可忽略 |
| `grep -r "OAuth"` (FUSE) | ~3s | ~3.005s（+5ms HTTP 开销） | 可忽略 |
| `grep -r "OAuth"` (优化器) | ~300ms | ~305ms（+5ms HTTP 开销） | 可忽略 |

**结论**：HTTP 跳转的 ~2-5ms 延迟在任何场景下都可以忽略。FUSE + 数据库查询才是真正的性能瓶颈，优化器才是关键。

### C.4 合并架构：两种部署模式并存

```typescript
// src/agent/main.ts — 支持两种模式

const mode = process.env.VFS_MODE ?? "embedded"; // embedded | server

if (mode === "embedded") {
  // 模式 A: 嵌入式 — Agent + FUSE 在同一进程
  const { store } = createBackend();
  await mount({ store, mountPoint: MOUNT_POINT });
  await startRepl(store, MOUNT_POINT);  // REPL 直接调 bash.ts

} else if (mode === "server") {
  // 模式 B: 服务化 — FUSE 服务独立运行
  // Agent 通过 HTTP 连接
  // 见 server.ts 实现
  console.log("Run server mode via: pnpm server");

} else {
  throw new Error(`Unknown VFS_MODE: ${mode}. Use 'embedded' or 'server'.`);
}
```

#### 模式对比

| 维度 | 嵌入式 (embedded) | 服务化 (server) |
|---|---|---|
| Agent 位置 | 同一容器内 | 可以在任何地方 |
| 部署复杂度 | 单容器 | 沙箱服务 + Agent 容器 |
| 延迟 | 最低（进程内） | +2-5ms HTTP |
| 多 Agent 共享 | ❌ 不可能 | ✅ 天然支持 |
| FUSE 权限 | 容器需要 SYS_ADMIN | 只需沙箱容器 |
| 适合场景 | 单用户、开发测试 | 多用户、生产部署 |

### C.5 完整架构图（合并后）

```
                         ┌──────────────────────────────────┐
                         │       沙箱服务容器 (server 模式)    │
                         │                                  │
                         │  Fastify :7801                   │
                         │  POST /v1/bash { command }       │
                         │    ↓                             │
                         │  Command Optimizer Registry      │
                         │    ├── GrepOptimizer (P0)        │
                         │    ├── FindOptimizer (P1)        │
                         │    ├── TreeOptimizer (P1)        │
                         │    └── ...                       │
                         │    ↓ (if matched)                │
                         │  Optimized: 2 次 DB 查询          │
                         │    ↓ (if not matched)            │
                         │  spawn("/bin/bash")              │
                         │    ↓                             │
                         │  Linux VFS → FUSE 回调层          │
                         │    ↓                             │
                         │  VectorStore 接口                │
                         │    ↓                             │
                         │  ┌────────┐ ┌────────┐ ┌───────┐ │
                         │  │ SQLite │ │ Chroma │ │  PG   │ │
                         │  │ 本地   │ │本地/远程│ │ 远程  │ │
                         │  └────────┘ └────────┘ └───────┘ │
                         └──────────┬───────────────────────┘
                                    │ HTTP POST /v1/bash
           ┌────────────────────────┼─────────────────────────┐
           ▼                        ▼                          ▼
  ┌────────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │ Agent A 容器    │    │ Agent B 容器      │    │ Agent C (本地)    │
  │ CrewAI         │    │ LangChain/LangGraph│    │ Claude Agent SDK │
  │ SandboxBashTool│    │ @tool vfs_bash    │    │ Custom tool hook │
  └────────────────┘    └──────────────────┘    └──────────────────┘
```

### C.6 实施计划

#### P1 — 沙箱服务化（Agent 解耦）

| 步骤 | 任务 | 文件 | 预计工作量 |
|---|---|---|---|
| 1 | 改造 `server.ts` 支持 FUSE mount | `src/server.ts` | 1.5h |
| 2 | 集成 Command Optimizer 到 server | `src/server.ts` | 30min |
| 3 | 添加优雅关闭（unmount + close） | `src/server.ts` | 30min |
| 4 | 更新 `docker-compose.yml` 端口映射 | `docker-compose.yml` | 15min |
| 5 | 创建 Python Agent 示例 | `examples/langchain-sandbox/` | 1h |
| 6 | Docker 测试：从外部容器调沙箱 | 测试脚本 | 1h |
| **总计** | | | **~4.5h** |

#### P2 — PostgreSQL 后端（多实例共享）

| 步骤 | 任务 | 文件 | 预计工作量 |
|---|---|---|---|
| 1 | 实现 `PostgresVectorStore` | `src/backend/postgres.ts` | 2h |
| 2 | 添加 pgvector 向量搜索支持 | `src/backend/postgres.ts` | 1h |
| 3 | 更新 `factory.ts` 支持 postgres | `src/backend/factory.ts` | 30min |
| 4 | 添加 postgres 到 docker-compose | `docker-compose.yml` | 30min |
| 5 | 测试多实例共享 | 测试脚本 | 1h |
| **总计** | | | **~5h** |

#### P3 — 两种模式并存

| 步骤 | 任务 | 文件 | 预计工作量 |
|---|---|---|---|
| 1 | 添加 `VFS_MODE` 环境变量支持 | `src/agent/main.ts` | 30min |
| 2 | 文档更新 | `DEVELOPER_HANDOFF.md` | 30min |
| **总计** | | | **~1h** |

### C.7 设计决策记录

#### 为什么不在 FUSE 层直接暴露 HTTP？

因为 FUSE 是内核协议，HTTP 是应用层协议。FUSE 回调在用户态的 Node.js 进程中执行，它本身不知道 HTTP 的存在。HTTP 层应该在 FUSE 之上，作为 Agent 的接入点。

#### 为什么推荐 PostgreSQL 而不是扩展 SQLite 的远程能力？

SQLite 的并发写入模型（WAL 模式）不适合网络文件系统。PostgreSQL 原生支持 TCP 连接和并发写入，是更正确的选择。

#### 为什么 HTTP 跳转的延迟可以忽略？

因为 FUSE + 数据库查询的延迟是毫秒到秒级别，而 HTTP 本地网络跳转只有 2-5ms。真正的性能瓶颈在数据库查询（所以才有 Command Optimizer），不在网络层。

#### Agent 侧的 HTTP Bash Tool 安全吗？

当前设计假设沙箱服务和 Agent 在同一个可信网络内（如 Docker 内部网络）。生产部署可以加 API Key 认证或 JWT token 验证。这是 RBAC 层（M3）的职责，不是当前解耦架构的核心问题。
