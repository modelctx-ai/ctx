import type { ContextSource } from './context.ts';
import { filterSessions, type Entry } from './session.ts';
import { estimateTextTokens } from './tokens.ts';
import type { ExecutionContext, Executor, ToolCall, ToolDefinition, ToolOutput } from './tools.ts';
import { CtxError, type JsonValue } from './types.ts';

// ---- 存储 ----

/** 指向会话日志里的一段，证据永远指向原文。两端都含；`1 ≤ from ≤ upTo`。读原文：`list(session, { after: from - 1 })` 再取 `seq ≤ upTo` 的。 */
export interface SourceRef {
  readonly session: string;
  /** seq，含。 */
  readonly from: number;
  /** seq，含。 */
  readonly upTo: number;
}

/** 笔记：门控的结果，标记日志里哪一段值得夜里处理。只指向 `seq` 区间，不复制内容。 */
export interface Note {
  readonly id: string;
  readonly session: string;
  /** seq，含。 */
  readonly from: number;
  /** seq，含。 */
  readonly upTo: number;
  /** 打分时刻（毫秒）。 */
  readonly at: number;
  /** 0..1。 */
  readonly salience: number;
  /** 应用定义：`pref`、`obs`、`fail`、`ok`…… */
  readonly kind?: string;
  /** 应用定义的主题名。 */
  readonly topic?: string;
  /** 夜里处理过的时刻；没有就是待处理。 */
  readonly settledAt?: number;
}

/**
 * 写入的笔记：`id` 由存储生成。`settledAt` 可以直接给：门控没过的那段也写一条已处理的笔记（`settledAt` 等于 `at`），
 * 这样 `head` 照样前进，同一段日志不会被再打一次分，打过的分也留作阈值的分布。
 */
export type NewNote = Omit<Note, 'id'>;

/** `notes.list` 的筛选。结果按写入顺序。 */
export interface NoteQuery {
  readonly session?: string;
  /** `true` 只要待处理的（没有 `settledAt`），`false` 只要处理过的；不给不限。 */
  readonly pending?: boolean;
  /** 最多返回多少条（最早写入的那些）。小数向下取整，不是正数时返回空；不给就不限。 */
  readonly limit?: number;
}

/** 记忆里的事实：一句能独立成立的话，带有效期、证据和召回记录。文字写入后不改。 */
export interface MemoryFact {
  readonly id: string;
  /** `user`、`project:agent`……应用定义。 */
  readonly subject: string;
  readonly predicate?: string;
  /** 一句能独立成立的话。 */
  readonly text: string;
  readonly topic?: string;
  /** 从何时起成立（毫秒）。 */
  readonly validFrom: number;
  /** 到何时不再成立；没有就是仍然成立。`close` 写。 */
  readonly validTo?: number;
  /** 被哪条事实取代。`close` 写；被取代的那条 `forget` 时清掉。 */
  readonly supersededBy?: string;
  /** 0..1。 */
  readonly confidence: number;
  /** 0..1，激活度公式里的 `s`。 */
  readonly salience: number;
  /** 必填、非空：不允许没有证据的事实。`cite` 追加。 */
  readonly sources: readonly SourceRef[];
  /** 每次被召回的时刻，按记录先后，激活度公式里的 `t_i`。`touch` 追加。 */
  readonly recalls: readonly number[];
  /** 归档的时刻；没有就是没归档。归档的事实退出 `open` 的查询，但不删。 */
  readonly archivedAt?: number;
}

/** 写入的事实：`id` 由存储生成，`recalls` 从空开始；有效期、取代、归档只能由对应的方法改。 */
export type NewMemoryFact = Omit<MemoryFact, 'id' | 'validTo' | 'supersededBy' | 'recalls' | 'archivedAt'>;

/** 一次搜索命中：事实和相关度。 */
export interface FactHit {
  readonly fact: MemoryFact;
  /** 0..1，越大越相关。实现自定怎么归一：全文可以按名次或 bm25 除以最大值，向量用余弦。 */
  readonly score: number;
}

/**
 * `facts.list` 的筛选和分页。结果按 `id` 升序（码点序，和 `SessionStore.sessions` 按名字排一样）；
 * 翻页：`after` 给上一页最后一个 `id`。
 */
