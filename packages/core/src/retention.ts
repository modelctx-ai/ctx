import { CTX_EVENTS, latestSummary, type SessionStore } from '@modelctx-ai/ctx-protocol';

export interface PruneOptions {
  /** 被摘要盖住的条目里，最后写入的这么多条留着。小数向下取整；不是有限的非负数时一条都不删。 */
  readonly keep?: number;
  /** 被摘要盖住的条目里，`at` 在这么多毫秒之内的留着。不是有限的非负数时一条都不删。 */
  readonly maxAgeMs?: number;
  /** 现在的时刻（毫秒），和 `maxAgeMs` 一起用，缺省 `Date.now`。 */
  readonly now?: () => number;
  /** 读被盖住的条目时一页多少条，缺省 500。 */
  readonly pageSize?: number;
}

/** 一个保留条件算出来的切点；选项不合法时是 0（不删）。 */
function bound(value: number, cut: (valid: number) => number): number {
  return Number.isFinite(value) && value >= 0 ? cut(value) : 0;
}

/**
 * 保留期：删掉一个会话里被生效的摘要盖住的旧历史，返回删掉的条数。应用自己决定什么时候调（压缩之后、每天一次……），
 * 这里没有定时器。只删 `seq` 小于等于摘要 `covers` 的条目，摘要自己和它之后的都不动，所以模型看到的上下文不变。
 *
 * - 不给 `keep` 和 `maxAgeMs`：被盖住的全删。
 * - `keep`：被盖住的条目里最后写入的 N 条留着。
 * - `maxAgeMs`：从最早的条目起往后删，删到第一条还在保留期内（`at` 不早于 `now() - maxAgeMs`）的为止；
 *   补写的旧记录 `at` 早但 `seq` 大，排在它前面的条目没过期就不会删到它。
 * - 两个都给：两个条件都放行的才删。
 *
 * 会话里有未结束的运行时不删到它的 `ctx.run.started`：删到了那一轮会被围栏停下。
 * 走的是 `truncate`，所以真的删了东西时会话末尾多一条 `ctx.erased`。
 */
export async function pruneSession(
  store: Pick<SessionStore, 'list' | 'truncate'>,
  session: string,
  options: PruneOptions = {},
): Promise<number> {
  const summary = latestSummary(await store.list(session, { types: ['summary'] }));
  if (!summary) return 0;
  // 摘要自己不删：正常情况下它的 `seq` 大于 `covers`，应用手写的摘要不一定。
  let upTo = Math.min(summary.covers, summary.seq - 1);
  const [last] = await store.list(session, { kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded], last: 1 });
  if (last?.type === 'event' && last.kind === CTX_EVENTS.runStarted) upTo = Math.min(upTo, last.seq - 1);

  if (options.keep !== undefined || options.maxAgeMs !== undefined) {
    const covered: { seq: number; at: number }[] = [];
    const pageSize = Math.max(1, Math.floor(options.pageSize ?? 500));
    for (let after = 0; after < upTo;) {
      const page = await store.list(session, { after, limit: pageSize });
      for (const entry of page) if (entry.seq <= upTo) covered.push({ seq: entry.seq, at: entry.at });
      const tail = page.at(-1);
      if (!tail || page.length < pageSize) break;
      after = tail.seq;
    }
    if (options.keep !== undefined) {
      const byCount = bound(options.keep, (keep) => covered.at(-Math.floor(keep) - 1)?.seq ?? 0);
      upTo = Math.min(upTo, byCount);
    }
    if (options.maxAgeMs !== undefined) {
      const now = (options.now ?? Date.now)();
      const byAge = bound(options.maxAgeMs, (maxAgeMs) => {
        const fresh = covered.findIndex((entry) => entry.at >= now - maxAgeMs);
        return (fresh < 0 ? covered.at(-1) : covered[fresh - 1])?.seq ?? 0;
      });
      upTo = Math.min(upTo, byAge);
    }
  }
  return upTo > 0 ? store.truncate(session, upTo) : 0;
}
