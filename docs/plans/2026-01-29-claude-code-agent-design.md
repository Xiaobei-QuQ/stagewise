# Claude Code Agent 插件设计

## 概述

创建一个新的 agent 实现，通过调用 `claude-internal` CLI（公司内部基于 Claude Code 的工具）来替代官方的 Anthropic API 调用。用户在 stagewise toolbar 发送消息后，插件自主执行任务，实时流式展示执行过程，文件改动通过 HMR 自动更新到 localhost 页面。

## 设计目标

1. **复用 Claude Code 能力** - 利用其自主读取文件、运行命令、做测试等能力
2. **避免 API 费用** - 使用公司内部订阅，不需要额外 API key
3. **流式展示** - 实时展示 Claude Code 执行过程，支持用户中断
4. **丰富上下文** - 传递文本 + DOM 元素 + 截图 + 插件上下文

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Toolbar (React)                        │
│  用户输入 + DOM选择 + 截图 + 插件上下文                        │
└─────────────────────┬───────────────────────────────────────┘
                      │ WebSocket (Karton)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              agent/claude-code (新包)                        │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ ClaudeCodeAgent                                         ││
│  │  - 接收用户消息                                          ││
│  │  - 构建 prompt（文本 + DOM + 截图 + context snippets）    ││
│  │  - spawn claude-internal CLI                            ││
│  │  - 解析 stream-json 输出                                 ││
│  │  - 通过 Karton 实时推送状态到 Toolbar                     ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────┬───────────────────────────────────────┘
                      │ child_process.spawn
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              claude-internal CLI                            │
│  - 执行 AI 推理                                              │
│  - 自主读写文件、执行命令                                      │
│  - 输出 stream-json 格式                                     │
└─────────────────────────────────────────────────────────────┘
                      │
                      ▼ 文件改动
┌─────────────────────────────────────────────────────────────┐
│              用户的 Dev Server (Vite/Next/etc)              │
│  - HMR 检测文件变化                                          │
│  - 自动更新 localhost 页面                                   │
└─────────────────────────────────────────────────────────────┘
```

## 包结构

新包位置：`agent/claude-code/`

```
agent/claude-code/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # 导出入口
│   ├── ClaudeCodeAgent.ts    # 主类，对标现有 Agent.ts
│   ├── process-manager.ts    # 管理 claude-internal 子进程
│   ├── stream-parser.ts      # 解析 stream-json 输出
│   ├── prompt-builder.ts     # 构建 prompt（含 DOM、截图、snippets）
│   └── types.ts              # 类型定义
```

## 数据流

### 输入构建

将 Toolbar 上下文转换为 stream-json 格式：

```typescript
interface StreamJsonUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source: {
            type: 'base64';
            media_type: string;
            data: string;
          }
        }
    >;
  };
}

function buildStreamJsonMessage(input: ClaudeCodeInput): StreamJsonUserMessage {
  const content: StreamJsonUserMessage['message']['content'] = [];

  // 添加截图（base64 直接传递，无需临时文件）
  for (const screenshot of input.screenshots ?? []) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: screenshot,
      }
    });
  }

  // 添加文本（包含 DOM 上下文和插件 snippets）
  const textParts: string[] = [];
  if (input.domContext) {
    textParts.push(`[用户选中的DOM元素]\n${input.domContext}`);
  }
  if (input.pluginSnippets?.length) {
    textParts.push(`[项目上下文]\n${input.pluginSnippets.join('\n')}`);
  }
  textParts.push(input.text);

  content.push({ type: 'text', text: textParts.join('\n\n') });

  return { type: 'user', message: { role: 'user', content } };
}
```

### 输出解析

stream-json 消息类型映射：

| Claude Code 输出 | 转换为 Toolbar 状态 |
|-----------------|-------------------|
| `type: "system", subtype: "init"` | 初始化完成，开始工作 |
| `type: "assistant"` | AI 正在思考/回复，流式展示文本 |
| `type: "tool_use"` | 展示正在执行的工具（读文件、写文件、执行命令） |
| `type: "tool_result"` | 展示工具执行结果 |
| `type: "result"` | 任务完成，显示总结 |

## 核心实现

```typescript
class ClaudeCodeAgent {
  private process: ChildProcess | null = null;
  private karton: KartonServer<KartonContract>;
  private config: ClaudeCodeAgentConfig;

