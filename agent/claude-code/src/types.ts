import type { ChildProcess } from 'node:child_process';

export interface ClaudeCodeAgentConfig {
  command: string;
  cwd: string;
  skipPermissions: boolean;
  appendSystemPrompt?: string;
  allowedTools?: string[];
}

export interface StreamJsonUserMessage {
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
          };
        }
    >;
  };
}

export interface StreamEvent {
  type: 'system' | 'assistant' | 'tool_use' | 'tool_result' | 'result';
  subtype?: string;
  message?: {
    id: string;
    content: Array<{ type: string; text?: string }>;
  };
  result?: string;
  session_id?: string;
  is_error?: boolean;
  duration_ms?: number;
}

export interface ClaudeCodeInput {
  text: string;
  domContext?: string;
  screenshots?: string[];
  pluginSnippets?: string[];
}

export interface ProcessHandle {
  process: ChildProcess;
  kill: () => void;
}
