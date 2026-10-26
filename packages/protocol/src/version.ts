import { messageFromModelMessage } from './ai-sdk.ts';
import type { Entry } from './session.ts';
import { CtxError } from './types.ts';

/**
 * 条目的格式版本，存储写进每一行（`EntryBase.v`）。
 *
 * - 0：没有 `v` 的行，即 0.2 及以前的写法：消息是 AI SDK 的 `ModelMessage` 原样，二进制和 URL 用 `\u0000ctx` 标记，
 *   摘要的 `covers` 是 `{ at, seq }`。
 * - 1：消息是 ctx 自己的 `Message`（全是 JSON），`covers` 是 `seq`。
 */
export const ENTRY_VERSION = 1;

/** 0 版编码标记用的键。新写法不再用它，只在读 0 版的行时还原。 */
const TAG = '\u0000ctx';

/** 只认恰好是编码结果的对象；别的对象（包括 `{ $url }`、`{ $bytes }` 这种）原样返回。 */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (typeof value !== 'object' || value === null) return value;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 2 && keys.includes(TAG)) {
    // 字节直接留成 base64，下面的转换本来就要 base64；`image` 的 `data` 字符串里不会出现冒号，不会和地址混。
    if (object[TAG] === 'bytes' && typeof object['base64'] === 'string') return object['base64'];
    if (object[TAG] === 'url' && typeof object['href'] === 'string' && URL.canParse(object['href'])) {
      return new URL(object['href']);
    }
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, revive(item)]));
}

type Raw = Record<string, unknown>;

/** 0 → 1。摘要的 `covers` 取 `covers.seq`；事件不变。 */
function upgradeFrom0(raw: Raw): Raw {
  if (raw['type'] === 'message') return { ...raw, message: messageFromModelMessage(revive(raw['message'])) };
  if (raw['type'] === 'summary') {
    const covers = raw['covers'];
    const seq = typeof covers === 'object' && covers !== null ? (covers as { seq?: unknown }).seq : covers;
    if (typeof seq !== 'number') throw new CtxError('unsupported_part', 'A v0 summary has no numeric covers.seq.');
    return { ...raw, covers: seq };
  }
  return raw;
}

/** `UPGRADES[n]` 把版本 n 的行升到 n + 1。 */
const UPGRADES: readonly ((raw: Raw) => Raw)[] = [upgradeFrom0];

/**
 * 把存储里读出来的一行（平铺的 JSON：条目的字段加上 `message` 或 `kind`/`text`/`data` 或 `text`/`covers`）
 * 升到当前格式，一步步往上升。没有 `v` 读作 0。比自己认识的更高的 `v` 抛 `unsupported_version`，不猜。
 *
 * 返回的条目形状是当前版本，`v` 还是这一行写入时的版本，用来认出旧行（例如 `findLossySummaries`）。
 * 所以只能传存储里的原始行，已经升过级的条目不要再传一遍。
 */
export function upgradeEntry(raw: unknown): Entry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CtxError('unsupported_version', 'An entry must be a JSON object.');
  }
  let row = raw as Raw;
  const stored = row['v'] ?? 0;
  if (typeof stored !== 'number' || !Number.isInteger(stored) || stored < 0 || stored > ENTRY_VERSION) {
    throw new CtxError(
      'unsupported_version',
      `Entry format version ${JSON.stringify(stored)} is newer than the version ${ENTRY_VERSION} this ctx supports. Upgrade @modelctx-ai/ctx-protocol.`,
    );
  }
  for (let version = stored; version < ENTRY_VERSION; version += 1) row = UPGRADES[version]!(row);
  return { ...row, v: stored } as unknown as Entry;
}
