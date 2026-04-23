# Docker 构建测试方案

> **目标**：在 Docker 容器中验证 FUSE 挂载 + Agent REPL 端到端流程。
> **前置条件**：Docker Desktop 已启动（macOS）。
> **最后更新**：2026-04-23

---

## 一、LLM 配置

项目 `env/llm_info.md` 中记录了 Qwen 配置：

```bash
DASHSCOPE_API_KEY=sk-7d82264e78b34a8dae8c29a3b2bf2ddc
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.6-plus
```

这些环境变量需要在 `docker-compose run` 时传入容器。

---

## 二、构建步骤

### 步骤 1：验证 Docker 运行

```bash
docker info --format '{{.ServerVersion}}'
# 应返回 Docker 版本号
```

### 步骤 2：构建镜像

```bash
cd /Users/loloru/Documents/data/project/VFS4Agent
docker compose build
```

**预期**：
- `node:22-bookworm` 基础镜像拉取
- FUSE 运行库安装成功（`fuse`, `libfuse2`, `libfuse-dev`）
- pnpm 安装依赖成功
- `pnpm build` 编译成功
- `pnpm approve-builds fuse-native better-sqlite3` 触发原生编译

### 步骤 3：验证镜像内容

```bash
docker compose run --rm vfs-agent ls dist/fuse/ops/
# 应显示: create.js getattr.js index.js open.js read.js readdir.js release.js truncate.js write.js

docker compose run --rm vfs-agent ls dist/agent/
# 应显示: adapters/ bash.js main.js repl.js
```

---

## 三、数据导入测试

### 步骤 4：导入示例数据

```bash
# 创建数据卷中的文档目录
mkdir -p ./data/docs-content
cp -r examples/sample-docs/* ./data/docs-content/ 2>/dev/null || true

# 在容器内执行 ingest
docker compose run --rm vfs-agent node dist/cli/ingest.js \
  --dir /app/docs-content --prefix docs

# 预期输出:
# [ingest] backend=sqlite(...) walked X files -> Y chunks
```

### 步骤 5：验证导入数据

```bash
docker compose run --rm vfs-agent node -e "
import('./dist/backend/factory.js').then(async ({ createBackend }) => {
  const { store } = createBackend();
  const tree = await store.getPathTree();
  console.log('Files:', Object.keys(tree).length);
  console.log('Paths:', Object.keys(tree).sort());
  store.close();
});
"
# 应显示文件列表
```

---

## 四、FUSE 挂载测试

### 步骤 6：基础 FUSE 挂载验证

```bash
docker compose run --rm vfs-agent node -e "
import('./dist/fuse/index.js').then(async ({ mount }) => {
  const { createBackend } = await import('./dist/backend/factory.js');
  const { store } = createBackend();
  await mount({ store, mountPoint: '/vfs' });
  console.log('FUSE mounted at /vfs');

  // 等待挂载稳定
  await new Promise(r => setTimeout(r, 1000));

  // 用 Node.js fs 模块验证（通过 FUSE 读取）
  const fs = await import('node:fs/promises');

  // 测试 readdir
  try {
    const docs = await fs.readdir('/vfs/docs');
    console.log('readdir /vfs/docs:', docs);
  } catch (e) {
    console.log('readdir error:', e.message);
  }

  // 测试 getattr (stat)
  try {
    const stat = await fs.stat('/vfs/docs/auth');
    console.log('stat /vfs/docs/auth:', stat.isDirectory() ? 'directory' : 'file');
  } catch (e) {
    console.log('stat error:', e.message);
  }

  // 测试 readFile
  try {
    const content = await fs.readFile('/vfs/docs/auth/oauth.md', 'utf8');
    console.log('readFile oauth.md (first 100 chars):', content.slice(0, 100));
  } catch (e) {
    console.log('readFile error:', e.message);
  }

  store.close();
  process.exit(0);
});
"
```