export interface FactQuery {
  /** 按字面相等。 */
  readonly subject?: string;
  /** 按字面相等。 */
  readonly topic?: string;
  /** `true` 只要仍然成立的（没有 `validTo`）且没归档的；`false` 或不给不限。 */
  readonly open?: boolean;
  /** 从 `id` 大于它的开始（不含），不必是存在的 `id`。 */
  readonly after?: string;
  /** 最多返回多少条。小数向下取整，不是正数时返回空；不给就不限。 */
  readonly limit?: number;
}

export interface SearchQuery {
  /** 实现决定用全文、向量还是两者。至少要做到：`text` 是事实文字的子串（3 个字符以上）时命中。 */
  readonly text: string;
  /** 按字面相等。 */
  readonly topic?: string;
  /** 最多返回多少条，缺省 10。小数向下取整，不是正数时返回空。 */
  readonly k?: number;
  /** `true`（缺省）只看仍然成立且没归档的；`false` 不限，连同关闭、归档的一起搜。 */
  readonly open?: boolean;
}

/** `facts.close` 的选项。 */
export interface CloseFactOptions {
  /** 取代它的事实的 `id`，必须已经存在：先 `add` 新的，再 `close` 旧的。 */
  readonly supersededBy?: string;
}

/** 程序记忆：遇到什么、该怎么做、证据。 */
export interface Procedure {
  readonly id: string;
  readonly topic?: string;
  /** 触发条件。 */
  readonly when: string;
  /** 动作。 */
  readonly do: string;
  /** 必填、非空。`confirm` 追加。 */
  readonly evidence: readonly SourceRef[];
  /** 独立确认次数：`add` 时是 1，每次 `confirm` 加 1。应用决定几次算生效（参考实现是 2）。 */
  readonly confirmations: number;
  /** 写入时刻（毫秒）。 */
  readonly at: number;
  /** 退役的时刻；没有就是仍然有效。 */
  readonly retiredAt?: number;
}

export type NewProcedure = Omit<Procedure, 'id' | 'confirmations' | 'retiredAt'>;

/** `procedures.list` 的筛选。结果按写入顺序。 */
export interface ProcedureQuery {
  /** 按字面相等。 */
  readonly topic?: string;
  /** `true` 只要没退役的；`false` 或不给不限。 */
  readonly active?: boolean;
}

/** 画像 `core` 的一个版本。 */
export interface CoreVersion {
  readonly text: string;
  readonly at: number;
}

/** `core.history` 的选项，和 `ListOptions.last` 一样。 */
export interface CoreHistoryOptions {
  /** 只要最后写入的 N 个版本，仍按写入顺序返回。小数向下取整，不是正数时返回空；不给就是全部。 */
  readonly last?: number;
}

/**
 * 记忆的存储：笔记、事实、程序、画像四个集合。全部只收发 JSON，可以放到进程边界另一侧；身份是字符串，由存储生成。
 * 时刻都由调用方给（毫秒），存储不看钟。错误用 `CtxError`：参数不合法是 `invalid_request`（例如没有证据、
 * `from > upTo`），认不得的 `id` 是 `not_found`；批量方法（`settle`、`touch`、`archive`、`forget`）跳过认不得的 `id`，不报错。
 * 记忆只读会话日志，存储从不写它。
 */
