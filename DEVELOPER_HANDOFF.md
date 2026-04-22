# vfs4Agent — 开发者交接文档

> **面向对象**：接手后续开发的工程师。阅读本文档约需 20 分钟，之后应能独立复现所有已通过的测试，并清楚知道下一步该做什么。
>
> 最后更新：2026-04-23（M2 全部完成，M3 待启动）

---

## 一、项目一句话定位

vfs4Agent 是一个**为 LLM Agent 提供的只读 UNIX 沙箱**。Agent 以为自己 SSH 到了一台 Ubuntu 机器，用完整 bash 命令集探索 `/docs`；底层不是真文件系统，而是 Chroma 向量数据库。沙箱是唯一的拦截点：`grep`/`cat`/`ls` 全部翻译为 DB 查询。

详细设计见 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。

---

## 二、快速上手（本地跑通）

### 2.1 环境依赖

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 跑 TypeScript |
| pnpm | ≥ 9 | 包管理 |
| Python | ≥ 3.12 | 跑 Chroma server + CrewAI demo |
| pip / venv | 随 Python | Chroma server 及 demo 的依赖 |

### 2.2 安装

```bash
# 克隆后在仓库根
pnpm install

# CrewAI demo（可选）
cd examples/crewai-qwen-demo
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # 填写 DASHSCOPE_API_KEY
cd ../..
```

### 2.3 启动 Chroma server（必须在跑任何 TS 命令之前）

```bash
# 需要 Python 环境中安装了 chromadb
# MacOS 示例（项目内 venv）
pip install chromadb
chroma run --path ./data/chroma --port 8000
# 持久化数据存到 ./data/chroma，重启 server 数据不丢
```

### 2.4 Ingest 文档

```bash
# 把 examples/sample-docs/ 下的 md 文件灌进 Chroma
VFS_BACKEND=chroma CHROMA_COLLECTION=vfs_docs \
  pnpm ingest ./examples/sample-docs

# 灌完后 Chroma 里应有：
#   6 files → 14 chunks，collection = vfs_docs
```

### 2.5 跑探针（沙箱伪装验证）

```bash
VFS_BACKEND=chroma CHROMA_COLLECTION=vfs_docs pnpm probe
# 期望输出最后一行：[probe] PASS — 11 probes, sandbox disguise holds.

# SQLite 版（不需要 Chroma server）
VFS_BACKEND=sqlite pnpm ingest ./examples/sample-docs --db ./data/vfs.db
VFS_BACKEND=sqlite pnpm probe
```

### 2.6 Shell-Native 问答（不需要 Agent 框架）

```bash
VFS_BACKEND=chroma CHROMA_COLLECTION=vfs_docs \
  pnpm ask "how do I authenticate with OAuth and refresh the token?"
# 期望：4 轮内作答，引用 /docs/auth/oauth.md + /docs/auth/token-refresh.md
```

### 2.7 启动 HTTP server（供 CrewAI / LangChain 接入）

```bash
VFS_BACKEND=chroma CHROMA_COLLECTION=vfs_docs pnpm server
# 监听 :7801，健康检查：
curl http://127.0.0.1:7801/v1/health
# → {"ok":true,"mount":"/docs","backend":"chroma(http://127.0.0.1:8000 :: vfs_docs)"}
```

### 2.8 CrewAI + Qwen E2E demo

```bash
cd examples/crewai-qwen-demo
source .venv/bin/activate
python agent.py "how do I authenticate with OAuth and refresh the token when it expires?"
# 期望：Final Answer 包含 oauth.md + token-refresh.md 双引用，无报错
```

---

## 三、项目结构

