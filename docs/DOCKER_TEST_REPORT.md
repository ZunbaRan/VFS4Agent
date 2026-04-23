# Docker 端到端测试报告

> **执行日期**：2026-04-23
> **结果**：13 个测试步骤全部通过 ✅
> **宿主机**：Apple Silicon macOS, Docker Desktop 29.3.1
> **容器平台**：`linux/amd64`（通过 Rosetta 2 模拟）
> **后端**：SQLite（`data/vfs.db`）
> **LLM**：Qwen（`qwen-plus`，通过 DashScope OpenAI-compatible endpoint）

---

## 一、测试结果总览

| # | 步骤 | 结果 | 关键指标 |
|---|---|---|---|
| 1 | Docker 版本检查 | ✅ | Docker 29.3.1 |
| 2 | `docker compose build` | ✅ | 镜像 `vfs4agent-vfs-agent:latest`，约 15s 装依赖 + 12s tsc 构建 |
| 3 | 镜像产物验证 | ✅ | `dist/fuse/ops/`、`dist/agent/`、`dist/cli/` 齐全；`fuse-native` 预编译 `.node` 就位 |
| 4 | 文档 ingest | ✅ | 6 files → 14 chunks（97ms） |
| 5 | PathTree 验证 | ✅ | 6 个 slug 与 `examples/sample-docs/` 一一对应 |
| 6 | FUSE 基础挂载（Node `fs/promises`） | ✅ | `readdir` / `stat` / `readFile` 全部正确 |
| 7 | 真实 bash 命令（`ls`/`head`/`grep`/`find`/`wc`） | ✅ | 在 detached 容器 + `docker exec` 模式下通过 |
| 8 | 虚拟 `/search` 目录 | ✅ | 写入 `OAuth` → 生成 4 个结果文件 |
| 9 | Agent 目录浏览 | ✅ | Qwen 调用 `ls -la /vfs/docs` 并总结 |
| 10 | Agent 全库搜索 | ✅ | Qwen 调用 `grep -rn 'OAuth' .` 给出文件 + 行号 |
| 11 | Agent 多文件综合问答 | ✅ | Qwen 连续 6 次 bash 调用（`ls ×3` + `cat ×3`）后综合回答 |
| 12 | `ask` 单轮 CLI | ✅ | mount → 1 turn → unmount 全自动 |
| 13 | HTTP 桥（`/v1/health`、`/v1/fs/{ls,cat,grep}`） | ✅ | 4 个端点全部返回正确 JSON |

---

## 二、遇到的问题与解决方案

### 问题 1：Apple Silicon 上 `fuse-native` 编译失败 🛑

**现象**
构建第一次失败：
```
/usr/bin/ld: .../fuse-shared-library-linux/libfuse/lib/libfuse.so: error adding symbols: file in wrong format
collect2: error: ld returned 1 exit status
ELIFECYCLE  Command failed with exit code 1.
```

**根因**
- 宿主机是 Apple Silicon（arm64）
- Docker Desktop 默认用 `linux/arm64` 构建
- `fuse-native@2.2.6` 依赖 `fuse-shared-library-linux@1.0.1`，该包 **只发布了 x86_64 的 `libfuse.so`**
- 结果：arm64 的 `ld` 链接 x86_64 的 `.so`，报 `file in wrong format`

**解决**
在 [docker-compose.yml](../docker-compose.yml) 中强制 `linux/amd64`：
```yaml
services:
  vfs-agent:
    build:
      context: .
      platforms:
        - linux/amd64        # 构建目标平台
    platform: linux/amd64    # 运行目标平台
```

强制 amd64 后：
- Docker Desktop 用 Rosetta 2 模拟 x86_64
- `fuse-native` 直接用 `prebuilds/linux-x64/node.napi.node`，**完全跳过本地编译**
- `libfuse.so` 原本就是 x86_64，链接成功

**替代方案（未采用）**
1. 等 `fuse-shared-library-linux` 发布 arm64 版本（上游未跟进）
2. 换 `fuse-native` fork，手动链接系统 `libfuse2`（需要改 `binding.gyp`）

**后续影响**
Rosetta 翻译有 ~15-20% 性能损失，但 FUSE 操作主要是 I/O 绑定，对沙箱只读场景可接受。

---

### 问题 2：`docker compose run` 创建容器卡住 🐢

**现象**
```
$ docker compose run --rm vfs-agent sh -c '...'
Container vfs4agent-vfs-agent-run-xxxx Creating
# ↑ 长时间无响应
```

**根因**
`compose run` 默认尝试分配 TTY，在 amd64 模拟 + 复杂挂载点（`cap_add: SYS_ADMIN`, `/dev/fuse`, `apparmor:unconfined`）组合下创建变慢。

