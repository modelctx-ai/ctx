import type { Awaitable } from './types.ts';

export interface SourceContext {
  readonly thread: string;
  readonly signal?: AbortSignal;
}

/**
 * 生成那一刻才去取的上下文，例如当前任务、粘贴板、天气。
 * 返回的文字只在这一次调用里出现，不写进日志。
 */
export interface ContextSource {
  readonly name: string;
  collect(context: SourceContext): Awaitable<string | null | undefined>;
}

export interface Fact {
  readonly source: string;
  readonly text: string;
}

export function defineSource(name: string, collect: ContextSource['collect']): ContextSource {
  return { name, collect };
}

export interface CollectOptions extends SourceContext {
  /** 单个来源最多等多久，超时就当它这次没有内容。 */
  readonly timeoutMs?: number;
  readonly onError?: (source: string, error: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`context source "${name}" timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** 并行收集。某个来源出错或超时只影响它自己，顺序按来源列表。 */
export async function collectFacts(sources: readonly ContextSource[], options: CollectOptions): Promise<Fact[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context: SourceContext = options.signal
    ? { thread: options.thread, signal: options.signal }
    : { thread: options.thread };
  const results = await Promise.all(
    sources.map(async (source): Promise<Fact | null> => {
      try {
        const text = await withTimeout(Promise.resolve(source.collect(context)), timeoutMs, source.name);
        const trimmed = typeof text === 'string' ? text.trim() : '';
        return trimmed ? { source: source.name, text: trimmed } : null;
      } catch (error) {
        options.onError?.(source.name, error);
        return null;
      }
    }),
  );
  return results.filter((fact): fact is Fact => fact !== null);
}

export function renderFacts(facts: readonly Fact[], heading?: string): string {
  const lines = facts.map((fact) => fact.text);
  return (heading ? [heading, ...lines] : lines).join('\n');
}