export interface MemoryStore {
  readonly notes: {
    /** 按输入顺序返回写入的笔记（带 `id`）。区间不合法时整批不写，抛 `invalid_request`。 */
    add(notes: readonly NewNote[]): Promise<Note[]>;
    list(query?: NoteQuery): Promise<Note[]>;
    /** 把待处理的标成处理过（`settledAt = at`），返回这次真正标上的条数；已经处理过的不改。可重复调。 */
    settle(ids: readonly string[], at: number): Promise<number>;
    /** 这个会话的笔记（含处理过的）覆盖到的最大 `seq`；没有就是 0。`gate` 从它之后读。 */
    head(session: string): Promise<number>;
  };
  readonly facts: {
    /** 没有证据或证据区间不合法时不写，抛 `invalid_request`。 */
    add(fact: NewMemoryFact): Promise<MemoryFact>;
    /**
     * 关闭有效期：`validTo = at`，给了 `supersededBy` 一并记下。事实的文字永不改写：变了就 `add` 新的、`close` 旧的。
     * 已经关闭的不改（第二次 `close` 什么都不做）。`id` 或 `supersededBy` 认不得时抛 `not_found`。
     */
    close(id: string, at: number, options?: CloseFactOptions): Promise<void>;
    /**
     * 追加证据（并入时用：同一件事又被说了一次），返回更新后的。文字、有效期都不变；和已有的完全相同的区间跳过，
     * 所以重复调不会重复记。`sources` 为空或不合法抛 `invalid_request`，`id` 认不得抛 `not_found`。
     */
    cite(id: string, sources: readonly SourceRef[]): Promise<MemoryFact>;
    /** 记一次召回：每个 `id` 的 `recalls` 追加 `at`。 */
    touch(ids: readonly string[], at: number): Promise<void>;
    /** 归档（`archivedAt = at`），返回这次真正归档的条数；已经归档的不改。 */
    archive(ids: readonly string[], at: number): Promise<number>;
    /** 真删除，连同别的事实里指向它的 `supersededBy` 一起清掉，返回删掉的条数。主人的权利。 */
    forget(ids: readonly string[]): Promise<number>;
    list(query?: FactQuery): Promise<MemoryFact[]>;
    /** 按相关度从高到低。 */
    search(query: SearchQuery): Promise<FactHit[]>;
  };
  readonly procedures: {
    /** 没有证据或证据区间不合法时不写，抛 `invalid_request`。 */
    add(procedure: NewProcedure): Promise<Procedure>;
    /**
     * 又一次独立确认：`evidence` 追加，`confirmations` 加 1，返回更新后的。和已有的完全相同的区间跳过；一段新的都没有时
     * 什么都不改（同一段证据不算第二次确认，重复调不会重复记）。`evidence` 为空或不合法抛 `invalid_request`，
     * `id` 认不得抛 `not_found`。
     */
    confirm(id: string, evidence: readonly SourceRef[]): Promise<Procedure>;
    /** `retiredAt = at`；已经退役的不改。`id` 认不得抛 `not_found`。 */
    retire(id: string, at: number): Promise<void>;
    list(query?: ProcedureQuery): Promise<Procedure[]>;
  };
  readonly core: {
    /** 最后写入的版本；从没写过是 null。 */
    get(): Promise<CoreVersion | null>;
    /** 追加一个版本，旧版本保留。回滚就是把旧版本的文字再 `set` 一次。 */
    set(text: string, at: number): Promise<void>;
    /** 历史版本，按写入顺序。 */
    history(options?: CoreHistoryOptions): Promise<CoreVersion[]>;
  };
}

// ---- 决策模型、提取模型 ----

/** 一次 `decide` 最多带多少个问题。超过时实现可以抛 `invalid_request`。 */
export const MAX_DECISION_QUESTIONS = 64;

export type DecisionQuestion =
  /** 是 / 否，回答 P(是)。 */
  | { readonly type: 'noul'; readonly instructions: string }
  /** 选一个：键是选项名，值是说明。至少一个选项。 */
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  /** 有序量表：从低到高的各档说明，至少两档。 */
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

export type DecisionAnswer =
  /** `noul` 是 P(是)，0..1。 */
  | { readonly type: 'noul'; readonly noul: number }
  /**
   * `probabilities` 的键和问题的 `criteria` 一样，和为 1；`choice` 是概率最大的那个；`confidence` 0..1，
   * 调用方据此决定要不要升级给 `LanguageModel`。
   */
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    }
  /**
   * `probabilities` 按问题的 `criteria` 逐档，和为 1；`score` 是归一到 0..1 的期望档位
   * `Σ pᵢ · i / (n − 1)`（`n` 档，`i` 从 0 数）。
   */
  | { readonly type: 'score'; readonly score: number; readonly probabilities: readonly number[] };

export interface DecisionRequest {
  /** 要判断的东西：文字或 JSON。 */
  readonly state: JsonValue;
  /** 问题名 → 问题，一次最多 `MAX_DECISION_QUESTIONS` 个，并行回答。 */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  /** 中止后 `decide` reject。 */
  readonly signal?: AbortSignal;
}

/**
 * 决策模型：单次前向、返回概率，只收输入 token、不产出文字（Cloudflare 叫 System One，例如 Clef、Jev）。
 * 输出总是合法的，但未必正确。跨边界时用名字字符串指代，和 `ModelRef` 一样。
 */
export interface DecisionModel {
  readonly name: string;
  /** 返回问题名 → 回答，键和 `questions` 一样，每个回答的 `type` 和问题一样。 */
  decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>>;
}

