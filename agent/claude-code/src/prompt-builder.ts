import type { ClaudeCodeInput, StreamJsonUserMessage } from './types.js';
import type { UserMessageMetadata } from '@stagewise/karton-contract';

export function buildPromptText(input: ClaudeCodeInput): string {
  const parts: string[] = [];

  if (input.domContext) {
    parts.push(`[用户选中的DOM元素]\n${input.domContext}`);
  }

  if (input.pluginSnippets?.length) {
    parts.push(`[项目上下文]\n${input.pluginSnippets.join('\n')}`);
  }

  parts.push(input.text);

  return parts.join('\n\n');
}

export function buildStreamJsonMessage(
  input: ClaudeCodeInput
): StreamJsonUserMessage {
  const content: StreamJsonUserMessage['message']['content'] = [];

  // 添加截图
  for (const screenshot of input.screenshots ?? []) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: screenshot,
      },
    });
  }

  // 添加文本
  content.push({ type: 'text', text: buildPromptText(input) });

  return { type: 'user', message: { role: 'user', content } };
}

export function serializeDomContext(
  browserData?: UserMessageMetadata['browserData']
): string | undefined {
  if (!browserData?.selectedElements?.length) return undefined;

  return browserData.selectedElements
    .map((el, i) => {
      const parts = [`元素 ${i + 1}:`];
      if (el.xpath) parts.push(`XPath: ${el.xpath}`);
      if (el.textContent) parts.push(`文本: ${el.textContent}`);
      if (el.attributes) parts.push(`属性: ${JSON.stringify(el.attributes)}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

export function extractPluginSnippets(
  pluginContentItems?: UserMessageMetadata['pluginContentItems']
): string[] {
  if (!pluginContentItems) return [];

  const snippets: string[] = [];
  for (const [pluginName, items] of Object.entries(pluginContentItems)) {
    for (const [itemName, item] of Object.entries(items)) {
      snippets.push(`[${pluginName}/${itemName}]\n${item.text}`);
    }
  }
  return snippets;
}

export function extractScreenshots(
  parts: Array<{ type: string; data?: string; mimeType?: string }>
): string[] {
  return parts
    .filter((p) => p.type === 'file' && p.mimeType?.startsWith('image/'))
    .map((p) => p.data!)
    .filter(Boolean);
}
