import { textOf, type Entry } from '@modelctx-ai/ctx-protocol';

// 汉字、假名、谚文按两字一组切，其余按字母数字连成的词切。够全文检索和启发式用，不是分词器。
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]/u;

/** 文字切成小写的词：拉丁字母和数字按连续的一串，汉字按相邻两字（单个汉字自成一个）。去重。 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  let word = '';
  let han = '';
  const flushWord = (): void => {
    if (word) out.add(word);
    word = '';
  };
  const flushHan = (): void => {
    if (han.length === 1) out.add(han);
    else for (let i = 0; i + 1 < han.length; i += 1) out.add(han.slice(i, i + 2));
    han = '';
  };
  for (const char of text.toLowerCase()) {
    if (CJK.test(char)) {
      flushWord();
      han += char;
    } else if (WORD.test(char)) {
      flushHan();
      word += char;
    } else {
      flushWord();
      flushHan();
    }
  }
  flushWord();
  flushHan();
  return out;
}

/**
 * 两段文字的相似度，0..1：一方（3 个字符以上）是另一方的子串时是 1，否则是词集合的 Ochiai 系数
 * `|A ∩ B| / √(|A| · |B|)`。不区分大小写。
 */
export function textSimilarity(a: string, b: string): number {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return 0;
  if ((x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y))) return 1;
  const p = tokens(x);
  const q = tokens(y);
  if (p.size === 0 || q.size === 0) return 0;
  let shared = 0;
  for (const token of p) if (q.has(token)) shared += 1;
  return shared / Math.sqrt(p.size * q.size);
}

/** 余弦相似度，负数按 0 算；长度不同或有零向量时是 0。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.min(1, Math.max(0, dot / Math.sqrt(na * nb)));
}

/**
 * 一条日志渲染成一行给模型判断的文字。`tool` 角色的消息（工具输出）不进来：记忆里的文字可能被再次注入上下文，
 * 工具输出是外来内容，可能藏着指令。没有可渲染的内容时是空串。
 */
export function renderEntry(entry: Entry): string {
  switch (entry.type) {
    case 'message': {
      if (entry.message.role === 'tool') return '';
      const text = textOf(entry.message).trim();
      return text ? `${entry.message.role}：${text}` : '';
    }
    case 'event': {
      const text = entry.text?.trim();
      return text ? `[${entry.kind}] ${text}` : `[${entry.kind}]`;
    }
    default:
      return entry.text.trim() ? `summary：${entry.text.trim()}` : '';
  }
}

/** 一段日志渲染成文字，一条一行，跳过没有内容的。 */
export function renderEntries(entries: readonly Entry[]): string {
  return entries.map(renderEntry).filter(Boolean).join('\n');
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 把 `<memory>` 包裹用的标签从文字里去掉，免得记忆里的文字提前闭合包裹。 */
export function stripMemoryTags(text: string): string {
  return text.replaceAll(/<\/?\s*memory\s*>/giu, '');
}

export const DAY_MS = 86_400_000;

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