  async handleUserMessage(message: ChatMessage) {
    // 1. 更新状态为 working
    this.karton.setState(draft => { draft.isWorking = true; });

    // 2. 构建输入消息
    const input: ClaudeCodeInput = {
      text: message.parts.find(p => p.type === 'text')?.text ?? '',
      domContext: serializeDomContext(message.metadata?.browserData),
      screenshots: extractScreenshots(message.parts),
      pluginSnippets: message.metadata?.pluginContentItems?.map(i => i.content),
    };
    const streamJsonMessage = buildStreamJsonMessage(input);

    // 3. spawn 子进程
    this.process = spawn(this.config.command, [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ], { cwd: this.config.cwd });

    // 4. 发送消息
    this.process.stdin.write(JSON.stringify(streamJsonMessage));
    this.process.stdin.end();

    // 5. 流式解析输出
    for await (const event of parseStreamJson(this.process.stdout)) {
      await this.handleStreamEvent(event);
    }

    // 6. 完成
    this.karton.setState(draft => { draft.isWorking = false; });
  }

  async handleStreamEvent(event: StreamEvent) {
    switch (event.type) {
      case 'assistant':
        this.appendAssistantMessage(event.message.content);
        break;
      case 'tool_use':
        this.appendToolCall(event);
        break;
      case 'result':
        this.appendFinalResult(event);
        break;
    }
  }

  abort() {
    this.process?.kill('SIGTERM');
    this.karton.setState(draft => { draft.isWorking = false; });
  }
}
```

## 配置

```typescript
interface ClaudeCodeAgentConfig {
  // CLI 命令名，默认 'claude-internal'
  command: string;

  // 工作目录
  cwd: string;

  // 权限模式：跳过所有确认
  skipPermissions: boolean;

  // 可选：自定义 system prompt 追加内容
  appendSystemPrompt?: string;

  // 可选：限制可用工具
  allowedTools?: string[];
}
```

## CLI 集成

### 启动命令

```bash
# 原有方式（官方 agent）
stagewise dev

# 新增方式（使用 Claude Code agent）
stagewise dev --agent claude-code

# 指定自定义命令
stagewise dev --agent claude-code --claude-command "claude-internal"
```

### CLI 修改

```typescript
// apps/cli/src/index.ts
program
  .option('--agent <type>', 'Agent type: default | claude-code', 'default')
  .option('--claude-command <cmd>', 'Claude Code CLI command', 'claude-internal');

// apps/cli/src/server/agent-loader.ts
export async function loadAgent(config: Config) {
  if (config.agent === 'claude-code') {
    const { ClaudeCodeAgent } = await import('@stagewise/agent-claude-code');
    return ClaudeCodeAgent.getInstance({
      command: config.claudeCommand ?? 'claude-internal',
      cwd: config.workingDir,
      skipPermissions: true,
    });
  }
  const { Agent } = await import('@stagewise/agent-client');
  return Agent.getInstance();
}
```

## 复用与新写

| 复用 | 新写 |
|-----|-----|
| `karton-contract` - 状态和 RPC 定义 | `ClaudeCodeAgent` - 替代 API 调用 |
| `karton` - WebSocket 通信框架 | `process-manager` - 子进程管理 |
| Toolbar 完全不用改 | `stream-parser` - 解析 CLI 输出 |
| CLI 的 proxy/server 逻辑 | `prompt-builder` - 上下文序列化 |

## 决策总结

| 决策 | 选择 |
|-----|-----|
| 集成方式 | 新 agent 包 `agent/claude-code` |
| 执行方式 | spawn 子进程 |
| 输入格式 | `--input-format stream-json`（支持图片） |
| 输出格式 | `--output-format stream-json --verbose` |
| 上下文传递 | 文本 + DOM + 截图 + 插件 snippets |
| 权限模式 | `--dangerously-skip-permissions` |
| CLI 命令 | 可配置，默认 `claude-internal` |