/**
 * 提取字段。找到时 `value` 的形状：`text` 是字符串；`number` 是数（`integer` 时是整数，`decimals` 时最多这么多位小数）；
 * `date` 是 `YYYY-MM-DD`；`datetime` 是 ISO 8601（`YYYY-MM-DDTHH:mm[:ss[.sss]]`，可带 `Z` 或 `±HH:mm`）；
 * `duration` 是秒数（非负）；`list` 是 `items` 类型的数组。
 */
export type ExtractionField =
  | { readonly type: 'text'; readonly instructions?: string }
  | {
      readonly type: 'number';
      readonly instructions?: string;
      readonly integer?: boolean;
      readonly decimals?: number;
      readonly unit?: string;
    }
  | { readonly type: 'date' | 'datetime' | 'duration'; readonly instructions?: string }
  | { readonly type: 'list'; readonly items: 'text' | 'number'; readonly instructions?: string };

export interface ExtractionAnswer {
  /** 形状见 `ExtractionField`；没找到是 null。 */
  readonly value: JsonValue;
  /** 输入里不存在这个值的概率，0..1。 */
  readonly pNull: number;
  /** 0..1。 */
  readonly confidence: number;
}

export interface ExtractionRequest {
  readonly state: JsonValue;
  /** 字段名 → 字段，数量不限。 */
  readonly fields: Readonly<Record<string, ExtractionField>>;
  /** 中止后 `extract` reject。 */
  readonly signal?: AbortSignal;
}

/** 提取模型：从输入里填字段（例如 Clairic）。和 `DecisionModel` 一样只收输入 token，输出合法但未必正确。 */
export interface ExtractionModel {
  readonly name: string;
  /** 返回字段名 → 回答，键和 `fields` 一样。 */
  extract(request: ExtractionRequest): Promise<Record<string, ExtractionAnswer>>;
}

// ---- 门面 Memory ----

export interface GateOptions {
  readonly signal?: AbortSignal;
}

export interface RecallOptions {
  /** 只要这个主题的事实和程序。 */
  readonly topic?: string;
  /** 最多几条事实。 */
  readonly k?: number;
  /** 事实文字的 token 预算（`estimateTextTokens`）。 */
  readonly budgetTokens?: number;
  /** 带回事实和程序的证据原文（`Recalled.evidence`）。工具调用时带，作为来源时不带。 */
  readonly evidence?: boolean;
  readonly signal?: AbortSignal;
}

export interface Recalled {
  /** 按 `rankFacts` 排好，已经 `touch` 过（返回的是 `touch` 之前读到的样子）。 */
  readonly facts: readonly MemoryFact[];
  readonly procedures: readonly Procedure[];
  /** 只在 `RecallOptions.evidence` 时有：返回的事实和程序的证据区间里的条目，按 `id` 去重，按会话、`seq` 排。 */
  readonly evidence?: readonly Entry[];
}

export interface ConsolidateOptions {
  /** 这一夜的时刻，缺省是当前时间。衰减、`settle`、`close`、`core.set` 都用它。 */
  readonly now?: number;
  readonly signal?: AbortSignal;
}

export interface ConsolidateReport {
  /** 这次处理（`settle`）的笔记数。 */
  readonly notes: number;
  readonly facts: {
    readonly added: number;
    readonly merged: number;
    readonly superseded: number;
    readonly archived: number;
  };
  readonly procedures: { readonly added: number; readonly confirmed: number };
  /** 升级给 `LanguageModel` 的判断数。 */
  readonly escalated: number;
  /** 重写了 `core` 没有。 */
  readonly core: boolean;
}

export interface MemorySourceOptions {
  /** 来源名，缺省 `memory`。 */
  readonly name?: string;
  /** 按会话给出召回用的文字；缺省取会话最近一条用户消息的文字。 */
  readonly query?: (session: string) => Promise<string>;
  /** 最多几条事实。 */
  readonly k?: number;
}

/** 记忆作为工具时的工具名。输入 `{ query: string, since_days?: number }`。 */
export const MEMORY_RECALL_TOOL = 'recall';

/**
 * 记忆的门面：五个操作，参考实现是 `@modelctx-ai/ctx-memory` 的 `createMemory(options)`。它本身是一个 `Executor`
 * （名字缺省 `memory`），`tools()` 报出 `recall` 工具。只读会话日志，从不写它；只有 `consolidate` 改写事实、程序和 `core`。
 */