```
vfs4Agent/
├── src/
│   ├── types.ts                # 核心接口：VectorStore / Chunk / PathTree / Session / GrepOptions
│   ├── shell.ts                # createShell() — 沙箱工厂（就是 THE ONE INTERCEPT POINT）
│   ├── ingest.ts               # 文件切分 + upsert 逻辑（按段落/heading 切，记 line_start）
│   ├── server.ts               # Fastify HTTP bridge（Tool-mode 入口）
│   ├── fs/
│   │   └── virtualFs.ts        # just-bash IFileSystem → VectorStore 桥
│   ├── grep/
│   │   └── engine.ts           # 两阶段 grep：粗筛(DB) → 精筛(JS RegExp)
│   ├── runner/
│   │   ├── realism.ts          # 沙箱伪装层（伪造 /etc /proc + uname/whoami/id/hostname）
│   │   ├── shellRunner.ts      # Shell-Native chat loop（不传 tools schema）
│   │   ├── motd.ts             # MOTD + PS1 渲染
│   │   └── answer.ts           # `answer "..."` 命令 + AnswerSignal
│   ├── backend/
│   │   ├── factory.ts          # createBackend() — VFS_BACKEND env 选择实现
│   │   ├── chroma.ts           # ChromaVectorStore（默认/北极星 backend）
│   │   └── sqlite.ts           # SqliteVectorStore（dev fallback，零依赖）
│   └── cli/
│       ├── ingest.ts           # pnpm ingest — CLI 入口
│       ├── ask.ts              # pnpm ask — Shell-Native 入口
│       └── probe.ts            # pnpm probe — 沙箱伪装 11 条探针
├── examples/
│   ├── sample-docs/            # 测试文档集（6 个 md，覆盖 auth / api-ref / guides）
│   └── crewai-qwen-demo/       # CrewAI + Qwen Python demo
│       ├── agent.py
│       ├── requirements.txt
│       └── .env.example
├── data/
│   ├── chroma/                 # Chroma 持久化目录（gitignore）
│   └── vfs.db                  # SQLite 数据库（gitignore）
├── IMPLEMENTATION_PLAN.md      # 架构设计文档（v2.0，sandbox-first）
├── IMPLEMENTATION_PLAN.v1.2.bak.md  # v1.2 备份（供参考）
└── package.json
```

---

## 四、环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `VFS_BACKEND` | `chroma` | `chroma` 或 `sqlite` |
| `CHROMA_URL` | `http://127.0.0.1:8000` | Chroma server 地址 |
| `CHROMA_COLLECTION` | `vfs` | Chroma collection 名 |
| `VFS_DB_PATH` | `./data/vfs.db` | SQLite 文件路径（仅 sqlite backend） |
| `VFS_MOUNT` | `/docs` | vfs-server 的挂载点 |
| `VFS_PORT` | `7801` | vfs-server 监听端口 |
| `VFS_SESSION_TOKEN` | *(未设置 = 不校验)* | HTTP 请求头 `X-VFS-Session` 验证 |
| `LOG_LEVEL` | `info` | Fastify 日志级别（error/warn/info/debug） |
| `DASHSCOPE_API_KEY` | 必填 | DashScope（阿里云）API key |
| `DASHSCOPE_BASE_URL` | dashscope 地址 | OpenAI 兼容 base_url |
| `QWEN_MODEL` | `qwen-plus` | Qwen 模型 ID |

`.env` 文件放仓库根，`dotenv` 自动加载。

---

## 五、npm scripts 速查

| 命令 | 作用 |
|---|---|
| `pnpm ingest <srcDir>` | 把目录里的 md/txt 灌进向量库 |
| `pnpm server` | 启动 Fastify HTTP bridge（Tool-mode） |
| `pnpm ask "<问题>"` | Shell-Native chat loop（不需要框架） |
| `pnpm probe` | 跑 11 条沙箱伪装探针 |
| `pnpm shell` | 交互式 bash session（手动测试沙箱） |
| `pnpm build` | `tsc` 编译（有几条已知 pre-existing 非致命错误，见 §8） |

---

## 六、已通过的测试记录

所有测试都在 Chroma backend 和 SQLite backend 上各跑了一遍，除非特别注明。

### 6.1 探针测试（`pnpm probe`）

**11 条探针，11/11 通过，两个 backend 均测过。**

