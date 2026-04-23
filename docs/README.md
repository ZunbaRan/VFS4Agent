# vfs4Agent 参考文档索引

## 重构开发文档

- **[FUSE_REFACTOR_PLAN.md](./FUSE_REFACTOR_PLAN.md)** — FUSE 重构完整开发指南（1219 行，主文档）

## agent-fuse 参考源码

来自 https://github.com/Jakob-em/agent-fuse （TypeScript + fuse-native + PGlite + Anthropic Agent SDK）

| 文件 | 说明 |
|---|---|
| [agent-fuse-index.ts.txt](./agent-fuse-index.ts.txt) | FUSE mount 入口，fuse-native 挂载逻辑 |
| [agent-fuse-helpers.ts.txt](./agent-fuse-helpers.ts.txt) | 辅助函数：路径解析、文件名映射、虚拟目录、数据库查询 |
| [agent-fuse-getattr.ts.txt](./agent-fuse-getattr.ts.txt) | 文件/目录属性获取，区分文件/目录/软链 |
| [agent-fuse-open.ts.txt](./agent-fuse-open.ts.txt) | 打开文件，返回数据库 ID 作为 fd |
| [agent-fuse-read.ts.txt](./agent-fuse-read.ts.txt) | 读取文件内容切片，用 fd 查缓存 |
| [agent-fuse-readdir.ts.txt](./agent-fuse-readdir.ts.txt) | 读取目录列表，查数据库构建条目 |
| [agent-fuse-mkdir.ts.txt](./agent-fuse-mkdir.ts.txt) | 创建目录，写入数据库 |
| [agent-fuse-rename.ts.txt](./agent-fuse-rename.ts.txt) | 移动/重命名，更新数据库记录 |
| [agent-fuse-symlink.ts.txt](./agent-fuse-symlink.ts.txt) | 创建软链，设置标记属性 |
| [agent-fuse-unlink.ts.txt](./agent-fuse-unlink.ts.txt) | 删除软链，清除标记属性 |
| [agent-fuse-readlink.ts.txt](./agent-fuse-readlink.ts.txt) | 解析软链目标路径 |
| [agent-fuse-main.ts.txt](./agent-fuse-main.ts.txt) | 程序入口：initDb → mount → startRepl |
| [agent-fuse-agent.ts.txt](./agent-fuse-agent.ts.txt) | Anthropic Agent SDK 集成 + REPL |
| [agent-fuse-Dockerfile.txt](./agent-fuse-Dockerfile.txt) | Docker 配置（FUSE 运行库安装） |
| [agent-fuse-docker-compose.yml.txt](./agent-fuse-docker-compose.yml.txt) | Docker 容器编排 |
| [agent-fuse-package.json.txt](./agent-fuse-package.json.txt) | 依赖配置 |

## ToolFS 参考源码

来自 https://github.com/IceWhaleTech/ToolFS （Go + go-fuse，Skills 系统）

| 文件 | 说明 |
|---|---|
| [toolfs-core.go.txt](./toolfs-core.go.txt) | 核心文件系统操作（FileInfo、路径解析、内存/本地/RAG 三种后端） |
| [toolfs-fuse.go.txt](./toolfs-fuse.go.txt) | go-fuse 适配器实现 |
| [toolfs-sandbox.go.txt](./toolfs-sandbox.go.txt) | 沙箱配置与技能执行环境 |
| [toolfs-skills.go.txt](./toolfs-skills.go.txt) | 技能注册与管理系统 |
| [toolfs-builtin_skills.go.txt](./toolfs-builtin_skills.go.txt) | 内置技能实现（RAG 搜索、记忆、上下文等） |
| [toolfs-skill_api.go.txt](./toolfs-skill_api.go.txt) | 技能 API（将 Agent 工具暴露为文件操作） |
| [toolfs-skill_doc.go.txt](./toolfs-skill_doc.go.txt) | 技能文档生成 |
| [toolfs-executor_test.go.txt](./toolfs-executor_test.go.txt) | 命令执行器测试 |

## 参考文章

| 文件 | 来源 | 核心观点 |
|---|---|---|
| [fuse-is-all-you-need.md](./fuse-is-all-you-need.md) | jakobemmerling.de | Agent 不需要模拟器，只需要 FUSE 挂载 + 真实 bash。展示了邮件 Agent 的完整实现 |

## VKFS 参考源码

来自 https://github.com/ZeroZ-lab/vkfs （Go + sqlite-vec + Zilliz/Milvus，多后端向量文件系统）

**核心理念**：VectorStore 是单一数据源，后端可插拔。SQLite 和 Zilliz 是**平级选项**，用户按需选择。

| 文件 | 说明 |
|---|---|
| [vkfs-store.go.txt](./vkfs-store.go.txt) | VectorStore 接口定义（Search、StoreChunks、GetPathTree 等） |
| [vkfs-sqlite.go.txt](./vkfs-sqlite.go.txt) | SQLite 后端实现（sqlite-vec 向量存储 + L2 暴力搜索） |
| [vkfs-zilliz.go.txt](./vkfs-zilliz.go.txt) | Zilliz/Milvus 后端实现 |
| [vkfs-factory.go.txt](./vkfs-factory.go.txt) | 后端工厂选择器 |
| [vkfs-types.go.txt](./vkfs-types.go.txt) | Chunk/PathTree 类型定义 |
| [vkfs-README.md](./vkfs-README.md) | 项目说明与架构 |
