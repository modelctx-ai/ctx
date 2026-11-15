import { CTX_EVENTS, type Entry, type NewEntry, type SessionStore } from './session.ts';
import { CtxError, type JsonObject } from './types.ts';
import { ENTRY_VERSION, upgradeEntry } from './version.ts';

/** 导出文件第一行的 `format`。 */
export const SESSION_EXPORT_FORMAT = 'ctx.session';

/** 导出格式的版本，写在第一行的 `version` 里。比它新的文件 `importSession` 不读。 */
export const SESSION_EXPORT_VERSION = 1;

/** 导出文件的第一行。 */
export interface SessionExportHeader {
  readonly format: typeof SESSION_EXPORT_FORMAT;
  readonly version: number;
  /** 导出时的会话名。 */
  readonly session: string;
  /** 导出时刻（毫秒）。 */
  readonly exportedAt: number;
}

/** 导出文件的最后一行：有它才算导完，`entries` 是中间的条目行数。 */
export interface SessionExportEnd {
  readonly end: true;
  readonly entries: number;
}

export interface ExportSessionOptions {
  /** 一次从存储读多少条。缺省 500。 */
  readonly pageSize?: number;
  /**
   * 读到 `ctx.unreadable` 占位条目（存储在宽松模式下解不了的行）时怎么办。`throw`（缺省）：抛 `unreadable`，
   * 不把缺了一块的历史当成完整的导出去。`skip`：跳过那一行，别的照常导。
   */
  readonly unreadable?: 'throw' | 'skip';
  /** 写进第一行的 `exportedAt`。缺省 `Date.now`。 */
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

/** 导入时条目的 `id` 怎么办：保留、让目标存储重新生成，或者自己给一个映射（同样的输入要给同样的输出）。 */
export type ImportIds = 'keep' | 'new' | ((id: string) => string);

export interface ImportSessionOptions {
  /** 导到哪个会话。缺省是文件第一行记的会话名。 */
  readonly session?: string;
  /**
   * - `keep`（缺省）：保留 `id`。`id` 全局唯一，所以重复导入同一份文件不会写出第二份；也因此不能用来在同一个存储里
   *   复制会话（抛 `conflict`）。
   * - `new`：目标存储重新生成 `id`。重复导入会写出第二份。
   * - 函数：`id` 换成它的返回值，例如 `(id) => \`fork:${id}\``。同一份文件导两次还是只有一份。
   *
   * `ctx.compacted` 事件里的 `summaryId` 跟着一起换。
   */
  readonly ids?: ImportIds;
  /** 一次 `append` 最多多少条。缺省 200。摘要和 `ctx.compacted` 之前会先把攒着的写掉，所以一批可能更短。 */
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}

export interface ImportSessionResult {
  /** 导进了哪个会话。 */
  readonly session: string;
  /** 文件第一行。 */
  readonly header: SessionExportHeader;
  /** 读到的条目行数。 */
  readonly read: number;
  /** 真正写入的条数。 */
  readonly written: number;
  /** 目标会话里已经有（`id` 或 `key` 相同）而跳过的条数。 */
  readonly skipped: number;
  /**
   * 源存储的 `seq` 换成目标存储的：`seq` 小于等于它的条目里最后一条在目标会话里的 `seq`，一条都没有是 0。
   * 会话之外引用 `seq` 的东西（记忆的 `SourceRef`、应用自己存的位置）用它跟着改。
   */
  remap(seq: number): number;
}

export type CopySessionOptions = ExportSessionOptions & Omit<ImportSessionOptions, 'session'>;

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * 把一个会话导成 JSON Lines：第一行是 `SessionExportHeader`，中间每行一条条目（`list` 返回的形状，按 `seq` 升序），
 * 最后一行是 `SessionExportEnd`。每一段都以 `\n` 结尾，可以直接写进文件，也可以直接交给 `importSession`。
 *
 * 条目的形状是当前的 `ENTRY_VERSION`（旧版本写的行读出来已经升过级），所以每行的 `v` 都写成它。
 * 导出期间别人写进来的条目，读到哪算哪；要一份一致的快照，就在没人写的时候导。
 */
export async function* exportSession(
  store: Pick<SessionStore, 'list'>,
  session: string,
  options: ExportSessionOptions = {},
): AsyncGenerator<string, void, undefined> {
  const pageSize = positive(options.pageSize, 500);
  const header: SessionExportHeader = {
    format: SESSION_EXPORT_FORMAT,
    version: SESSION_EXPORT_VERSION,
    session,
    exportedAt: (options.now ?? Date.now)(),
  };
  yield `${JSON.stringify(header)}\n`;

  let after = 0;
  let entries = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const page = await store.list(session, { after, limit: pageSize });
    for (const entry of page) {
      after = entry.seq;
      if (entry.type === 'event' && entry.kind === CTX_EVENTS.unreadable) {
        if (options.unreadable === 'skip') continue;
        throw new CtxError(
          'unreadable',
          `Entry seq ${entry.seq} of "${session}" could not be read by its store, so the export would be incomplete. Pass unreadable: 'skip' to leave it out.`,
        );
      }
      entries += 1;
      yield `${JSON.stringify({ ...entry, v: ENTRY_VERSION })}\n`;
    }
    if (page.length < pageSize) break;
  }
  const end: SessionExportEnd = { end: true, entries };
  yield `${JSON.stringify(end)}\n`;
}

