import type { KartonContract, ChatMessage, Chat } from '@stagewise/karton-contract';
import { createKartonServer } from '@stagewise/karton/server';
import type { ClaudeCodeAgentConfig, StreamEvent, ProcessHandle } from './types.js';
import { spawnClaudeCode } from './process-manager.js';
import { parseStreamJson } from './stream-parser.js';
import {
  buildStreamJsonMessage,
  serializeDomContext,
  extractScreenshots,
  extractPluginSnippets,
} from './prompt-builder.js';

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export class ClaudeCodeAgent {
  private static instance: ClaudeCodeAgent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private karton: any = null;
  private config: ClaudeCodeAgentConfig;
  private currentProcess: ProcessHandle | null = null;

  private constructor(config: ClaudeCodeAgentConfig) {
    this.config = config;
  }

  public static getInstance(config: ClaudeCodeAgentConfig): ClaudeCodeAgent {
    if (!ClaudeCodeAgent.instance) {
      ClaudeCodeAgent.instance = new ClaudeCodeAgent(config);
    }
    return ClaudeCodeAgent.instance;
  }

  public async initialize(): Promise<{ wss: unknown }> {
    this.karton = await createKartonServer<KartonContract>({
      procedures: {
        sendUserMessage: async (message: ChatMessage) => {
          await this.handleUserMessage(message);
        },
        createChat: async () => {
          return this.createAndActivateNewChat();
        },
        switchChat: async (chatId: string) => {
          this.karton?.setState((draft: KartonContract['state']) => {
            draft.activeChatId = chatId;
          });
        },
        deleteChat: async (chatId: string) => {
          if (this.karton!.state.activeChatId === chatId) {
            const nextChatId = Object.keys(this.karton!.state.chats).find(
              (id: string) => id !== chatId
            );
            if (!nextChatId) {
              this.createAndActivateNewChat();
            } else {
              this.karton?.setState((draft: KartonContract['state']) => {
                draft.activeChatId = nextChatId;
              });
            }
          }
          this.karton?.setState((draft: KartonContract['state']) => {
            delete draft.chats[chatId];
          });
        },
        abortAgentCall: async () => {
          this.abort();
        },
        retrySendingUserMessage: async () => {},
        approveToolCall: async () => {},
        rejectToolCall: async () => {},
        refreshSubscription: async () => {},
        undoToolCallsUntilUserMessage: async () => {},
        undoToolCallsUntilLatestUserMessage: async () => null,
        assistantMadeCodeChangesUntilLatestUserMessage: async () => false,
      },
      initialState: {
        activeChatId: null,
        chats: {},
        isWorking: false,
        toolCallApprovalRequests: [],
        subscription: undefined,
      },
    });

    this.createAndActivateNewChat();

    return {
      wss: this.karton.wss,
    };
  }

  private createAndActivateNewChat(): string {
    const chatId = generateId();
    const newChat: Chat = {
      title: 'New Chat',
      createdAt: new Date(),
      messages: [],
    };
    this.karton.setState((draft: KartonContract['state']) => {
      draft.chats[chatId] = newChat;
      draft.activeChatId = chatId;
    });
    return chatId;
  }

  private async handleUserMessage(message: ChatMessage): Promise<void> {
    if (!this.karton) return;

    const chatId = this.karton.state.activeChatId;
    if (!chatId) return;

    // 1. 更新状态为 working，并添加用户消息
    this.karton.setState((draft: KartonContract['state']) => {
      draft.isWorking = true;
      draft.chats[chatId]!.messages.push(message);
    });

    // 2. 构建输入
    type TextPart = { type: 'text'; text: string };
    type FilePart = { type: string; data?: string; mimeType?: string };

    const textPart = message.parts.find((p): p is TextPart => p.type === 'text');
    const input = {
      text: textPart?.text ?? '',
      domContext: serializeDomContext(message.metadata?.browserData),
      screenshots: extractScreenshots(message.parts as FilePart[]),
      pluginSnippets: extractPluginSnippets(message.metadata?.pluginContentItems),
    };

    const streamJsonMessage = buildStreamJsonMessage(input);

    // 3. spawn 子进程
    this.currentProcess = spawnClaudeCode(this.config, () => {
      this.karton?.setState((draft: KartonContract['state']) => {
        draft.isWorking = false;
      });
    });

    // 4. 发送消息
    this.currentProcess.process.stdin?.write(JSON.stringify(streamJsonMessage));
    this.currentProcess.process.stdin?.end();

    // 5. 创建 assistant 消息占位
    const assistantMessageId = generateId();
    this.karton.setState((draft: KartonContract['state']) => {
      draft.chats[chatId]!.messages.push({
        id: assistantMessageId,
        role: 'assistant',
        parts: [],
        metadata: { createdAt: new Date() },
      } as ChatMessage);
    });

    // 6. 流式解析输出
    try {
      for await (const event of parseStreamJson(this.currentProcess.process.stdout!)) {
        await this.handleStreamEvent(event, chatId, assistantMessageId);
      }
    } catch (error) {
      console.error('[claude-code] Stream error:', error);
    }

    // 7. 完成
    this.currentProcess = null;
    this.karton.setState((draft: KartonContract['state']) => {
      draft.isWorking = false;
    });
  }

  private async handleStreamEvent(
    event: StreamEvent,
    chatId: string,
    assistantMessageId: string
  ): Promise<void> {
    if (!this.karton) return;

    switch (event.type) {
      case 'assistant': {
        const textContent = event.message?.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');

        if (textContent) {
          this.karton.setState((draft: KartonContract['state']) => {
            const messages = draft.chats[chatId]!.messages;
            const msgIndex = messages.findIndex((m) => m.id === assistantMessageId);
            if (msgIndex !== -1) {
              const existingParts = messages[msgIndex]!.parts;
              const textPartIndex = existingParts.findIndex((p) => p.type === 'text');
              if (textPartIndex !== -1) {
                (existingParts[textPartIndex] as { type: 'text'; text: string }).text = textContent;
              } else {
                existingParts.push({ type: 'text', text: textContent } as ChatMessage['parts'][number]);
              }
            }
          });
        }
        break;
      }

      case 'result': {
        console.log('[claude-code] Task completed:', event.result);
        break;
      }

      case 'system': {
        if (event.subtype === 'init') {
          console.log('[claude-code] Initialized, session:', event.session_id);
        }
        break;
      }
    }
  }

  public abort(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
    this.karton?.setState((draft: KartonContract['state']) => {
      draft.isWorking = false;
    });
  }

  public shutdown(): void {
    this.abort();
  }
}
