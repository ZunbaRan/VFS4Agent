# vfs4Agent 部署与使用指南

> 适用版本：`feat/provider-plugin-system` 分支（v0.2.0）

---

## 目录

1. [架构快览](#1-架构快览)
2. [前置要求](#2-前置要求)
3. [安装](#3-安装)
4. [数据库配置](#4-数据库配置)
   - [方案 A：SQLite（零依赖，推荐本地开发）](#方案-a-sqlite-零依赖推荐本地开发)
   - [方案 B：Chroma（外置 HTTP 服务，推荐生产）](#方案-b-chroma-外置-http-服务推荐生产)
5. [导入文档数据（ingest）](#5-导入文档数据ingest)
6. [启动服务](#6-启动服务)
   - [模式一：单数据源（env 方式）](#模式一单数据源-env-方式)
   - [模式二：多数据源（配置文件方式）](#模式二多数据源-配置文件方式)
7. [vfs.config.yaml 完整参考](#7-vfsconfigyaml-完整参考)
8. [编写自定义 Provider](#8-编写自定义-provider)
   - [最小模板](#最小模板)
   - [完整接口说明](#完整接口说明)
   - [注册到配置文件](#注册到配置文件)
   - [本地调试（无 FUSE）](#本地调试无-fuse)
9. [Docker 部署（Linux / 生产环境）](#9-docker-部署linux--生产环境)
10. [Agent 接入](#10-agent-接入)
11. [环境变量速查](#11-环境变量速查)
12. [常见问题](#12-常见问题)

---

## 1. 架构快览

```
Agent（LangChain / Claude SDK / CrewAI / 任意 HTTP 客户端）
        │  POST /v1/bash  {"command": "ls /vfs/docs/"}
        ▼
┌─────────────────────────────────────────────┐
│  vfs4Agent HTTP Server  (src/server.ts)     │
│  Fastify  :7801                             │
└─────────────────┬───────────────────────────┘
                  │
         ┌────────▼────────┐
         │   MountRouter   │   ← 统一路由层
         └──┬──────────┬───┘
     /docs  │          │  /crm  （或任意前缀）
   ┌─────────▼─┐   ┌────▼──────────┐
   │ VectorStore│   │ 自定义Provider│
   │  Provider  │   │ (REST/SQL/…) │
   └─────────┬──┘   └──────────────┘
             │
    SQLite / Chroma
```

**核心组件：**
- **VfsProvider**：任何数据源的统一接口，5 个方法
- **MountRouter**：把多个 Provider 合并成一棵虚拟树，对上层透明
- **FUSE 层**：在 Linux 上把虚拟树挂载为真实文件系统（macOS 仅可跑单元测试）

---

## 2. 前置要求

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | 需要原生 `fetch` 与 `--test` |
| pnpm | ≥ 9 | `corepack enable && corepack prepare pnpm@latest --activate` |
| FUSE（Linux 实际挂载） | libfuse 2 | `apt install fuse libfuse2 libfuse-dev` |
| Docker（推荐生产） | ≥ 24 | 需要 `SYS_ADMIN` capability 和 `/dev/fuse` |
| Chroma（可选） | ≥ 0.5 | 仅在使用 Chroma 后端时需要 |

> **macOS 开发说明**：fuse-native 不支持 macOS，无法实际挂载 FUSE。
> 但 Provider 开发、单元测试、HTTP server 模式均可在 macOS 正常运行。
> 需要验证 FUSE 挂载的工作请使用 Docker（见第 9 节）。

---

## 3. 安装

```bash
git clone https://github.com/ZunbaRan/VFS4Agent.git
cd vfs4Agent
git checkout feat/provider-plugin-system   # 或对应的已合并分支

pnpm install
pnpm build     # 编译 TypeScript → dist/
pnpm test      # 运行 35 个单元测试，全绿后再继续
```

---

## 4. 数据库配置

### 方案 A：SQLite（零依赖，推荐本地开发）

SQLite 是默认后端，不需要额外安装任何服务。数据库文件自动创建。

```bash
# 指定数据库路径（也可以不设，默认 ./data/vfs.db）
export VFS_BACKEND=sqlite
export VFS_DB_PATH=./data/vfs.db
```

特性：
- 内置 FTS5 全文搜索（支持 `grep -r` 优化）
- 支持正则匹配（REGEXP SQL 函数）
- 单文件，方便备份和迁移
- 不支持多进程并发写入

---

### 方案 B：Chroma（外置 HTTP 服务，推荐生产）

**Step 1：启动 Chroma 服务**

```bash
# 用 Docker 最省事
docker run -d \
  --name chroma \
  -p 8000:8000 \
  -v $(pwd)/data/chroma:/chroma/chroma \
  chromadb/chroma:latest

# 验证
curl http://localhost:8000/api/v1/heartbeat
# {"nanosecond heartbeat": <timestamp>}
```

或用 pip 直接启动：
```bash
pip install chromadb
chroma run --path ./data/chroma --host 0.0.0.0 --port 8000
```

**Step 2：配置环境变量**

```bash
export VFS_BACKEND=chroma
export CHROMA_URL=http://localhost:8000
export CHROMA_COLLECTION=vfs_docs    # collection 名称，不存在会自动创建
```

特性：
- 支持向量语义搜索（未来扩展）
- 支持多实例水平扩展
- 网络延迟高于 SQLite，ingest 速度较慢

---

## 5. 导入文档数据（ingest）

> **注意**：ingest 只适用于内置的 `builtin:vector-store` 后端（SQLite / Chroma）。
> 自定义 Provider 的数据由 Provider 自己管理，不需要 ingest。

**基础用法：**

```bash
# SQLite 后端
VFS_BACKEND=sqlite pnpm ingest ./docs/sample-docs --db ./data/vfs.db

# Chroma 后端
VFS_BACKEND=chroma CHROMA_URL=http://localhost:8000 CHROMA_COLLECTION=vfs_docs \
  pnpm ingest ./docs/sample-docs
```

**命令参数：**

```
tsx src/cli/ingest.ts <srcDir> [选项]

<srcDir>            要导入的本地目录，递归处理所有 .md/.mdx/.txt/.rst 文件

--db PATH           SQLite 数据库路径（默认 ./data/vfs.db）
--prefix SLUG       在 VFS 内的路径前缀，例如 "docs" 会让文件出现在 /vfs/docs/
--max-bytes N       每个 chunk 最大字节数（默认 4000）
```

**多目录分前缀导入：**

```bash
# 将 ./api-docs 挂到 /vfs/api/，./user-guide 挂到 /vfs/guide/
VFS_BACKEND=sqlite pnpm ingest ./api-docs   --prefix api   --db ./data/vfs.db
VFS_BACKEND=sqlite pnpm ingest ./user-guide --prefix guide --db ./data/vfs.db
```

**验证导入结果：**

```bash
# 启动开发服务器后用 curl 验证
curl -s -X POST http://localhost:7801/v1/bash \
  -H "Content-Type: application/json" \
  -d '{"command": "ls /vfs/"}' | jq .stdout
```

---

## 6. 启动服务

### 模式一：单数据源（env 方式）

适用于只有一个数据库后端的场景，兼容所有历史配置。

```bash
# SQLite
VFS_BACKEND=sqlite VFS_DB_PATH=./data/vfs.db pnpm server

# Chroma
VFS_BACKEND=chroma \
  CHROMA_URL=http://localhost:8000 \
  CHROMA_COLLECTION=vfs_docs \
  pnpm server

# 自定义端口、挂载点
VFS_PORT=8801 VFS_MOUNT=/mnt/vfs VFS_BACKEND=sqlite pnpm server
```

成功启动后输出：
```
[server] backend=sqlite(./data/vfs.db)
[server] optimizers=none
[server] mounting FUSE at /vfs...
[server] FUSE mounted.
[server] listening on :7801
```

---

### 模式二：多数据源（配置文件方式）

当需要同时挂载多个数据源时，使用 `VFS_CONFIG` 指向配置文件。

**Step 1：创建 `vfs.config.yaml`**（参考第 7 节）

**Step 2：启动**

```bash
VFS_CONFIG=./vfs.config.yaml pnpm server
```

输出示例（两个 Provider）：
```
[server] loading providers from ./vfs.config.yaml
[server] backend=config:docs@/docs,crm@/crm
[server] FUSE mounted.
[server] listening on :7801
```

此时 Agent 看到的文件树是：
```
/vfs/
  docs/           ← builtin:vector-store（SQLite/Chroma）
    auth/
    guides/
  crm/            ← 自定义 Provider
    accounts/
    contacts/
```

---

## 7. vfs.config.yaml 完整参考

```yaml
# vfs.config.yaml
# 用法：VFS_CONFIG=./vfs.config.yaml pnpm server
#
# 环境变量插值：${NAME} 或 ${NAME:默认值}
# 严格模式：缺少变量且无默认值时启动报错

providers:

  # ── 内置：SQLite 后端 ──────────────────────────────────────────────────
  - name: docs                    # 日志和错误中使用的标识符
    mountPrefix: /docs            # VFS 挂载点，必须以 / 开头
    driver: builtin:vector-store
    config:
      backend: sqlite
      path: ${VFS_SQLITE_PATH:./data/vfs.db}

  # ── 内置：Chroma 后端（同时挂载两个 DB 是合法的）────────────────────
  - name: api-docs
    mountPrefix: /api
    driver: builtin:vector-store
    config:
      backend: chroma
      # backend 配置从环境变量读取，不在这里写
      # CHROMA_URL 和 CHROMA_COLLECTION 仍然走 process.env

  # ── 外部 Provider（相对路径，从此文件所在目录解析）─────────────────
  - name: crm
    mountPrefix: /crm
    driver: ./providers/crm-provider.ts   # 或 .js
    config:
      baseUrl: ${CRM_BASE_URL}
      apiKey: ${CRM_API_KEY}
      ttlMs: 60000

  # ── npm 包形式的 Provider ──────────────────────────────────────────────
  - name: jira
    mountPrefix: /tickets
    driver: npm:vfs4agent-jira-provider
    config:
      host: ${JIRA_HOST}
      token: ${JIRA_TOKEN}
      project: MYPROJ

# 命名约束：
#   - name 不能重复
#   - mountPrefix 不能重复
#   - mountPrefix 为 "/" 时不能有其他 provider（根挂载独占）
```

**根挂载模式**（单个 Provider 挂载到根，兼容旧行为）：

```yaml
providers:
  - name: docs
    mountPrefix: /       # 根挂载，路径直接从 /vfs/ 开始
    driver: builtin:vector-store
    config:
      backend: sqlite
      path: ./data/vfs.db
```

---

## 8. 编写自定义 Provider

### 最小模板

创建文件 `./my-provider.ts`：

```typescript
import { defineProvider, VfsError } from "vfs4agent/src/provider/types.js";
// 或用相对路径引用本仓库的类型：
// import { defineProvider, VfsError } from "./src/provider/types.js";

export default defineProvider({
  name: "my-provider",
  mountPrefix: "/my",   // 会被 vfs.config.yaml 中的 mountPrefix 覆盖

  // 列出目录内容
  async readdir(subpath, ctx) {
    if (subpath === "/") {
      return [
        { name: "README.md", type: "file" },
        { name: "data",      type: "dir"  },
      ];
    }
    throw new VfsError("ENOENT", subpath);
  },

  // 读取文件内容
  async read(subpath, ctx) {
    if (subpath === "/README.md") {
      return { content: "# Hello from My Provider\n", mime: "text/markdown" };
    }
    throw new VfsError("ENOENT", subpath);
  },

  // 返回文件/目录元信息
  async stat(subpath, ctx) {
    if (subpath === "/") return { type: "dir",  size: 0,  mtime: Date.now() };
    if (subpath === "/README.md") return { type: "file", size: 30, mtime: Date.now() };
    throw new VfsError("ENOENT", subpath);
  },
});
```

然后在 `vfs.config.yaml` 中注册：

```yaml
providers:
  - name: my
    mountPrefix: /my
    driver: ./my-provider.ts
```

---

### 完整接口说明

```typescript
interface VfsProvider {
  // ── 必须实现 ───────────────────────────────────────────────

  readonly name: string;        // 标识符，日志用
  readonly mountPrefix: string; // 如 "/docs"，会被 config 覆盖

  // 列出 subpath 下一级的直接子项
  // subpath 总是以 "/" 开头，例如 "/" 或 "/users" 或 "/users/1"
  readdir(subpath: string, ctx: VfsContext): Promise<DirEntry[]>;

  // 返回文件的文本内容（不支持二进制）
  // subpath 指向一个文件，如果指向目录应 throw VfsError("EISDIR")
  read(subpath: string, ctx: VfsContext): Promise<ReadResult>;

  // 返回元信息（文件还是目录、大小、修改时间）
  stat(subpath: string, ctx: VfsContext): Promise<FileStat>;

  // ── 可选实现 ───────────────────────────────────────────────

  // 搜索。返回 null 表示"我不支持，让 router 退回到逐文件扫描"。
  // 返回空数组 [] 表示"我支持，但没有匹配结果"。
  search?(req: SearchRequest, ctx: VfsContext): Promise<SearchHit[] | null>;

  // 进程退出时调用，用来关闭连接池等
  close?(): Promise<void>;
}
```

**DirEntry：**
```typescript
interface DirEntry {
  name: string;           // 文件/目录名（不含路径）
  type: "file" | "dir";
  size?: number;          // 字节数（可选，提高 getattr 性能）
  mtime?: number;         // Unix 毫秒时间戳
}
```

**ReadResult：**
```typescript
interface ReadResult {
  content: string;        // 文件文本内容
  mime?: string;          // 默认 "text/plain"，推荐 "text/markdown"
  size?: number;          // 若省略则自动按 UTF-8 字节数计算
  mtime?: number;
}
```

**FileStat：**
```typescript
interface FileStat {
  type: "file" | "dir";
  size: number;           // 目录可以写 0
  mtime: number;          // Unix 毫秒时间戳
}
```

**VfsError 错误码：**

| 错误码 | 含义 | 何时使用 |
|---|---|---|
| `ENOENT` | 路径不存在 | 最常用，路径找不到时 |
| `EISDIR` | 路径是目录 | read() 收到目录路径时 |
| `ENOTDIR` | 路径不是目录 | readdir() 收到文件路径时 |
| `EACCES` | 无权限 | ctx 里的用户无权访问 |
| `EIO` | I/O 错误 | 上游 API 故障、网络超时等 |

---

### 注册到配置文件

```yaml
providers:
  - name: my-crm          # 自定义名称
    mountPrefix: /crm     # Agent 看到的挂载路径
    driver: ./providers/crm-provider.ts   # 相对于 vfs.config.yaml 所在目录
    config:               # 作为 spec.config 对象传入 Provider 工厂
      baseUrl: ${CRM_BASE_URL}
      pageSize: 50
```

**Driver 路径规则：**

| 写法 | 解析方式 |
|---|---|
| `./relative/path.ts` | 相对于 vfs.config.yaml 的目录 |
| `/absolute/path.ts` | 绝对文件路径 |
| `builtin:vector-store` | 内置 VectorStoreProvider |
| `npm:some-package` | npm 包名 |
| `some-package` | 同 npm:，走 node 模块解析 |

**Provider 导出格式（三种都支持）：**

```typescript
// 格式 A：简单对象（推荐，用 defineProvider）
export default defineProvider({ name: "x", mountPrefix: "/x", ... });

// 格式 B：工厂函数（需要异步初始化时）
export default async function (spec: ProviderSpec) {
  const db = await openDatabase(spec.config.path);
  return defineProvider({ name: spec.name, mountPrefix: spec.mountPrefix, ... });
}

// 格式 C：类（与 B 等价，也会被尝试 new Class(spec.config)）
export default class MyProvider implements VfsProvider { ... }
```

---

### 本地调试（无 FUSE）

Provider 是纯 TypeScript，不需要挂载 FUSE 就能测试，甚至在 macOS 上也可以：

```typescript
// my-provider.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MountRouter } from "./src/provider/router.js";
import { anonymousContext } from "./src/provider/types.js";
import createMyProvider from "./my-provider.js";

const ctx = anonymousContext();

describe("my-provider", () => {
  it("lists root", async () => {
    const p = createMyProvider({ name: "my", mountPrefix: "/my", config: {} });
    const entries = await p.readdir("/", ctx);
    assert.ok(entries.length > 0);
  });

  it("integrates with MountRouter", async () => {
    const router = new MountRouter();
    router.mount(createMyProvider({ name: "my", mountPrefix: "/my", config: {} }));

    // readdir 自动带 /my 前缀
    const entries = await router.readdir("/my", ctx);
    assert.ok(entries.some(e => e.name === "README.md"));

    // search fan-out 会把路径重写为 /my/...
    const hits = await router.search({ query: "hello", subpath: "/" }, ctx);
    // 命中路径是 /my/README.md，不是 /README.md
  });
});
```

运行：
```bash
node --test --import tsx my-provider.test.ts
```

---

## 9. Docker 部署（Linux / 生产环境）

**当前 Dockerfile 参考（需根据项目更新）：**

```dockerfile
FROM node:22-bookworm

# 安装 FUSE 2（fuse-native 的依赖）
RUN apt-get update && apt-get install -y \
    fuse libfuse2 libfuse-dev \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
RUN pnpm approve-builds fuse-native || true

COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples    # 如果使用自定义 Provider

RUN pnpm build

RUN mkdir -p /vfs           # FUSE 挂载点

CMD ["node", "dist/server.js"]
```

**docker-compose.yml 完整示例：**

```yaml
services:
  chroma:
    image: chromadb/chroma:latest
    ports:
      - "8000:8000"
    volumes:
      - ./data/chroma:/chroma/chroma

  vfs-server:
    build: .
    cap_add:
      - SYS_ADMIN              # FUSE 必须
    devices:
      - /dev/fuse:/dev/fuse
    ports:
      - "7801:7801"
    environment:
      VFS_BACKEND: chroma
      CHROMA_URL: http://chroma:8000
      CHROMA_COLLECTION: vfs_docs
      VFS_MOUNT: /vfs
      VFS_PORT: 7801
      # 可选：开启多 Provider 模式
      # VFS_CONFIG: /app/vfs.config.yaml
    volumes:
      - ./data:/app/data
      - ./vfs.config.yaml:/app/vfs.config.yaml  # 如果用配置文件
    depends_on:
      - chroma
```

**启动：**

```bash
# 先 ingest 数据（用 SQLite 时）
VFS_BACKEND=sqlite VFS_DB_PATH=./data/vfs.db \
  pnpm ingest ./docs/sample-docs --prefix docs

# 启动服务（Linux 直接运行，macOS 需要 Docker）
docker compose up -d

# 验证 FUSE 挂载
docker compose exec vfs-server ls /vfs/
```

---

## 10. Agent 接入

HTTP server 暴露三个端点，均为 POST + JSON：

### `POST /v1/bash`  ← 主要端点

```bash
curl -X POST http://localhost:7801/v1/bash \
  -H "Content-Type: application/json" \
  -d '{"command": "ls /vfs/docs/auth/"}'
# {"stdout": "api-keys.md\noauth.md\ntoken-refresh.md\n", "stderr": "", "exitCode": 0}

curl -X POST http://localhost:7801/v1/bash \
  -d '{"command": "cat /vfs/docs/auth/oauth.md"}'

curl -X POST http://localhost:7801/v1/bash \
  -d '{"command": "grep -r \"access_token\" /vfs/docs/"}'
```

### `POST /v1/fs/ls` / `POST /v1/fs/cat` / `POST /v1/fs/grep`

```bash
curl -X POST http://localhost:7801/v1/fs/grep \
  -H "Content-Type: application/json" \
  -d '{"pattern": "oauth", "prefix": "docs/", "ignoreCase": true, "limit": 20}'
# {"slugs": ["docs/auth/oauth.md", "docs/guides/quickstart.md"]}
```

### `GET /v1/health`

```bash
curl http://localhost:7801/v1/health
# {"status":"ok","backend":"sqlite(./data/vfs.db)","mount":"/vfs","optimizers":[],"uptime":42}
```

### Token 鉴权（可选）

```bash
export VFS_SESSION_TOKEN=my-secret-token

# 调用时带 header
curl -X POST http://localhost:7801/v1/bash \
  -H "x-vfs-session: my-secret-token" \
  -d '{"command": "ls /vfs/"}'
```

---

## 11. 环境变量速查

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VFS_BACKEND` | `chroma` | `chroma` 或 `sqlite` |
| `VFS_DB_PATH` | `./data/vfs.db` | SQLite 文件路径 |
| `CHROMA_URL` | `http://127.0.0.1:8000` | Chroma HTTP 地址 |
| `CHROMA_COLLECTION` | `vfs` | Chroma collection 名 |
| `VFS_CONFIG` | —（未设则走单数据源模式） | 多 Provider 配置文件路径 |
| `VFS_MOUNT` | `/vfs` | FUSE 挂载点 |
| `VFS_PORT` | `7801` | HTTP 监听端口 |
| `VFS_SESSION_TOKEN` | —（未设则不鉴权） | HTTP 请求鉴权 token |
| `VFS_OPTIMIZERS` | —（空 = 不启用优化器） | `grep,tree,du` 或 `all` |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |

---

## 12. 常见问题

**Q：启动时报 `Error: No native build was found for platform=darwin`**

FUSE 挂载在 macOS 上不支持。如果只是开发 Provider，可忽略这个错误——HTTP 接口不受影响。实际 FUSE 挂载请用 Docker（Linux 容器）。

---

**Q：Chroma 报 `collection already exists`**

正常行为，Chroma ingest 是幂等的：同一文件再次 ingest 会删除旧 chunks 然后重写。

---

**Q：`grep -r` 很慢**

确认优化器已启用：

```bash
VFS_OPTIMIZERS=grep VFS_BACKEND=sqlite pnpm server
```

多 Provider（`VFS_CONFIG`）模式下优化器目前不生效（已知限制），`grep` 退化为实际 bash 执行。

---

**Q：自定义 Provider `search()` 返回了结果，但 `/search/results/` 是空的**

检查 Provider 的 `search()` 返回的 `path` 字段是否以 `/` 开头（例如 `/posts/10.md`），且不包含 mountPrefix。MountRouter 会自动把 Provider 的相对路径拼上挂载前缀。

---

**Q：想同时使用 SQLite 和 Chroma 作为两个挂载点**

```yaml
# vfs.config.yaml
providers:
  - name: local-docs
    mountPrefix: /local
    driver: builtin:vector-store
    config:
      backend: sqlite
      path: ./data/local.db

  - name: cloud-docs
    mountPrefix: /cloud
    driver: builtin:vector-store
    config:
      backend: chroma
      # CHROMA_URL 和 CHROMA_COLLECTION 从环境变量读
```

然后 `VFS_CONFIG=./vfs.config.yaml CHROMA_URL=http://... CHROMA_COLLECTION=cloud pnpm server`。

---

**Q：Provider 怎么访问 `ctx`（请求上下文）？**

`VfsContext` 包含 `sessionId`、`userId`（可选）和 `groups`（可选），目前 server 统一传 `{sessionId: "http"}`。后续如果需要多用户权限隔离，可以在 HTTP 中间件里从 token/session 解析用户身份并注入到 ctx 中。