/** 任意切法的文本块拼成行；空行跳过。 */
async function* linesOf(source: string | Iterable<string> | AsyncIterable<string>): AsyncGenerator<string> {
  let rest = '';
  for await (const chunk of typeof source === 'string' ? [source] : source) {
    rest += chunk;
    let at = rest.indexOf('\n');
    while (at !== -1) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (line !== '') yield line;
      at = rest.indexOf('\n');
    }
  }
  if (rest.trim() !== '') yield rest.trim();
}

type Row = Record<string, unknown>;

function parseLine(line: string, number: number): Row {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CtxError('invalid_request', `Line ${number} of the session export is not JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CtxError('invalid_request', `Line ${number} of the session export is not a JSON object.`);
  }
  return value as Row;
}

function readHeader(row: Row): SessionExportHeader {
  if (row['format'] !== SESSION_EXPORT_FORMAT || typeof row['session'] !== 'string') {
    throw new CtxError(
      'invalid_request',
      `Not a session export: the first line must be a header with format "${SESSION_EXPORT_FORMAT}".`,
    );
  }
  const version = row['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > SESSION_EXPORT_VERSION) {
    throw new CtxError(
      'unsupported_version',
      `Session export version ${JSON.stringify(version)} is not one this ctx reads (up to ${SESSION_EXPORT_VERSION}). Upgrade @modelctx-ai/ctx-protocol.`,
    );
  }
  return {
    format: SESSION_EXPORT_FORMAT,
    version,
    session: row['session'],
    exportedAt: typeof row['exportedAt'] === 'number' ? row['exportedAt'] : 0,
  };
}

const ENTRY_TYPES: readonly unknown[] = ['message', 'event', 'summary'];

/** 追加时由存储填的字段不带过去。 */
function draftOf(entry: Entry): Record<string, unknown> {
  const { session: _session, seq: _seq, v: _v, ...draft } = entry as Entry & Record<string, unknown>;
  return draft;
}

/** 目标会话里已有条目的位置，重复导入时用来找回被跳过的条目的 `seq`。 */
async function indexSession(
  store: Pick<SessionStore, 'list'>,
  session: string,
): Promise<{ readonly ids: Map<string, number>; readonly keys: Map<string, number> }> {
  const ids = new Map<string, number>();
  const keys = new Map<string, number>();
  let after = 0;
  for (;;) {
    const page = await store.list(session, { after, limit: 500 });
    for (const entry of page) {
      after = entry.seq;
      ids.set(entry.id, entry.seq);
      if (entry.key !== undefined) keys.set(entry.key, entry.seq);
    }
    if (page.length < 500) return { ids, keys };
  }
}

/**
 * 把 `exportSession` 导出的内容写进一个存储。`source` 是整份文本，或者按任意位置切开的文本块（文件流、
 * `exportSession` 的返回值都行）。
 *
 * `seq` 由目标存储重新分配，所以引用 `seq` 的字段跟着换：摘要的 `covers`、`ctx.compacted` 的 `covers`
 * 换成 `remap` 的结果（见 `ImportSessionResult.remap`）——源会话里被摘要盖住的条目，导过去还是那些被盖住。
 * 条目的 `at`、`key`、`source`、`meta` 原样保留。
 *
 * 不是一个原子操作：按批写，中途失败时已经写的留在目标会话里。保留 `id`（缺省）或者给了映射函数时，拿完整的文件
 * 再导一次就接上了，已有的条目跳过。没有 `SessionExportEnd` 的文件（截断了）读到头抛 `invalid_request`。
 *
 * 不检查目标会话是不是空的：往有内容的会话里导，导进来的摘要会把原有的条目一起盖住。
 */
export async function importSession(
  store: Pick<SessionStore, 'append' | 'list'>,
  source: string | Iterable<string> | AsyncIterable<string>,
  options: ImportSessionOptions = {},
): Promise<ImportSessionResult> {
  const batchSize = positive(options.batchSize, 200);
  const ids = options.ids ?? 'keep';
  const mapId = (id: string): string | undefined => (ids === 'keep' ? id : ids === 'new' ? undefined : ids(id));

  // 源和目标的 `seq`，各自升序，一一对应。
  const sourceSeqs: number[] = [];
  const targetSeqs: number[] = [];
  const remap = (seq: number): number => {
    let low = 0;
    let high = sourceSeqs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sourceSeqs[middle]! <= seq) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? 0 : targetSeqs[low - 1]!;
  };
  // `ids: 'new'` 时摘要的新 `id`，给后面的 `ctx.compacted` 用。
  const summaryIds = new Map<string, string>();

  let header: SessionExportHeader | undefined;
  let session = '';
  let ended: number | undefined;
  let read = 0;
  let written = 0;
  let skipped = 0;
  let lastSeq = 0;
  let existing: Awaited<ReturnType<typeof indexSession>> | undefined;
  let pending: { readonly entry: Entry; readonly draft: Record<string, unknown> }[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    options.signal?.throwIfAborted();
    const batch = pending;
    pending = [];
    const result = await store.append(
      session,
      batch.map((item) => item.draft as unknown as NewEntry),
    );
    let next = 0;
    for (const { entry, draft } of batch) {
      const candidate = result[next];
      const id = draft['id'] as string | undefined;
      // 返回的条目和交进去的同序，跳过的那几条不在里面：给了 `id` 的按 `id` 认，没给的只可能因为 `key` 被跳过。
      const matches =
        candidate !== undefined &&
        (id !== undefined ? candidate.id === id : entry.key === undefined || candidate.key === entry.key);
      let seq: number | undefined;
      if (matches) {
        next += 1;
        written += 1;
        seq = candidate.seq;
        if (entry.type === 'summary') summaryIds.set(entry.id, candidate.id);
      } else {
        existing ??= await indexSession(store, session);
        seq =
          (id === undefined ? undefined : existing.ids.get(id)) ??
          (entry.key === undefined ? undefined : existing.keys.get(entry.key));
        if (seq === undefined) {
          throw new CtxError(
            'conflict',
            `Entry "${id ?? entry.id}" was not written to "${session}": its id already exists in another session of the target store. Import with ids: 'new' or an id mapping.`,
          );
        }
        skipped += 1;
        if (entry.type === 'summary' && id !== undefined) summaryIds.set(entry.id, id);
      }
      sourceSeqs.push(entry.seq);
      // 重复导入时旧的条目可能排在后写的后面，映射只要不往回走。
      targetSeqs.push(Math.max(seq, targetSeqs.at(-1) ?? 0));
    }
  };

  let number = 0;
  for await (const line of linesOf(source)) {
    number += 1;
    const row = parseLine(line, number);
    if (header === undefined) {
      header = readHeader(row);
      session = options.session ?? header.session;
      continue;
    }
    if (ended !== undefined) {
      throw new CtxError('invalid_request', `Line ${number} of the session export comes after its end line.`);
    }
    if (row['end'] === true) {
      ended = typeof row['entries'] === 'number' ? row['entries'] : -1;
      continue;
    }
    if (!ENTRY_TYPES.includes(row['type']) || typeof row['seq'] !== 'number' || typeof row['id'] !== 'string') {
      throw new CtxError('invalid_request', `Line ${number} of the session export is not an entry.`);
    }
    // 导出时每行的 `v` 是那时的 `ENTRY_VERSION`；旧版本导出的文件在这里升上来，比自己新的抛 `unsupported_version`。
    const entry = upgradeEntry(row);
    if (entry.seq <= lastSeq) {
      throw new CtxError('invalid_request', `Line ${number} of the session export is out of order (seq ${entry.seq}).`);
    }
    lastSeq = entry.seq;
    read += 1;

    const draft = draftOf(entry);
    const id = mapId(entry.id);
    if (id === undefined) delete draft['id'];
    else draft['id'] = id;

    if (entry.type === 'summary') {
      await flush();
      // 摘要盖住的是它之前的条目；指到自己之后的位置时按它之前最后一条算。
      draft['covers'] = remap(Math.min(entry.covers, entry.seq - 1));
    } else if (entry.type === 'event' && typeof entry.data === 'object' && entry.data !== null) {
      if (entry.kind === CTX_EVENTS.compacted) {
        await flush();
        const data = { ...(entry.data as JsonObject) };
        if (typeof data['covers'] === 'number') data['covers'] = remap(Math.min(data['covers'], entry.seq - 1));
        const summaryId = data['summaryId'];
        if (typeof summaryId === 'string') {
          data['summaryId'] = summaryIds.get(summaryId) ?? mapId(summaryId) ?? summaryId;
        }
        draft['data'] = data;
      } else if (entry.kind === CTX_EVENTS.erased) {
        await flush();
        // 擦除记录只留还指得到的位置：涂改的占位在文件里，换成新的 `seq`；删掉的条目不在文件里，没有位置可指。
        const data = { ...(entry.data as JsonObject) };
        if (typeof data['upTo'] === 'number') data['upTo'] = remap(data['upTo']);
        if (Array.isArray(data['seqs'])) {
          data['seqs'] = data['seqs'].flatMap((seq) => {
            const at = typeof seq === 'number' ? sourceSeqs.indexOf(seq) : -1;
            return at === -1 ? [] : [targetSeqs[at]!];
          });
        }
        draft['data'] = data;
      }
    }
    pending.push({ entry, draft });
    if (pending.length >= batchSize) await flush();
  }
  await flush();

  if (header === undefined) throw new CtxError('invalid_request', 'The session export is empty.');
  if (ended === undefined) {
    throw new CtxError(
      'invalid_request',
      `The session export has no end line: it was cut off after ${read} entries. They were imported into "${session}"; import the complete export to finish.`,
    );
  }
  if (ended !== read) {
    throw new CtxError('invalid_request', `The session export says it has ${ended} entries but ${read} were read.`);
  }
  return { session, header, read, written, skipped, remap };
}

/**
 * 把会话 `from` 从 `source` 复制成 `target` 里的 `to`：`exportSession` 接 `importSession`。
 * 两个存储是同一个对象时 `ids` 缺省是 `new`（`id` 全局唯一，保留的话一条都写不进去），否则是 `keep`。
 * 同一个库的两个客户端看不出来是同一个，这时自己给 `ids`。
 */
export function copySession(
  source: Pick<SessionStore, 'list'>,
  from: string,
  target: Pick<SessionStore, 'append' | 'list'>,
  to: string,
  options: CopySessionOptions = {},
): Promise<ImportSessionResult> {
  const same = (source as unknown) === target;
  return importSession(target, exportSession(source, from, options), {
    ...options,
    session: to,
    ids: options.ids ?? (same ? 'new' : 'keep'),
  });
}