export interface Memory extends Executor {
  /**
   * 白天：读会话里 `notes.head` 之后的新条目，打分，写笔记，返回写下的笔记。不改日志。
   * 门控没过的那段也写一条已处理的笔记（`settledAt` 等于 `at`），`head` 照样前进；没有新条目时返回空、什么都不写。
   */
  gate(session: string, options?: GateOptions): Promise<Note[]>;
  /** 白天：按文字召回仍然成立的事实，按相似度和激活度排序（`rankFacts`），记一次 `touch`；带上匹配主题的程序。 */
  recall(query: string, options?: RecallOptions): Promise<Recalled>;
  /** 夜里：处理待处理的笔记，衰减归档，重写 `core`。整体可重复执行：处理过的笔记不再处理。 */
  consolidate(options?: ConsolidateOptions): Promise<ConsolidateReport>;
  /** 作为来源：`core` 加按 `query` 召回的事实，渲染成文字；什么都没有时返回空。 */
  source(options?: MemorySourceOptions): ContextSource;
  /** 作为工具：`recall`（`MEMORY_RECALL_TOOL`），绑定到这个执行环境（`executor` 是 `name`）。 */
  tools(): Promise<ToolDefinition[]>;
  /** 执行 `recall`：结果带事实、程序和证据原文。不认识的工具、输入不对、`signal` 已中止都返回 `{ type: 'error' }`。 */
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
}

// ---- 纯函数 ----

const DAY_MS = 86_400_000;

/** 激活度和归档的缺省参数：衰减 `d`、`ε`、归档阈值 `archiveAt`。 */
export const ACTIVATION_DEFAULTS = { d: 0.5, epsilon: 0.02, archiveAt: 0.55 } as const;

export interface ActivationOptions {
  /** 衰减指数，缺省 0.5。 */
  readonly d?: number;
  /** 防止刚召回时 Δt 为 0 的偏移（天），缺省 0.02。 */
  readonly epsilon?: number;
}

/**
 * ACT-R 的基础激活：`A = ln Σᵢ (Δtᵢ + ε)^(−d) + s`，`Δtᵢ = (now − tᵢ) / 1 天`，`tᵢ ∈ { validFrom, ...recalls }`，
 * `s` 是 `salience`。晚于 `now` 的时刻按 `Δt = 0` 算。注入排序和夜间归档（低于 `archiveAt` 就归档）用同一个值。
 */
export function activation(
  fact: Pick<MemoryFact, 'validFrom' | 'recalls' | 'salience'>,
  now: number,
  options?: ActivationOptions,
): number {
  const d = options?.d ?? ACTIVATION_DEFAULTS.d;
  const epsilon = options?.epsilon ?? ACTIVATION_DEFAULTS.epsilon;
  let sum = 0;
  for (const t of [fact.validFrom, ...fact.recalls]) sum += (Math.max(0, now - t) / DAY_MS + epsilon) ** -d;
  return Math.log(sum) + fact.salience;
}

export interface RankOptions extends ActivationOptions {
  /** 算激活度的时刻，缺省是当前时间。 */
  readonly now?: number;
  /** 两项的权重，缺省 `{ similarity: 0.6, activation: 0.4 }`。 */
  readonly weights?: { readonly similarity: number; readonly activation: number };
}

/**
 * 召回的排序：`score = 0.6 × similarity + 0.4 × activation`，从高到低，分数相同时保持输入顺序。
 * `scores` 是事实 `id` → 相似度（一般是 `FactHit.score`），没有的按 0 算。
 */
export function rankFacts(
  facts: readonly MemoryFact[],
  scores: Readonly<Record<string, number>>,
  options?: RankOptions,
): MemoryFact[] {
  const now = options?.now ?? Date.now();
  const weights = options?.weights ?? { similarity: 0.6, activation: 0.4 };
  return facts
    .map((fact) => ({
      fact,
      score: weights.similarity * (scores[fact.id] ?? 0) + weights.activation * activation(fact, now, options),
    }))
    .toSorted((a, b) => b.score - a.score)
    .map((item) => item.fact);
}