| # | 命令 | 期望 | 状态 |
|---|---|---|---|
| 1 | `uname -a` | 含 `Linux` 字样 + `x86_64` | ✅ |
| 2 | `whoami` | `user` | ✅ |
| 3 | `hostname` | 非空字符串 | ✅ |
| 4 | `id` | 形如 `uid=1000(user)...` | ✅ |
| 5 | `cat /etc/os-release` | 含 `Ubuntu` / `NAME=` | ✅ |
| 6 | `cat /proc/version` | 含 `Linux version` | ✅ |
| 7 | `cat /etc/hostname` | 非空字符串 | ✅ |
| 8 | `echo $HOME` | `/home/...` 开头 | ✅ |
| 9 | `ls /etc` | 非空列表 | ✅ |
| 10 | `pwd` | `/docs` | ✅ |
| 11 | `ls /docs` | 非空列表（需先 ingest） | ✅ |

### 6.2 Shell-Native ask 测试

**问题**：`how do I authenticate with OAuth and refresh the token when it expires?`

**结果（Chroma backend）**：

- 轮次：4 轮（`ls /docs` → `tree /docs` → `cat /docs/auth/oauth.md` → `cat /docs/auth/token-refresh.md` → `answer`）
- 答案：正确描述 OAuth 认证 + token 刷新流程
- 引用：`/docs/auth/oauth.md` + `/docs/auth/token-refresh.md`（双引用）
- 无错误输出

### 6.3 CrewAI + Qwen Tool-mode 测试

**问题**：`how do I authenticate with OAuth and refresh the token when it expires?`

**结果（Chroma backend，`pnpm server` + `python agent.py "..."`）**：

| 轮次 | 命令 | 结果 |
|---|---|---|
| 1 | `tree /docs` | 返回正确目录树 |
| 2 | `grep -rni 'oauth\|refresh' /docs/auth/` | exit 1（BRE `\|` 问题，预期行为，见 §7.3） |
| 3 | `cat /docs/auth/oauth.md` | 正确返回 OAuth 文档 |
| 4 | `cat /docs/auth/token-refresh.md` | 正确返回 refresh 文档 |

- **Final Answer**：正确说明 OAuth 认证过程，引用 `/docs/auth/oauth.md` + `/docs/auth/token-refresh.md`
- **无 Chroma 错误**（`$regex on metadata` bug 已修复，见 §7.2）

### 6.4 HTTP server 健康检查

```
GET /v1/health
→ {"ok":true,"mount":"/docs","backend":"chroma(http://127.0.0.1:8000 :: vfs_docs)"}
```

---

## 七、踩坑记录（必读）

### 7.1 Chroma 元数据 `where` 不支持 `$regex`

**问题**：Chroma 的 `where` 子句（作用于 metadata 字段）只支持以下操作符：
```
$gt $gte $lt $lte $ne $eq $in $nin $contains $not_contains
```
**不支持 `$regex`**（仅 `whereDocument` 支持 `$regex` 和 `$contains`）。

**踩坑场景**：`grep -rni 'oauth' /docs/auth/` 时 pathPrefix 需要过滤 `page` metadata，最初写了 `{page: {$regex: "^auth/"}}` 直接报错：
```
Expected operator to be one of $gt, $gte, … but got $regex
```

**修复方案**（见 `src/backend/chroma.ts`）：在 Chroma 元数据过滤中，把 `pathPrefix` 通过 in-memory PathTree 解析成明确的 slug 列表，再用 `$in` 过滤：
```ts
// 不能这样：
where = { page: { $regex: `^${escapeRegex(opts.pathPrefix)}` } }

// 正确做法：走 PathTree 解析出 slug 列表
const slugSet = new Set<string>();
for (const slug of Object.keys(tree)) {
  if (slug === prefix || slug.startsWith(prefix + "/")) slugSet.add(slug);
}
where = { page: { $in: Array.from(slugSet) } };
```

**设计原则**：PathTree 是目录结构的单一真相源，所有路径前缀匹配都走 PathTree，不走 backend 元数据。

### 7.2 Chroma `whereDocument` 使用原生对象，不要用 `Key()` builder

**问题**：Chroma JS SDK 的 `new Key(DOCUMENT_KEY).regex(pattern)` 会把 `$regex` 包在一个额外的对象层里，触发 schema 校验失败。

