import type { Readable } from 'node:stream';
import type { StreamEvent } from './types.js';

export async function* parseStreamJson(
  stdout: Readable
): AsyncGenerator<StreamEvent> {
  let buffer = '';

  for await (const chunk of stdout) {
    buffer += chunk.toString();

    // 按行分割处理
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // 保留最后一个不完整的行

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        yield event;
      } catch {
        // 跳过无法解析的行
        console.warn('[stream-parser] Failed to parse line:', trimmed);
      }
    }
  }

  // 处理最后剩余的内容
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as StreamEvent;
      yield event;
    } catch {
      console.warn('[stream-parser] Failed to parse final buffer:', buffer);
    }
  }
}