/** 仍然成立（没有 `validTo`）且没归档。`FactQuery.open`、`SearchQuery.open` 的语义。 */
export function isOpenFact(fact: Pick<MemoryFact, 'validTo' | 'archivedAt'>): boolean {
  return fact.validTo === undefined && fact.archivedAt === undefined;
}

/** `FactQuery` 的语义写成纯函数：内存里的存储可以直接用。输入不必排序。 */
export function filterFacts(facts: readonly MemoryFact[], query?: FactQuery): MemoryFact[] {
  const kept = facts.filter(
    (fact) =>
      (query?.subject === undefined || fact.subject === query.subject) &&
      (query?.topic === undefined || fact.topic === query.topic) &&
      (query?.open !== true || isOpenFact(fact)),
  );
  const byId = new Map(kept.map((fact) => [fact.id, fact]));
  const options = {
    ...(query?.after !== undefined ? { after: query.after } : {}),
    ...(query?.limit !== undefined ? { limit: query.limit } : {}),
  };
  // 按码点序排、after、limit 和 SessionsOptions 的语义一样，直接借用。
  return filterSessions([...byId.keys()], options).map((id) => byId.get(id)!);
}

export interface RenderCoreOptions extends ActivationOptions {
  /** 算激活度的时刻，缺省是当前时间。 */
  readonly now?: number;
}

/**
 * `core` 的缺省写法（没有 `LanguageModel` 重写时用）：仍然成立的事实按激活度从高到低，一行一条，
 * 估算的 token（`estimateTextTokens`）超过 `budget` 之前停下。没有事实或预算不是正数时是空串。
 */
export function renderCore(facts: readonly MemoryFact[], budget: number, options?: RenderCoreOptions): string {
  if (!(budget > 0)) return '';
  const now = options?.now ?? Date.now();
  const ranked = facts
    .filter(isOpenFact)
    .map((fact) => ({ fact, a: activation(fact, now, options) }))
    .toSorted((x, y) => y.a - x.a);
  let text = '';
  for (const { fact } of ranked) {
    const next = text ? `${text}\n${fact.text}` : fact.text;
    if (estimateTextTokens(next) > budget) break;
    text = next;
  }
  return text;
}

/** 一段条目的证据区间：`from` 是最小的 `seq`，`upTo` 是最大的。条目为空或不属于 `session` 时抛 `invalid_request`。 */
export function sourceRef(session: string, entries: readonly Pick<Entry, 'session' | 'seq'>[]): SourceRef {
  if (entries.length === 0) throw new CtxError('invalid_request', 'A source needs at least one entry.');
  let from = Infinity;
  let upTo = -Infinity;
  for (const entry of entries) {
    if (entry.session !== session)
      throw new CtxError('invalid_request', `Entry seq ${entry.seq} belongs to "${entry.session}", not "${session}".`);
    from = Math.min(from, entry.seq);
    upTo = Math.max(upTo, entry.seq);
  }
  return { session, from, upTo };
}

/** 区间合法：会话名非空，`from`、`upTo` 是整数且 `1 ≤ from ≤ upTo`。存储写入前调，不合法抛 `invalid_request`。 */
export function checkSourceRef(ref: SourceRef): void {
  const valid =
    typeof ref.session === 'string' &&
    ref.session.length > 0 &&
    Number.isInteger(ref.from) &&
    Number.isInteger(ref.upTo) &&
    ref.from >= 1 &&
    ref.from <= ref.upTo;
  if (!valid) throw new CtxError('invalid_request', `Invalid source range: ${JSON.stringify(ref)}.`);
}

/** 证据必填：`refs` 非空且每一段都合法，否则抛 `invalid_request`。`facts.add`、`cite`、`procedures.add`、`confirm` 写入前调。 */
export function checkEvidence(refs: readonly SourceRef[]): void {
  if (refs.length === 0) throw new CtxError('invalid_request', 'Memory needs evidence: at least one source range.');
  for (const ref of refs) checkSourceRef(ref);
}

/** 两段证据是不是同一段。`cite`、`confirm` 去重用。 */
export function sameSourceRef(a: SourceRef, b: SourceRef): boolean {
  return a.session === b.session && a.from === b.from && a.upTo === b.upTo;
}

/** 条目在不在这段证据里。 */
export function inSourceRef(entry: Pick<Entry, 'session' | 'seq'>, ref: SourceRef): boolean {
  return entry.session === ref.session && entry.seq >= ref.from && entry.seq <= ref.upTo;
}