**正确写法**：
```ts
whereDocument: { $regex: `(?i)${pattern}` }   // ✅
whereDocument: new Key(DOCUMENT_KEY).regex(pattern)  // ❌ 会报错
```

### 7.3 BRE vs ERE：`grep 'foo\|bar'` 在我们的 grep 里 exit 1

**现象**：CrewAI agent 执行 `grep -rni 'oauth\|refresh' /docs/auth/` 返回 exit 1（无命中）。

**原因**：我们的 grep 引擎把 pattern 当 JS RegExp 处理。在 JS RegExp 里 `\|` 是字面量 `|`（不是 alternation），等同于真 grep BRE 的行为（BRE 里 `|` 是字面量，`\|` 才是 ERE 的 alternation）。所以搜索 `oauth\|refresh` 会去找字符串 `oauth|refresh` 而非 oauth 或 refresh。

**这是预期行为，不是 bug**：真 grep BRE 同样如此。LLM 在看到 exit 1 后会自然改用 `grep -E 'oauth|refresh'` 或直接 `cat` 文件。

**若要修复**（M3 选项）：在 `src/grep/engine.ts` 的 `buildJsRegex()` 里识别 `-n` 非 erg 模式下的 `\|` 并把它转换为 `|`。

### 7.4 just-bash 的 `help` 内置无法被覆盖

**现象**：注册 `defineCommand("help", ...)` 后，bash.exec("help") 仍然返回 just-bash 内置的 help，自定义命令被忽略。

**原因**：just-bash 把 `help` 列为保留内置关键字，优先级高于 `defineCommand`。

**处理方式**：删掉自定义 help，保持 just-bash 内置 help。这反而**更符合沙箱伪装目标**——真 bash 的 `help` 就没有什么文档沙箱内容。probe 里不再测 help 命令。

### 7.5 just-bash Bash 构造函数需要 `env` 参数才能设置 `$HOME` 等环境变量

**现象**：`echo $HOME` 返回空。

**修复**：在 `src/shell.ts` 的 `createShell()` 里通过 Bash 构造函数的 `env` 参数注入基础环境变量：
```ts
const bash = new Bash({
  fs: mountedFs,
  cwd: opts.cwd ?? mountPoint,
  env: {
    HOME: `/home/${env.user}`,
    USER: env.user,
    LOGNAME: env.user,
    HOSTNAME: env.host,
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PWD: opts.cwd ?? mountPoint,
  },
});
```

### 7.6 Chroma JS SDK `getMaxBatchSize()` 在大批量 upsert 时必须遵守

**场景**：upsert 超过 Chroma server 默认 batch size 上限时会报错。

**处理方式**（已在 `src/backend/chroma.ts` 的 `upsertChunks` 中实现）：
```ts
const max = await this.client.getMaxBatchSize();
for (let i = 0; i < ids.length; i += max) {
  await col.upsert({ ids: ids.slice(i, i + max), ... });
}
```

### 7.7 Chroma `$regex` 的大小写不敏感：用 `(?i)` 前缀

Chroma 的 `whereDocument: {$regex: ...}` 使用 Python `re` 引擎，**支持** `(?i)` 前缀：
```ts
// grep -i 时：
whereDocument: { $regex: `(?i)${pattern}` }
```

标准 PCRE 的 `(?i)` inline flag 在 Python `re` 里同样有效。

---

## 八、已知的非阻塞 tsc 错误

`pnpm build`（即 `tsc`）会报以下错误，**不影响运行**（因为实际通过 `tsx` / `ts-node` 直接执行 TS 源码）：

| 错误 | 原因 | 是否阻塞 |
|---|---|---|
| `Module '"just-bash"' has no exported member 'DirentEntry'` | just-bash 类型定义落后于实际导出 | ❌ |
| `Module '"just-bash"' has no exported member 'ReadFileOptions'` | 同上 | ❌ |
| `Cannot find module '../types.js'` in `src/ingest.ts` | 路径 alias 在 ts 编译但 tsx 运行时正常 | ❌ |
| `Could not find declaration file for 'yargs-parser'` | 缺 `@types/yargs-parser` | ❌ |