**预期**：
```
FUSE mounted at /vfs
readdir /vfs/docs: [ 'api-reference', 'auth', 'guides' ]
stat /vfs/docs/auth: directory
readFile oauth.md (first 100 chars): # OAuth 2.0 Authentication ...
```

### 步骤 7：真实 bash 命令测试

```bash
docker compose run --rm vfs-agent node -e "
import('./dist/fuse/index.js').then(async ({ mount }) => {
  const { createBackend } = await import('./dist/backend/factory.js');
  const { store } = createBackend();
  await mount({ store, mountPoint: '/vfs' });
  console.log('FUSE mounted');
  await new Promise(r => setTimeout(r, 1000));

  // 用真实 bash 子进程验证
  const { execSync } = await import('node:child_process');

  // 测试 ls
  console.log('=== ls /vfs/docs ===');
  console.log(execSync('ls /vfs/docs', { encoding: 'utf8' }));

  // 测试 cat
  console.log('=== cat /vfs/docs/auth/oauth.md (first 5 lines) ===');
  console.log(execSync('head -n 5 /vfs/docs/auth/oauth.md', { encoding: 'utf8' }));

  // 测试 grep（核心验证：真实 grep 通过 FUSE 读取）
  console.log('=== grep -r OAuth /vfs/docs ===');
  console.log(execSync('grep -r OAuth /vfs/docs 2>/dev/null', { encoding: 'utf8' }).slice(0, 300));

  // 测试 find
  console.log('=== find /vfs/docs -name \"*.md\" ===');
  console.log(execSync('find /vfs/docs -name \"*.md\"', { encoding: 'utf8' }));

  store.close();
  process.exit(0);
});
"
```

**预期**：
```
=== ls /vfs/docs ===
api-reference/  auth/  guides/

=== cat /vfs/docs/auth/oauth.md (first 5 lines) ===
# OAuth 2.0 Authentication
...

=== grep -r OAuth /vfs/docs ===
/vfs/docs/auth/oauth.md:## OAuth 2.0 Authorization Flow
...

=== find /vfs/docs -name "*.md" ===
/vfs/docs/auth/oauth.md
/vfs/docs/auth/api-keys.md
...
```

### 步骤 8：虚拟搜索目录测试

```bash
docker compose run --rm vfs-agent node -e "
import('./dist/fuse/index.js').then(async ({ mount }) => {
  const { createBackend } = await import('./dist/backend/factory.js');
  const { store } = createBackend();
  await mount({ store, mountPoint: '/vfs' });
  console.log('FUSE mounted');
  await new Promise(r => setTimeout(r, 1000));

  const { execSync } = await import('node:child_process');

  // 写入搜索词触发搜索
  console.log('=== echo \"OAuth\" > /vfs/search/last_query ===');
  execSync('echo \"OAuth\" > /vfs/search/last_query');
  await new Promise(r => setTimeout(r, 2000));

  // 查看搜索结果
  console.log('=== ls /vfs/search/results ===');
  console.log(execSync('ls /vfs/search/results 2>/dev/null', { encoding: 'utf8' }));

  // 读取搜索结果文件
  console.log('=== cat /vfs/search/results/* (first 200 chars) ===');
  console.log(execSync('cat /vfs/search/results/* 2>/dev/null', { encoding: 'utf8' }).slice(0, 200));

  store.close();
  process.exit(0);
});
"
```

**预期**：
```
=== echo "OAuth" > /vfs/search/last_query ===
=== ls /vfs/search/results ===
001_auth_oauth.md
002_auth_api-keys.md
003_auth_token-refresh.md
004_guides_getting-started.md
=== cat /vfs/search/results/* (first 200 chars) ===
# OAuth 2.0 Authentication
...
```

---

## 五、Agent REPL 端到端测试

### 步骤 9：启动 Agent REPL

```bash
docker compose run --rm -it vfs-agent \
  -e DASHSCOPE_API_KEY=sk-7d82264e78b34a8dae8c29a3b2bf2ddc \
  -e DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
  -e QWEN_MODEL=qwen3.6-plus \
  node dist/agent/main.js
```

