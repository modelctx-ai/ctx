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
  /** 夜里处理过的时刻；没有、也没进死信（`failedAt`）就是待处理。 */
  readonly settledAt?: number;
  /** 处理失败过几次（`fail` 记）；没失败过没有这一项。 */
  readonly attempts?: number;
  /** 最后一次失败的原因，写给人看。 */
  readonly error?: string;
  /** 失败次数到了上限、进死信的时刻。死信不算待处理，`retry` 放回去。 */
  readonly failedAt?: number;
}

/**
 * 写入的笔记：`id` 由存储生成。`settledAt` 可以直接给：门控没过的那段也写一条已处理的笔记（`settledAt` 等于 `at`），
 * 这样 `head` 照样前进，同一段日志不会被再打一次分，打过的分也留作阈值的分布。失败的记录只能由 `fail` 写。
 */
export type NewNote = Omit<Note, 'id' | 'attempts' | 'error' | 'failedAt'>;

/** `notes.list` 的筛选。结果按写入顺序。 */
export interface NoteQuery {
  readonly session?: string;
  /** `true` 只要待处理的（没有 `settledAt`、也没进死信），`false` 只要处理过的（有 `settledAt`）；不给不限。 */
  readonly pending?: boolean;
  /** `true` 只要死信（有 `failedAt`），`false` 不要死信；不给不限。 */
  readonly failed?: boolean;
  /** 只要 `at` 不早于它的。 */
  readonly since?: number;
  /** 最多返回多少条（最早写入的那些）。小数向下取整，不是正数时返回空；不给就不限。 */
  readonly limit?: number;
}

/** 记忆里的事实：一句能独立成立的话，带有效期、证据和召回记录。文字写入后不改。 */
export interface MemoryFact {
  readonly id: string;
  /**
   * 幂等键：一个作用域里不重复，`add`、`supersede` 遇到已有的键返回已有的那条、什么都不写。几个进程夜里处理同一批笔记时
   * 不会写出重复的事实。参考实现用来源区间加文字算。
   */
  readonly key?: string;
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
  /** 最近几次被召回的时刻，按记录先后，激活度公式里的 `t_i`。`touch` 追加，只留最后 `MAX_FACT_RECALLS` 个。 */
  readonly recalls: readonly number[];
  /** 归档的时刻；没有就是没归档。归档的事实退出 `open` 的查询，但不删：`search` 带 `archived` 还搜得到，`restore` 恢复。 */
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
  /**
   * 实现决定用全文、向量还是两者。至少要做到：`text` 和事实文字有共同的词（`searchTerms`：字母数字连成的一串算一个词，
   * 中日韩文字每相邻两个字算一个词）时命中，共同的词占得越多分越高（`termOverlap`）。多长都不报错：
   * 实现最多看 `MAX_SEARCH_TERMS` 个不同的词（`searchTerms(text, MAX_SEARCH_TERMS)`）。
   */
  readonly text: string;
  /** 按字面相等。 */
  readonly topic?: string;
  /** 最多返回多少条，缺省 10。小数向下取整，不是正数时返回空。 */
  readonly k?: number;
  /** `true`（缺省）只看仍然成立且没归档的；`false` 不限，连同关闭、归档的一起搜。 */
  readonly open?: boolean;
  /**
   * `true` 时仍然成立的事实里连归档的一起搜（关闭的还是不看）；缺省 `false`。`open: false` 时本来就不限，这一项不起作用。
   * 存储不给归档的事实降权，分数怎么打折由调用方定（参考实现的 `recall` 乘 0.5）。
   */
  readonly archived?: boolean;
}

