# CLAUDE.md — vfs4Agent 项目指令

> 这个文件告诉 Claude Code 如何理解本项目。

## 项目定位

vfs4Agent 是一个为 LLM Agent 提供的只读文档沙箱。Agent 以为自己 SSH 到了一台 Linux 机器，用 `ls`、`cat`、`grep` 等标准 bash 命令浏览文档。底层是向量数据库（Chroma 或 SQLite）。

## 当前状态

正在进行架构重构：从 just-bash 模拟器方案 → FUSE 虚拟文件系统方案。

## 关键文档

- `docs/FUSE_REFACTOR_PLAN.md` — FUSE 重构完整开发指南（主文档）
- `docs/README.md` — 参考源码索引（agent-fuse / ToolFS / VKFS）

## 架构原则

1. **VectorStore 是唯一数据源**（PathTree + chunks），所有层都通过 VectorStore 接口访问数据
2. **后端可插拔**：Chroma（HTTP 服务）和 SQLite（本地零依赖）是平级选项，通过 `VFS_BACKEND` 环境变量切换
3. **FUSE 层只依赖 VectorStore 接口**，不关心底层是 Chroma 还是 SQLite
4. **FUSE 参考 agent-fuse 的 ops 回调模式**（getattr/open/read/readdir 等），不要自己发明接口
5. **Agent 用真实 bash**（Anthropic SDK Bash tool 或 OpenAI function calling），不是模拟器

## 保留代码

- `src/backend/` — ChromaVectorStore + SqliteVectorStore + factory（核心资产，不要改）
- `src/ingest.ts` — 数据导入管道（不要改）
- `src/types.ts` — 核心类型定义（小改即可）
- `src/server.ts` — HTTP 桥（简化，去掉 createShell 依赖）

## 删除代码

- `src/shell.ts` — just-bash 实例创建
- `src/fs/` — VirtualFs / InMemoryFs / MountableFs
- `src/grep/` — 两阶段 grep 引擎
- `src/runner/` — shellRunner + realism（沙箱伪装）
- `src/cli/shell.ts` — 交互式 shell CLI
- `src/cli/probe.ts` — 探针测试

## 新增代码

- `src/fuse/` — FUSE 层（index.ts, helpers.ts, search.ts, ops/）
- `src/agent/` — Agent 入口（main.ts, repl.ts, adapters/）
- `Dockerfile` + `docker-compose.yml` — 容器化

## 开发约定

- TypeScript ESNext + ESM
- `pnpm` 包管理
- `tsx` 开发运行
- 参考代码在 `docs/` 目录下，文件名前缀标注来源项目
