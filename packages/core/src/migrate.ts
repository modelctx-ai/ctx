import { latestSummary, type CompactOptions, type SessionStore, type SummaryEntry } from '@modelctx-ai/ctx-protocol';
import type { LocalContextBuilder } from './builder.ts';

/** 一条受影响的旧摘要，`findLossySummaries` 的一项。 */
export interface LossySummary {
  readonly session: string;
  readonly summaryId: string;
  /** 旧摘要的 `covers`（已经按 `covers.seq` 解释）。 */
  readonly covers: number;
  /** 被新规则（`seq <= covers`）盖住、旧规则（`at > covers.at`）下可见的条目，`seq` 升序。 */
  readonly hidden: readonly number[];
}

export interface FindLossyOptions {
  /** 只看这一个会话；不给就看所有会话。 */
  readonly session?: string;
  /** 遍历会话时每页取多少个，缺省 100。 */
  readonly pageSize?: number;
}

/** 框架自己写的事件（`ctx.compacted` 之类）不算被盖住的内容。 */
function isFramework(kind: string): boolean {
  return kind.startsWith('ctx.');
}

async function inspect(store: SessionStore, session: string): Promise<LossySummary | null> {
  const summary: SummaryEntry | undefined = latestSummary(await store.list(session, { types: ['summary'] }));
  // 只看 `v` 为 0 的：新摘要的 `covers` 本来就是 seq，不会盖错。
  if (!summary || summary.v !== 0) return null;
  const entries = await store.list(session);
  // 旧摘要的 `covers` 是 `{ at, seq }`，升级时只留了 `seq`；`at` 取该 `seq` 的条目的时间。找不到就无从比较，跳过。
  const anchor = entries.find((entry) => entry.seq === summary.covers);
  if (!anchor) return null;
  const hidden = entries
    .filter((entry) => {
      if (entry.type === 'summary' || entry.seq > summary.covers || entry.at <= anchor.at) return false;
      return entry.type === 'message' || !isFramework(entry.kind);
    })
    .map((entry) => entry.seq);
  return hidden.length === 0 ? null : { session, summaryId: summary.id, covers: summary.covers, hidden };
}

/**
 * 只读。找出 `v` 为 0 的、有条目被新规则盖住的摘要。旧版本按时间（`covers.at`）判断哪些条目被摘要盖住，
 * 新版本按 `seq`，补写的旧记录（`at` 早、`seq` 大）和并发写入会因此有差别：晚到的条目 `seq` 小于 `covers`
 * 但 `at` 大于它，旧规则下可见，新规则下被盖住、模型再也看不到。
 * 条目里只数消息和非框架事件；事件进不进上下文取决于应用的事件规则，这里不知道，宁可多报。
 */
export async function findLossySummaries(store: SessionStore, options: FindLossyOptions = {}): Promise<LossySummary[]> {
  const found: LossySummary[] = [];
  if (options.session !== undefined) {
    const one = await inspect(store, options.session);
    return one ? [one] : [];
  }
  const limit = Math.max(1, Math.floor(options.pageSize ?? 100));
  let after: string | undefined;
  for (;;) {
    const names = await store.sessions({ limit, ...(after !== undefined ? { after } : {}) });
    for (const name of names) {
      const one = await inspect(store, name);
      if (one) found.push(one);
    }
    if (names.length < limit) return found;
    after = names.at(-1);
  }
}

/**
 * 对 `findLossySummaries` 的一条结果追加一条新摘要：`covers` 和旧摘要相同，输入是旧摘要的文字加上被盖住的条目，
 * 靠“`covers` 相同时后写的生效”取代旧摘要。不能用 `compact`：被盖住的条目若还在最近几条里，
 * `compact` 算出的 `covers` 会比旧摘要小，取代不了它。新摘要的 `v` 是当前版本，所以再跑 `findLossySummaries` 找不到它。
 * 模型输出被截断或为空时不写，返回 null。
 */
export function recompactLossy(
  builder: LocalContextBuilder,
  finding: LossySummary,
  options: CompactOptions = {},
): Promise<SummaryEntry | null> {
  return builder.recompact(finding, options);
}