**预期启动流程**：
```
[main] backend=sqlite(/app/data/vfs.db)
[main] FUSE mounted at /vfs
[main] Agent REPL ready. Type a question (or 'quit' to exit).
You>
```

### 步骤 10：测试问题

输入以下问题，观察 Agent 行为：

**测试 A：目录浏览**
```
You> /docs 目录下有哪些内容？
```

预期 Agent 行为：
1. 调用 `bash` tool → `ls /vfs/docs`
2. 返回结果：`api-reference/ auth/ guides/`
3. 回答用户

**测试 B：文件读取**
```
You> 查看 OAuth 认证文档的内容
```

预期 Agent 行为：
1. 调用 `bash` tool → `cat /vfs/docs/auth/oauth.md`
2. 返回文件内容
3. 总结文档要点

**测试 C：grep 搜索（核心验证）**
```
You> 搜索所有提到 OAuth 的文件
```

预期 Agent 行为：
1. 调用 `bash` tool → `grep -r "OAuth" /vfs/docs`
2. 返回带行号的匹配结果
3. 列出匹配文件

**测试 D：find 命令**
```
You> 找出所有 .md 文件
```

预期 Agent 行为：
1. 调用 `bash` tool → `find /vfs/docs -name "*.md"`
2. 返回文件列表

**测试 E：综合问题**
```
You> API 认证有哪几种方式？
```

预期 Agent 行为：
1. 浏览目录结构
2. 查看 auth/ 目录下的文件
3. 读取多个认证文档
4. 综合回答

### 步骤 11：退出 REPL

```
You> quit
```

---

## 六、ask CLI 单轮测试

### 步骤 12：单轮问答

```bash
docker compose run --rm -it vfs-agent \
  -e DASHSCOPE_API_KEY=sk-7d82264e78b34a8dae8c29a3b2bf2ddc \
  -e DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
  -e QWEN_MODEL=qwen3.6-plus \
  node dist/cli/ask.js "OAuth 认证流程是什么？"
```

**预期**：
- 自动 mount FUSE
- 执行 1 轮 agent turn
- 输出答案
- 自动 unmount

---

## 七、HTTP 桥测试

### 步骤 13：启动 HTTP 桥

```bash
docker compose run --rm -p 7801:7801 vfs-agent node dist/server.js &
sleep 3

# 健康检查
curl http://localhost:7801/v1/health
# 预期: { "status": "ok", "backend": "sqlite" }

# 读取文件
curl -X POST http://localhost:7801/v1/fs/cat \
  -H "Content-Type: application/json" \
  -d '{"path": "docs/auth/oauth.md"}'
# 预期: { "content": "# OAuth 2.0 Authentication\n..." }

# 列出目录
curl -X POST http://localhost:7801/v1/fs/ls \
  -H "Content-Type: application/json" \
  -d '{"path": "docs"}'
# 预期: { "entries": ["api-reference", "auth", "guides"] }
```

---

## 八、验收清单

### 构建阶段
- [ ] `docker compose build` 成功
- [ ] `fuse-native` 原生编译成功
- [ ] `better-sqlite3` 原生编译成功
- [ ] `dist/` 目录包含所有文件

### 数据导入
- [ ] `ingest` 成功导入 6 个示例文件
- [ ] PathTree 包含正确的目录结构
- [ ] Chunks 数量正确（约 14 个）

### FUSE 挂载
- [ ] `readdir /vfs/docs` 返回正确目录列表
- [ ] `stat /vfs/docs/auth` 识别为目录
- [ ] `readFile /vfs/docs/auth/oauth.md` 返回完整内容
- [ ] 真实 `ls` 命令正常工作
- [ ] 真实 `head` 命令正常工作
- [ ] **真实 `grep -r` 命令正常工作**（核心验证）
- [ ] 真实 `find` 命令正常工作
- [ ] `/search/last_query` 写入触发搜索
- [ ] `/search/results/` 生成虚拟文件