**解决**
测试阶段改用 `docker run --rm --platform linux/amd64 <image> <cmd>`，直接走原生 Docker 流程，避开 compose 的 TTY 预分配。compose 只用于 build 和日常开发。

---

### 问题 3：同进程 `execSync` 导致 FUSE 死锁 💀（**重要架构教训**）

**现象**
步骤 7 最初版本：
```js
// 同一个 Node 进程里挂载 FUSE + 用 execSync 跑 bash
await mount({ store, mountPoint: "/vfs" });
execSync("ls -la /vfs/docs/");   // ← 永久阻塞
```
执行超过 60 秒无输出，容器必须强制 kill。

**根因**
`fuse-native` 的 FUSE 回调（`getattr` / `readdir` / `read` / ...）都运行在 **同一个 Node.js 事件循环** 上。

死锁链：
```
Node 主线程 → execSync 阻塞等待 bash 退出
    └─ bash → ls → FUSE readdir syscall → 陷入内核
            └─ 内核 → 投递 readdir 请求给 Node（libfuse 协议）
                    └─ Node 事件循环被 execSync 占住 → 永远收不到请求
                            └─ bash 永远等不到 readdir 回复 → 死锁
```

**解决**
**进程隔离** — FUSE 服务进程和 bash 客户端必须分开：
```bash
# 容器 A：长驻，只负责挂载 FUSE
docker run -d --name vfs-test ... vfs4agent-vfs-agent \
  node -e "import('./dist/fuse/index.js').then(({mount}) => mount(...))"

# 容器 A 内另一个进程：真实 bash 客户端
docker exec vfs-test bash -lc 'ls -la /vfs/docs/ && grep -rn OAuth /vfs/docs'
```
`docker exec` 在容器内 fork 一个新的进程组，与 FUSE server 进程的事件循环完全解耦。

