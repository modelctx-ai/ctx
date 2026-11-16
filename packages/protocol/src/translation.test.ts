// 英文译本和中文原文的同步检查（#50）。中文为准；英文译本落后时，规范里的名字、路径、类型（行内代码）和章节结构
// 对不上，这里就失败。措辞可以慢一步，形状不行。
import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vite-plus/test';

const ROOT = new URL('../../../', import.meta.url);

/** 中文为准、各有一份英文译本的文档。 */
const PAIRS = [
  { zh: 'docs/protocol.md', en: 'docs/en/protocol.md' },
  { zh: 'README.md', en: 'README.en.md' },
];

/** 行内代码里带中文的，英文译本里换成的写法。 */
const TRANSLATED_SPANS: Readonly<Record<string, string>> = {
  'truncate(session, 末尾)': 'truncate(session, end)',
  'remap(旧值)': 'remap(old)',
  'cancel(父 runId)': 'cancel(parent runId)',
  'ctx-conformance --url <地址>': 'ctx-conformance --url <address>',
};

const CJK = /[　-鿿＀-￯]/;

function body(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/** 正文里的行内代码，代码块里的不算。 */
function inlineCode(text: string): Set<string> {
  const prose = body(text).replaceAll(/^```[\s\S]*?^```/gm, '');
  return new Set([...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!));
}

function headingLevels(text: string): string[] {
  const prose = body(text).replaceAll(/^```[\s\S]*?^```/gm, '');
  return [...prose.matchAll(/^(#{1,6}) /gm)].map((match) => match[1]!);
}

async function read(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8');
}

describe('英文译本跟得上中文', () => {
  for (const { zh, en } of PAIRS) {
    test(`${en} 和 ${zh} 的行内代码一样`, async () => {
      const original = inlineCode(await read(zh));
      const translation = inlineCode(await read(en));
      const expected = new Set([...original].map((span) => TRANSLATED_SPANS[span] ?? span));
      const missing = [...expected].filter((span) => !translation.has(span));
      const extra = [...translation].filter((span) => !expected.has(span));
      expect({ missing, extra }, `更新 ${en}，再改它的 synced 日期`).toEqual({ missing: [], extra: [] });
      for (const span of expected) expect(span, `${zh} 里带中文的行内代码要在 TRANSLATED_SPANS 里`).not.toMatch(CJK);
    });

    test(`${en} 和 ${zh} 的章节层级一样`, async () => {
      expect(headingLevels(await read(en))).toEqual(headingLevels(await read(zh)));
    });
  }

  test('docs/en 的译本写明原文和同步日期', async () => {
    const text = await read('docs/en/protocol.md');
    expect(text).toMatch(/^translation_of: \.\.\/protocol\.md$/m);
    expect(text).toMatch(/^synced: \d{4}-\d{2}-\d{2}$/m);
  });
});