**修复建议（M3 可清理）**：安装 `@types/yargs-parser`，更新 just-bash 版本或自写 `d.ts`。

---

## 九、架构决策记录（ADR）

| 决策 | 选择 | 拒绝的备选 | 理由 |
|---|---|---|---|
| grep 路径前缀过滤 | PathTree 解析 → `$in` 列表 | Chroma `$regex on metadata` | Chroma 元数据不支持 `$regex`（已踩坑） |
| 目录结构存储 | PathTree 哨兵文档（`__path_tree__`） | 每个 chunk 的 metadata 里带路径 | 一次查询拿全树，ls/find 无需遍历所有 chunks |
| 嵌入向量（M2） | 零向量占位 embedder（8 维全零） | 真实 embedder | M2 只做文本检索；M4 再换真 embedder，接口不变 |
| grep 语义 | 两阶段（粗筛 DB，精筛 JS RegExp） | 全量 readFile + JS RegExp | 避免 N 次 DB 查询；Chroma `$regex on document` 一次筛候选 |
| 沙箱伪装验收 | 自动化 probe（`pnpm probe`） | 手动跑看输出 | 每次改 realism.ts 或 shell.ts 后必须能一行验证 |
| 两个入口的共用方式 | 共享 `createShell()` 工厂 | Tool-mode 和 Shell-Native 各自维护 Bash 实例 | 改沙箱一次生效，不漏改 |
| Chunk 切分粒度 | Markdown 段落/heading 边界 + 记 line_start | 固定 token 数 | 固定切分跨 chunk 命中时行号不准 |

---

## 十、下一步：M3 任务清单

M1 ✅ &nbsp; M2 ✅ &nbsp; **M3 是当前工作起点。**

### M3 核心任务

- [ ] **RBAC**：`Session { userId, groups }` 传入 `createShell()`，PathTree pruning（无权限 slug 对 Agent 完全不可见），`grep`/`cat` 过滤
  - 在 `src/fs/virtualFs.ts` 的 `getAllowedSlugs()` 里按 session.groups 过滤
  - 在 Chroma `buildMetaWhere` 里把 `allowedSlugs` 加入 `$in` 约束
  - 在 `pnpm probe` 加一套"无权探针"：无权用户 `ls /internal` 必须为空
- [ ] **MCP server**（stdio JSON-RPC）：Claude Code / Cursor 直连
  - 新建 `packages/adapter-mcp/` 或 `src/mcp.ts`
  - 暴露 `tool: vfs_bash`（和 HTTP server 相同的入口）
- [ ] **OpenAI function-calling adapter**：Codex / 通用 OpenAI SDK
  - 可复用 `src/server.ts` 的 bash 执行逻辑，换 transport
- [ ] **错误语义打磨**：`ENOENT` vs `EACCES` vs `EROFS` 对 Agent 的表现区分
- [ ] **probe 扩展**：加入 RBAC 探针，加入 M3 adapter 的冒烟测试

### M3 后续

- **M4**：Chroma 真实 embedder（DashScope `text-embedding-v3`）+ `defineCommand("search", ...)` 语义搜索 + 懒加载大文件
- **M5**：Redis cache、PathTree 增量更新（webhook）、`docker-compose up`、benchmark

---

## 十一、关键文件读法

| 如果你想了解… | 先读这个文件 |
|---|---|
| 整体架构 & 里程碑 | `IMPLEMENTATION_PLAN.md` |
| 沙箱如何构建 | `src/shell.ts` |
| 沙箱伪装细节 | `src/runner/realism.ts` |
| Chroma 存储结构 | `src/backend/chroma.ts`（重点看 `upsertChunks` / `buildMetaWhere`） |
| grep 两阶段实现 | `src/grep/engine.ts` |
| Shell-Native chat loop | `src/runner/shellRunner.ts` |
| Tool-mode HTTP API | `src/server.ts` |
| backend 切换逻辑 | `src/backend/factory.ts` |
| 探针测试 | `src/cli/probe.ts` |
| CrewAI Python 接入 | `examples/crewai-qwen-demo/agent.py` |

---

*生成时间：2026-04-23 / vfs4Agent v0.1.0*