/** `notes.fail` 的选项。 */
export interface FailNoteOptions {
  /** 失败的原因，记进 `Note.error`。 */
  readonly error: string;
  /** 失败几次进死信：这次记完 `attempts` 不小于它时写 `failedAt`。 */
  readonly maxAttempts: number;
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

/** 缺省的作用域：不调 `scope` 时存储读写的那一个。 */
export const DEFAULT_MEMORY_SCOPE = '';

/** 作用域名最长多少个字符（UTF-16 码元）。 */
export const MAX_MEMORY_SCOPE_LENGTH = 256;

/** 作用域名合法：字符串，不超过 `MAX_MEMORY_SCOPE_LENGTH`。空串是缺省的作用域。不合法抛 `invalid_request`。 */
export function checkMemoryScope(scope: unknown): asserts scope is string {
  if (typeof scope !== 'string') throw new CtxError('invalid_request', 'A memory scope must be a string.');
  if (scope.length > MAX_MEMORY_SCOPE_LENGTH) {
    throw new CtxError('invalid_request', `A memory scope is at most ${MAX_MEMORY_SCOPE_LENGTH} characters.`);
  }
}

/**
 * 记忆的存储：笔记、事实、程序、画像四个集合。全部只收发 JSON，可以放到进程边界另一侧；身份是字符串，由存储生成。
 * 时刻都由调用方给（毫秒），存储不看钟。错误用 `CtxError`：参数不合法是 `invalid_request`（例如没有证据、
 * `from > upTo`），认不得的 `id` 是 `not_found`；批量方法（`settle`、`fail`、`retry`、`touch`、`archive`、`restore`、
 * `reopen`、`forget`）跳过认不得的 `id`，不报错。每个方法单独是原子的：`supersede` 的「加新关旧」要么都成，要么都不成。
 * 几个进程共用一份存储时，同一段日志的笔记（`notes.add` 按区间）和同一个键的事实（`key`）只写一次。
 * 记忆只读会话日志，存储从不写它。
 *
 * 一份存储按作用域分开（`scope`）：一个用户、租户或项目一个作用域，名字由应用定。四个集合都在作用域里面，
 * 一个作用域读不到、搜不到、改不了、删不掉另一个作用域的东西；别的作用域的 `id` 和不存在的 `id` 一样对待
 * （`not_found`，批量方法跳过）。作用域是隔离，不是鉴权：谁能用哪个作用域由应用决定。
 */
export interface MemoryStore {
  /**
   * 同一份数据上名叫 `scope` 的作用域的视图。名字是绝对的，不嵌套：`store.scope('a').scope('b')` 就是 `store.scope('b')`，
   * `scope(DEFAULT_MEMORY_SCOPE)` 回到缺省的那个。从没写过的作用域是空的，不用先建。名字不合法（`checkMemoryScope`）
   * 抛 `invalid_request`。
   */
  scope(scope: string): MemoryStore;
  readonly notes: {
    /**
     * 按输入顺序返回写入的笔记（带 `id`）。区间不合法时整批不写，抛 `invalid_request`。同一个会话、同样的 `from` 和 `upTo`
     * 已经有笔记时不再写，返回已有的那条：两个进程同时门控同一段日志只留一条。
     */
    add(notes: readonly NewNote[]): Promise<Note[]>;
    list(query?: NoteQuery): Promise<Note[]>;
    /** 把待处理的标成处理过（`settledAt = at`），返回这次真正标上的条数；已经处理过的、死信不改。可重复调。 */
    settle(ids: readonly string[], at: number): Promise<number>;
    /**
     * 记一次处理失败：待处理的笔记 `attempts` 加 1、`error` 换成这次的；加完不小于 `maxAttempts` 时 `failedAt = at`，进死信。
     * 返回这次改了的笔记。处理过的、已经是死信的不改。
     */
    fail(ids: readonly string[], at: number, options: FailNoteOptions): Promise<Note[]>;
    /** 死信放回待处理：清掉 `failedAt`、`attempts`、`error`，返回放回的条数。不是死信的不改。 */
    retry(ids: readonly string[]): Promise<number>;
    /**
     * 删掉这个会话的笔记，不给会话就删掉作用域里全部的笔记；返回删掉的条数。删完 `head` 回到 0：会话日志还在的话，
     * 下次 `gate` 从头读。
     */
    forget(session?: string): Promise<number>;
    /** 这个会话的笔记（含处理过的、死信）覆盖到的最大 `seq`；没有就是 0。`gate` 从它之后读。 */
    head(session: string): Promise<number>;
  };
  readonly facts: {
    /** 没有证据或证据区间不合法时不写，抛 `invalid_request`。`key` 已经有了时不写，返回已有的那条。 */
    add(fact: NewMemoryFact): Promise<MemoryFact>;
    /**
     * 原子的「加新关旧」：写入 `fact`，再把 `id` 那条 `close(id, at, { supersededBy: 新的 })`，返回新写的。`id` 认不得时
     * 抛 `not_found`，什么都不写；`id` 已经关闭时只写新的。`fact.key` 已经有了时返回已有的那条，什么都不改。
     */
    supersede(id: string, fact: NewMemoryFact, at: number): Promise<MemoryFact>;
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
    /** 记一次召回：每个 `id` 的 `recalls` 追加 `at`，超过 `MAX_FACT_RECALLS` 个时丢掉最早的。 */
    touch(ids: readonly string[], at: number): Promise<void>;
    /** 归档（`archivedAt = at`），返回这次真正归档的条数；已经归档的不改。 */
    archive(ids: readonly string[], at: number): Promise<number>;
    /** 恢复归档的事实（清掉 `archivedAt`），返回这次真正恢复的条数；没归档的不改。有效期不动：关闭的恢复了还是关闭的。 */
    restore(ids: readonly string[]): Promise<number>;
    /** 撤销关闭：清掉 `validTo` 和 `supersededBy`，返回这次真正重新打开的条数；没关闭的不改。关错了的改回来用它。 */
    reopen(ids: readonly string[]): Promise<number>;
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
    /** 真删除，返回删掉的条数。 */
    forget(ids: readonly string[]): Promise<number>;
    list(query?: ProcedureQuery): Promise<Procedure[]>;
  };
  readonly core: {
    /** 最后写入的版本；从没写过是 null。 */
    get(): Promise<CoreVersion | null>;
    /** 追加一个版本，旧版本保留。回滚就是把旧版本的文字再 `set` 一次。 */
    set(text: string, at: number): Promise<void>;
    /** 历史版本，按写入顺序。 */
    history(options?: CoreHistoryOptions): Promise<CoreVersion[]>;
    /** 删掉全部版本（真删除，`get` 回到 null），返回删掉的个数。事实删了以后画像里还留着的，用它清。 */
    clear(): Promise<number>;
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
  /** `MemoryFact.confidence` 低于它的事实不召回。缺省由实现定（参考实现 0.5）；给 0 就不筛。 */
  readonly minConfidence?: number;
  /** 带回事实和程序的证据原文（`Recalled.evidence`）。工具调用时带，作为来源时不带。 */
  readonly evidence?: boolean;
  readonly signal?: AbortSignal;
}

export interface Recalled {
  /**
   * 按 `rankFacts` 排好，已经 `touch` 过（`recalls` 是 `touch` 之前读到的样子）。里面原先归档的已经恢复，
   * 返回的不带 `archivedAt`。
   */
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
  /** 这次处理失败、留着下次再试的笔记数（不含进了死信的）。 */
  readonly failed: number;
  /** 这次失败次数到了上限、进死信的笔记数。 */
  readonly dead: number;
  readonly facts: {
    readonly added: number;
    readonly merged: number;
    readonly superseded: number;
    readonly archived: number;
    /** 原文里找不到支撑、置信度被降下来的事实数。参考实现总是给；别的实现可以不给。 */
    readonly ungrounded?: number;
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

/**
 * `Memory.forget` 要删什么，几项可以一起给。删的都是真删除；画像从剩下的事实重新渲染（不经模型，
 * 删掉的内容不会被「上一版画像」带回来），历史版本一起清掉。
 */
export interface ForgetRequest {
  /** 这些事实。 */
  readonly facts?: readonly string[];
  /** 这些程序。 */
  readonly procedures?: readonly string[];
  /** 这个会话留下的：它的笔记，证据里有它的事实和程序（证据还指向别的会话的也删）。 */
  readonly session?: string;
  /** 这份记忆（它的作用域）里的全部：笔记、事实、程序、画像。 */
  readonly all?: boolean;
  readonly signal?: AbortSignal;
}

export interface ForgetReport {
  readonly notes: number;
  readonly facts: number;
  readonly procedures: number;
  /** 删掉的画像版本数（不含重新渲染后写的那一版）。 */
  readonly core: number;
}

/** 记忆作为工具时的工具名。输入 `{ query: string, since_days?: number }`。 */
export const MEMORY_RECALL_TOOL = 'recall';

/**
 * 记忆的门面：五个操作加删除，参考实现是 `@modelctx-ai/ctx-memory` 的 `createMemory(options)`。它本身是一个 `Executor`
 * （名字缺省 `memory`），`tools()` 报出 `recall` 工具。只读会话日志，从不写它；只有 `consolidate` 改写事实、程序和 `core`。
 */
export interface Memory extends Executor {
  /**
   * 白天：读会话里 `notes.head` 之后的新条目，打分，写笔记，返回写下的笔记。不改日志。
   * 门控没过的那段也写一条已处理的笔记（`settledAt` 等于 `at`），`head` 照样前进；没有新条目时返回空、什么都不写。
   */
  gate(session: string, options?: GateOptions): Promise<Note[]>;
  /**
   * 白天：按文字召回仍然成立的事实，按相似度和激活度排序（`rankFacts`），记一次 `touch`；带上匹配主题的程序。
   * 归档的事实也找（相似度打折），被召回的那些恢复成没归档的；`confidence` 低于 `minConfidence` 的不召回。
   */
  recall(query: string, options?: RecallOptions): Promise<Recalled>;
  /**
   * 夜里：处理待处理的笔记，衰减归档，重写 `core`。整体可重复执行：处理过的笔记不再处理。按批隔离：一批失败不挡后面的，
   * 失败的笔记留着（`notes.fail`），失败次数到上限进死信。
   */
  consolidate(options?: ConsolidateOptions): Promise<ConsolidateReport>;
  /** 删除（`ForgetRequest`）。和 `consolidate` 排同一个队，不会和夜里的处理交错。 */
  forget(request: ForgetRequest): Promise<ForgetReport>;
  /**
   * 作为来源：`core` 加按 `query` 召回的事实，渲染成文字；什么都没有时返回空。来源每一轮都会被调，
   * 所以它带出的事实不是每次都记 `touch`：实现要限制频率（参考实现是同一条事实一天记一次），不然被带出的事实
   * 激活度越滚越高，别的再也排不上。
   */
  source(options?: MemorySourceOptions): ContextSource;
  /** 作为工具：`recall`（`MEMORY_RECALL_TOOL`），绑定到这个执行环境（`executor` 是 `name`）。 */
  tools(): Promise<ToolDefinition[]>;
  /** 执行 `recall`：结果带事实、程序和证据原文。不认识的工具、输入不对、`signal` 已中止都返回 `{ type: 'error' }`。 */
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
}

// ---- 纯函数 ----

const DAY_MS = 86_400_000;

/** 一条事实最多留多少个召回时刻（`MemoryFact.recalls`）。`touch` 超过时丢掉最早的，激活度也只看这么多个。 */
export const MAX_FACT_RECALLS = 32;

/** 激活度和归档的缺省参数：衰减 `d`、`ε`、归档阈值 `archiveAt`。 */
export const ACTIVATION_DEFAULTS = { d: 0.5, epsilon: 0.02, archiveAt: 0.55 } as const;

export interface ActivationOptions {
  /** 衰减指数，缺省 0.5。 */
  readonly d?: number;
  /** 防止刚召回时 Δt 为 0 的偏移（天），缺省 0.02。 */
  readonly epsilon?: number;
}

/**
 * ACT-R 的基础激活：`A = ln Σᵢ (Δtᵢ + ε)^(−d) + s`，`Δtᵢ = |now − tᵢ| / 1 天`，`tᵢ` 是 `validFrom` 和最近
 * `MAX_FACT_RECALLS` 次召回，`s` 是 `salience`。晚于 `now` 的时刻按它离 `now` 有多远算：十天后才生效的事实和十天前
 * 生效的一样活跃，临近时回升，所以 `validFrom` 在未来的事实也会衰减。
 * 有上界：`ln((MAX_FACT_RECALLS + 1) · ε^(−d)) + s`，缺省参数下是 `5.45 + s`。夜间归档看它是不是低于 `archiveAt`；
 * 排序用的是压到 0..1 的 `retrievability`。
 */
export function activation(
  fact: Pick<MemoryFact, 'validFrom' | 'recalls' | 'salience'>,
  now: number,
  options?: ActivationOptions,
): number {
  const d = options?.d ?? ACTIVATION_DEFAULTS.d;
  const epsilon = options?.epsilon ?? ACTIVATION_DEFAULTS.epsilon;
  let sum = 0;
  for (const t of [fact.validFrom, ...fact.recalls.slice(-MAX_FACT_RECALLS)])
    sum += (Math.abs(now - t) / DAY_MS + epsilon) ** -d;
  return Math.log(sum) + fact.salience;
}

export interface RetrievabilityOptions extends ActivationOptions {
  /** 归档阈值，也就是提取阈值 `τ`，缺省 0.55。 */
  readonly archiveAt?: number;
}

/**
 * 激活度压到 0..1：ACT-R 的提取概率 `1 / (1 + e^(−(A − τ)))`，`τ` 是归档阈值 `archiveAt`（噪声取 1）。
 * 正好在阈值上是 0.5，刚写的事实（`s = 0.6`）约 0.88，一个月没动的约 0.16；召回再多也到不了 1。召回的排序用它，不直接用 `A`：
 * `A` 没有固定的量程，直接加权会盖过相似度。
 */
export function retrievability(
  fact: Pick<MemoryFact, 'validFrom' | 'recalls' | 'salience'>,
  now: number,
  options?: RetrievabilityOptions,
): number {
  const archiveAt = options?.archiveAt ?? ACTIVATION_DEFAULTS.archiveAt;
  return 1 / (1 + Math.exp(archiveAt - activation(fact, now, options)));
}

export interface RankOptions extends RetrievabilityOptions {
  /** 算激活度的时刻，缺省是当前时间。 */
  readonly now?: number;
  /** 两项的权重，缺省 `{ similarity: 0.6, activation: 0.4 }`。`activation` 乘的是 `retrievability`。 */
  readonly weights?: { readonly similarity: number; readonly activation: number };
}

/**
 * 召回的排序：`score = 0.6 × similarity + 0.4 × retrievability`，两项都在 0..1，从高到低，分数相同时保持输入顺序。
 * `scores` 是事实 `id` → 相似度（一般是 `FactHit.score`），没有的按 0 算。激活度最多贡献 0.4：
 * 相似度差 0.67 以上的，召回次数再多也翻不过来。
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
      score: weights.similarity * (scores[fact.id] ?? 0) + weights.activation * retrievability(fact, now, options),
    }))
    .toSorted((a, b) => b.score - a.score)
    .map((item) => item.fact);
}

// 中日韩文字没有空白分词：汉字、假名、谚文按相邻两个字切，其余按字母数字连成的词切。够全文检索用，不是分词器。
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]/u;

/** `search` 最多看查询里多少个不同的词。再长的查询也只是这么多次索引查找。 */
export const MAX_SEARCH_TERMS = 256;

/**
 * 文字切成检索用的词：先做 NFKC 归一（全角字母、半角假名并到一起）、转小写；字母和数字连成的一串是一个词，
 * 中日韩文字每相邻两个字是一个词（落单的一个字自成一个）。去重，按第一次出现的先后。
 * 给了 `max`、词又比它多时，取开头的一半和结尾的一半：长长的一段话，要问的事多半在头尾。
 * 存储的 `search` 和索引都用它切，所以同一句话在哪个实现上切出来的词都一样。
 */
export function searchTerms(text: string, max: number = Infinity): string[] {
  const out = new Set<string>();
  let word = '';
  let cjk: string[] = [];
  const flushWord = (): void => {
    if (word) out.add(word);
    word = '';
  };
  const flushCjk = (): void => {
    if (cjk.length === 1) out.add(cjk[0]!);
    else for (let i = 0; i + 1 < cjk.length; i += 1) out.add(cjk[i]! + cjk[i + 1]!);
    cjk = [];
  };
  for (const char of text.normalize('NFKC').toLowerCase()) {
    if (CJK.test(char)) {
      flushWord();
      cjk.push(char);
    } else if (WORD.test(char)) {
      flushCjk();
      word += char;
    } else {
      flushWord();
      flushCjk();
    }
  }
  flushWord();
  flushCjk();
  const terms = [...out];
  if (terms.length <= max) return terms;
  const size = Math.max(0, Math.floor(max));
  const head = Math.ceil(size / 2);
  return [...terms.slice(0, head), ...terms.slice(terms.length - (size - head))];
}

/**
 * 两组词的相似度，0..1：重叠系数 `shared / min(a, b)`，`shared` 是共同的词数，`a`、`b` 是两边各有多少个不同的词。
 * 一边的词全在另一边里就是 1，所以短的查询对长的事实、长的一段话对短的事实都打得出分（Ochiai 在长短悬殊时趋近 0）。
 * 任何一边没有词时是 0。
 */
export function termOverlap(shared: number, a: number, b: number): number {
  const smaller = Math.min(a, b);
  return smaller > 0 ? Math.min(1, shared / smaller) : 0;
}

/** 仍然成立（没有 `validTo`）且没归档。`FactQuery.open`、`SearchQuery.open` 的语义。 */
export function isOpenFact(fact: Pick<MemoryFact, 'validTo' | 'archivedAt'>): boolean {
  return fact.validTo === undefined && fact.archivedAt === undefined;
}

/** 这条事实在不在 `search` 要看的范围里：`topic`、`open`、`archived` 三项的语义写成纯函数，内存里的存储可以直接用。 */
export function inSearchScope(
  fact: Pick<MemoryFact, 'topic' | 'validTo' | 'archivedAt'>,
  query: Pick<SearchQuery, 'topic' | 'open' | 'archived'>,
): boolean {
  if (query.topic !== undefined && fact.topic !== query.topic) return false;
  if (query.open === false) return true;
  return fact.validTo === undefined && (query.archived === true || fact.archivedAt === undefined);
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
