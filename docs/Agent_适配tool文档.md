# Agent适配层相关文档

是的，完全正确。**适配不同 Agent 的核心工作，就是去读它们的文档，搞清楚“怎么声明工具”和“怎么注入结果”。** 剩下的执行逻辑全是我们统一的。

---

### 一、在 `bash` 工具里，哪些操作会转接到数据库？

答案是：**所有针对 `/vfs` 挂载点的文件操作，都会被 Linux 内核（VFS）拦截并转发给 FUSE，FUSE 再查数据库。**

| 用户/LLM 执行的命令 | 触发的系统调用 | FUSE 回调 | 数据库操作 |
|---|---|---|---|
| `ls /vfs/docs` | `opendir` / `readdir` | `ops/readdir.ts` | `getPathTree()` 读取目录结构 |
| `cat /vfs/docs/a.md` | `open` + `read` | `ops/open.ts` + `ops/read.ts` | `getChunksByPage()` 读取并拼接文件内容 |
| `stat /vfs/docs/a.md` | `stat` | `ops/getattr.ts` | `getPathTree()` 读取文件元数据（大小/时间） |
| `grep -r "auth" /vfs` | 遍历目录 + 读文件 | `readdir` + `open` + `read` | 同上（查目录树 + 读每个文件内容） |
| `head -5 /vfs/a.md` | `open` + `read`（只读前几字节） | `ops/read.ts` (带 offset/len) | `getChunksByPage()` 拿到内容后切片 |
| `find /vfs -name "*.md"` | 递归遍历目录 | `readdir` (多次调用) | `getPathTree()` (缓存命中，极快) |
| `wc -l /vfs/a.md` | `read` 全文 | `ops/read.ts` | `getChunksByPage()` 获取全文 |

**不转接数据库的操作**：
- `cd /tmp`、`echo "foo" > /tmp/test.txt` → 走真实的宿主机文件系统。
- `whoami`、`uname -a`、`ps` → 走真实的操作系统内核。
- `python script.py`、`node app.js` → 真实的进程执行（如果容器里装了的话）。

**这就是 FUSE 的精髓**：你不需要在代码里写 `if command == 'ls' then ...`。只要路径在 `/vfs` 下，Linux 内核会自动帮你把一切文件操作路由到 FUSE 回调。

---

### 二、四大框架如何绑定 Tools（附官方文档链接）

#### 1. LangChain
**绑定方式**：继承 `BaseTool` 或使用 `@tool` 装饰器定义函数，然后传给 `Agent` 或 `Chain`。
```python
from langchain_core.tools import tool

@tool
def vfs_bash(command: str) -> str:
    """Execute a bash command in the sandbox."""
    # 你的实现（如 HTTP 调用）
    return "stdout..."

agent = create_tool_calling_agent(llm, tools=[vfs_bash], prompt=prompt)
```
**文档**：
- [LangChain Custom Tools](https://python.langchain.com/docs/how_to/custom_tools/)
- [LangChain Tool Calling Agents](https://python.langchain.com/docs/how_to/tool_calling/)

#### 2. LangGraph
**绑定方式**：LangGraph 直接使用 LangChain 的工具定义，通过 `bind_tools()` 将工具绑定到 LLM，在图节点中处理 `tool_call` 消息。
```python
from langgraph.prebuilt import ToolNode

tools = [vfs_bash]  # 使用上面定义的 LangChain tool
model_with_tools = llm.bind_tools(tools)

graph = StateGraph(MessagesState)
graph.add_node("tools", ToolNode(tools)) # 工具执行节点
```
**文档**：
- [LangGraph Tool Use](https://langchain-ai.github.io/langgraph/how-tos/tool-use/)
- [LangGraph Tool Calling](https://langchain-ai.github.io/langgraph/concepts/tools/)

#### 3. CrewAI
**绑定方式**：继承 `BaseTool` 实现 `_run()` 方法，将工具实例赋给 `Agent` 的 `tools` 属性。
```python
from crewai_tools import BaseTool

class VfsBashTool(BaseTool):
    name: str = "VfsBash"
    description: str = "Run bash in vfs"
    def _run(self, command: str) -> str:
        return "stdout..."

agent = Agent(role="...", goal="...", tools=[VfsBashTool()])
```
**文档**：
- [CrewAI Tools Concept](https://docs.crewai.com/concepts/tools)
- [CrewAI Create Custom Tools](https://docs.crewai.com/learn/create-custom-tools)

#### 4. Claude Agent SDK (Anthropic)
**绑定方式**：在调用 `query()` 时，通过 `options.allowedTools` 声明可用工具。SDK 会自动处理 `tool_use` 和 `tool_result` 的往返循环。
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: "搜索 OAuth 文档",
  options: {
    allowedTools: ["Bash", "Read", "Grep", "Glob"], // 声明可用工具
    sandbox: { enabled: true },                     // 开启沙箱模式
  }
});
for await (const msg of result) {
  // 处理消息流，SDK 自动执行 Bash 命令
}
```
**文档**：
- [Anthropic Tool Use Overview](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview)
- [Anthropic Bash Tool](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/bash-tool)
- [Anthropic Agents SDK](https://docs.anthropic.com/en/docs/agents-and-tools/agents-sdk/overview)

---

### 三、总结：适配层到底在做什么？

```
[ LLM/Agent 框架 ] 
      │
      │ 各自方言：
      │ LangChain -> ToolMessage(content, tool_call_id)
      │ OpenAI    -> {role: "tool", content: "..."}
      │ Anthropic -> {type: "tool_result", content: "..."}
      │
      ▼
[ 适配层 (Adapter) ]  ← 核心职责：方言 ↔ 普通话
      │
      │ 普通话（统一格式）：
      │ UnifiedToolCall { toolId, toolName, arguments: { command } }
      │ UnifiedToolResult { toolId, stdout, stderr, exitCode }
      │
      ▼
[ 执行层 (bash.ts) ]  ← 核心职责：真实执行
      │ spawn("/bin/bash") → 内核 VFS → FUSE 回调 → VectorStore → DB
      │
      ▼
[ 统一执行结果 ] → 返回给适配层 → 转回方言 → 喂给 LLM
```

**适配层不关心 FUSE、不关心数据库，它只负责“翻译消息”。** 真正的魔法都在 FUSE 挂载点里。