### Agent 集成
- [ ] REPL 正常启动
- [ ] Agent 能正确调用 `bash` tool
- [ ] Agent 能浏览目录
- [ ] Agent 能读取文件内容
- [ ] Agent 能执行 `grep -r` 搜索
- [ ] Agent 能回答综合问题
- [ ] `quit` 正常退出

### HTTP 桥
- [ ] `/v1/health` 返回 ok
- [ ] `/v1/fs/cat` 返回文件内容
- [ ] `/v1/fs/ls` 返回目录列表

---

## 九、故障排查

### Docker 构建失败

| 问题 | 排查 |
|---|---|
| `fuse-native` 编译失败 | 检查 Dockerfile 中 `libfuse-dev` 是否安装 |
| `better-sqlite3` 编译失败 | 检查 Dockerfile 中 `build-essential python3` 是否安装 |
| pnpm 安装失败 | 检查网络，尝试 `pnpm install --no-frozen-lockfile` |

### FUSE 挂载失败

| 问题 | 排查 |
|---|---|
| `mount(): EACCES` | 检查容器是否有 `SYS_ADMIN` capability + `/dev/fuse` device |
| 挂载后 `ls` 卡住 | 检查 FUSE ops 是否有未处理的 Promise rejection |
| `readdir` 返回空 | 检查 PathTree 是否正确导入数据 |

### Agent REPL 问题

| 问题 | 排查 |
|---|---|
| LLM API 连接失败 | 检查 `DASHSCOPE_API_KEY` 环境变量是否传入容器 |
| Agent 不调用 bash tool | 检查 `openai.ts` 中 tool schema 是否正确 |
| Agent 无限循环 | 检查 maxTurns=20 限制是否生效 |

---

## 十、快速验证脚本

如果想一键运行所有非交互式测试，可以用这个脚本：

```bash
#!/bin/bash
set -e

echo "=== Step 1: Build ==="
docker compose build

echo "=== Step 2: Verify image ==="
docker compose run --rm vfs-agent ls dist/fuse/ops/

echo "=== Step 3: Ingest ==="
docker compose run --rm vfs-agent node dist/cli/ingest.js \
  --dir /app/docs-content --prefix docs

echo "=== Step 4: FUSE basic test ==="
docker compose run --rm vfs-agent node -e "
import('./dist/fuse/index.js').then(async ({ mount }) => {
  const { createBackend } = await import('./dist/backend/factory.js');
  const { store } = createBackend();
  await mount({ store, mountPoint: '/vfs' });
  await new Promise(r => setTimeout(r, 1000));
  const fs = await import('node:fs/promises');
  console.log('readdir:', await fs.readdir('/vfs/docs'));
  console.log('stat:', (await fs.stat('/vfs/docs/auth')).isDirectory() ? 'dir' : 'file');
  const content = await fs.readFile('/vfs/docs/auth/oauth.md', 'utf8');
  console.log('readFile:', content.slice(0, 60));
  store.close();
  process.exit(0);
});
"

echo "=== Step 5: Real bash test ==="
docker compose run --rm vfs-agent node -e "
import('./dist/fuse/index.js').then(async ({ mount }) => {
  const { createBackend } = await import('./dist/backend/factory.js');
  const { store } = createBackend();
  await mount({ store, mountPoint: '/vfs' });
  await new Promise(r => setTimeout(r, 1000));
  const { execSync } = await import('node:child_process');
  console.log('ls:', execSync('ls /vfs/docs', { encoding: 'utf8' }).trim());
  console.log('grep:', execSync('grep -rl OAuth /vfs/docs', { encoding: 'utf8' }).trim());
  console.log('find:', execSync('find /vfs/docs -name \"*.md\"', { encoding: 'utf8' }).trim());
  store.close();
  process.exit(0);
});
"

echo "=== All non-interactive tests passed ==="
```