**对实际 Agent 代码的启示**
查看 [src/agent/bash.ts](../src/agent/bash.ts#L30) 验证过：
```ts
const child = spawn("/bin/bash", ["-lc", command], { cwd, env });
```
**使用的是非阻塞 `spawn`**（而不是 `execSync`/`spawnSync`），bash 作为独立子进程运行，Node 事件循环继续转，FUSE 回调正常响应。✅ 生产代码没有这个问题。

**预防**
- 任何调用方法名含 `Sync` 的 Node API，若在 FUSE mount owner 进程里调用外部进程访问 mount，都会死锁
- 建议在 `src/fuse/index.ts` 文档顶部加警告注释（可选改进）

---

### 问题 4：Qwen 模型名错误 ✏️

**现象**
最初用 `QWEN_MODEL=qwen3.6-plus`（来自测试计划），Qwen API 返回 404 "model not found"。

**解决**
改成 `qwen-plus`（DashScope OpenAI-compatible 端点的真实模型名）。测试计划中的 `qwen3.6-plus` 是笔误。

---

## 三、关键测试输出摘录

### 步骤 7：真实 bash over FUSE

```bash
$ docker exec vfs-test bash -lc 'grep -rn OAuth /vfs/docs'
/vfs/docs/auth/api-keys.md:3:For server-to-server usage where OAuth is overkill, ...
/vfs/docs/auth/oauth.md:1:# OAuth Authentication
/vfs/docs/auth/oauth.md:3:This guide shows how to authenticate with the API using OAuth 2.0.
/vfs/docs/guides/quickstart.md:7:3. Generate an access_token via OAuth (see [OAuth](../auth/oauth.md))
```

这一条是整个架构的 **核心价值验证**：真实 GNU grep 通过 FUSE 协议向量数据库中的文档做递归搜索，行号、路径都准确。

### 步骤 8：虚拟 `/search` 目录

```bash
$ echo -n "OAuth access token" > /vfs/search/last_query
$ ls /vfs/search/results/
001_docs_auth_api-keys.md
002_docs_auth_oauth.md
003_docs_auth_token-refresh.md
004_docs_guides_quickstart.md

$ cat /vfs/search/results/002_docs_auth_oauth.md | head -n 3
# OAuth Authentication

This guide shows how to authenticate with the API using OAuth 2.0.
```

写入 `last_query` → FUSE `release` 回调触发 `runSearch` → 结果作为虚拟文件暴露给 bash。

### 步骤 11：Agent 综合问答

Qwen 连续调用 6 次 `bash` tool：

```
$ ls -la
$ ls -la docs/
$ ls -la docs/auth/
$ cat docs/auth/api-keys.md
$ cat docs/auth/oauth.md
$ cat docs/auth/token-refresh.md
```

最终回答：
> 这个 API 系统提供了**两种主要的认证方式**：
> 1. **API Keys**（服务端到服务端简单场景，无过期）
> 2. **OAuth 2.0**（含 Token Refresh，短期令牌 + 自动刷新）
>
> Token Refresh 是 OAuth 流程的组成部分，不单独算作第三种认证方式。

Agent 正确识别了两种认证方式、关联了 `token-refresh.md` 与 OAuth，分析准确。

### 步骤 13：HTTP 桥

```
GET  /v1/health              → {"ok":true,"backend":"sqlite(/app/data/vfs.db)"}
POST /v1/fs/ls  {path:docs}  → {"entries":["api-reference","auth","guides"]}
POST /v1/fs/cat {path:...}   → {"content":"# OAuth Authentication\n..."}
POST /v1/fs/grep {pattern}   → {"slugs":["docs/auth/api-keys.md", ...]}
```

供 CrewAI / LangChain Python 等 non-TS Agent 框架使用的轻量只读 API。

---

## 四、架构验证结论

这次测试验证了 FUSE 重构的核心论点 —— **"让 agent 用真实 bash 访问向量数据库"** 是可行的：

1. **FUSE 挂载在 Docker 里稳定工作**（amd64 强制 + `SYS_ADMIN` + `/dev/fuse`）
2. **任何 POSIX 工具都能访问挂载点** — 无需模拟、无需自研 `ls`/`grep` 实现
3. **虚拟 `/search` 路径提供语义搜索逃生口** — 向量检索走 `echo > /vfs/search/last_query` + `cat /vfs/search/results/*`
4. **Agent tool loop 简洁** — 只需要一个 `bash(command)` tool，LLM 天然懂
5. **HTTP 桥保留给 non-TS 语言** — 不强迫 Python agent 接入 FUSE

---

## 五、非理想与遗留项

| 项目 | 说明 |
|---|---|
| arm64 原生支持 | 依赖上游 `fuse-shared-library-linux` 发布 arm64，目前靠 Rosetta |
| FUSE mount owner 进程不能用 `*Sync` 子进程 API 访问 mount | 已在 `bash.ts` 用 `spawn` 规避；可在 `src/fuse/index.ts` 加注释提醒 |
| Qwen 模型名需要手动校正 | `DOCKER_TEST_PLAN.md` 中 `qwen3.6-plus` 应改为 `qwen-plus` |
| 测试用 LLM 调用数 | 步骤 9-11 共 3 个问题，约消耗 15 次 bash tool 调用 + 3 次 Qwen chat completion |

---

## 六、复现命令速查

```bash
# Build（一次性）
cd /Users/loloru/Documents/data/project/vfs4Agent
docker compose build

# Ingest
docker run --rm --platform linux/amd64 \
  -v "$PWD/data:/app/data" \
  -v "$PWD/examples/sample-docs:/app/docs-content:ro" \
  -e VFS_BACKEND=sqlite -e VFS_DB_PATH=/app/data/vfs.db \
  vfs4agent-vfs-agent \
  node dist/cli/ingest.js /app/docs-content --prefix docs --db /app/data/vfs.db

# Detached FUSE mount（供 docker exec 测试）
docker run -d --name vfs-test --platform linux/amd64 \
  --cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined \
  -v "$PWD/data:/app/data" \
  -e VFS_BACKEND=sqlite -e VFS_DB_PATH=/app/data/vfs.db \
  vfs4agent-vfs-agent \
  node -e "import('./dist/fuse/index.js').then(async ({mount}) => { const {createBackend} = await import('./dist/backend/factory.js'); const {store} = createBackend(); await mount({store, mountPoint:'/vfs'}); console.log('mounted'); setInterval(()=>{}, 1e9); });"

docker exec vfs-test bash -lc 'grep -rn OAuth /vfs/docs'
docker rm -f vfs-test

# ask 单轮
docker run --rm --platform linux/amd64 \
  --cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined \
  -v "$PWD/data:/app/data" \
  -e VFS_BACKEND=sqlite -e VFS_DB_PATH=/app/data/vfs.db \
  -e DASHSCOPE_API_KEY=<your-key> \
  -e DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
  -e QWEN_MODEL=qwen-plus \
  vfs4agent-vfs-agent \
  node dist/cli/ask.js --mount /vfs "搜索所有提到 OAuth 的文件"

# HTTP 桥
docker run -d --name vfs-server --platform linux/amd64 \
  -p 7801:7801 \
  -v "$PWD/data:/app/data" \
  -e VFS_BACKEND=sqlite -e VFS_DB_PATH=/app/data/vfs.db \
  vfs4agent-vfs-agent node dist/server.js
curl http://localhost:7801/v1/health
docker rm -f vfs-server
```
