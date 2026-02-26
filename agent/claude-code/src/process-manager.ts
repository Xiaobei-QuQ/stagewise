import { spawn, type ChildProcess } from 'node:child_process';
import type { ClaudeCodeAgentConfig, ProcessHandle } from './types.js';

export function spawnClaudeCode(
  config: ClaudeCodeAgentConfig,
  sessionId?: string,
  onExit?: (code: number | null) => void
): ProcessHandle {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  if (config.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (config.appendSystemPrompt) {
    args.push('--append-system-prompt', config.appendSystemPrompt);
  }

  if (config.allowedTools?.length) {
    args.push('--allowed-tools', ...config.allowedTools);
  }

  const proc = spawn(config.command, args, {
    cwd: config.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.on('exit', (code) => {
    onExit?.(code);
  });

  proc.stderr?.on('data', (data) => {
    console.error('[claude-code stderr]', data.toString());
  });

  return {
    process: proc,
    kill: () => {
      proc.kill('SIGTERM');
    },
  };
}
