// 一轮的事件流：先连上 SSE（`GET /v1/sessions/:id/events/stream`）再发事件；断了重连，每次连上都和历史
// （`GET /v1/sessions/:id/events`）对一遍，按事件 `id` 去重。流不重放：不对历史，断开期间的事件就丢了。
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { Logger } from '@modelctx-ai/ctx-protocol';

import { MAX_RECONNECTS } from './constants.ts';

export type StreamEvent = BetaManagedAgentsStreamSessionEvents;

/** 请求选项：每次调接口都带上（重试次数、额外的头）。 */
export interface RequestOptions {
  readonly maxRetries?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

function processedAt(event: StreamEvent | BetaManagedAgentsSessionEvent): string | undefined {
  const value = (event as { processed_at?: unknown }).processed_at;
  return typeof value === 'string' ? value : undefined;
}

function idOf(event: StreamEvent | BetaManagedAgentsSessionEvent): string | undefined {
  const value = (event as { id?: unknown }).id;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export class EventFeed {
  readonly #client: Anthropic;
  readonly #session: string;
  readonly #request: RequestOptions;
  readonly #logger: Logger;
  readonly #controller = new AbortController();
  readonly #seen = new Set<string>();
  /** 连上之前会话里最后一个事件：重连时从它起对历史。 */
  #anchor: { readonly id?: string; readonly at?: string } = {};
  /** 读到的最后一个落了库的事件的时刻。 */
  #last: string | undefined;
  #iterator: AsyncIterator<StreamEvent> | undefined;
  /** 对历史补上的、还没交出去的事件。 */
  #backlog: StreamEvent[] = [];
  #reconnects = 0;
  #closed = false;
  /** 正在读的下一个事件：前一次读还没回来时又来读（等的人不等了又回来读），拿同一个，免得两处同时读丢事件。 */
  #reading: Promise<StreamEvent | undefined> | undefined;

  constructor(client: Anthropic, session: string, request: RequestOptions, logger: Logger) {
    this.#client = client;
    this.#session = session;
    this.#request = request;
    this.#logger = logger;
  }

  /** 连上事件流（要预览增量：`event_deltas`），记下此刻会话里最后一个事件。发事件之前调。 */
  async open(): Promise<void> {
    await this.#connect();
    const page = await this.#client.beta.sessions.events.list(
      this.#session,
      { order: 'desc', limit: 1 },
      { ...this.#options(), signal: this.#controller.signal },
    );
    const last = page.data[0];
    if (last) {
      const id = idOf(last);
      const at = processedAt(last);
      this.#anchor = { ...(id ? { id } : {}), ...(at ? { at } : {}) };
      if (id) this.#seen.add(id);
    }
  }

  #options(): { maxRetries?: number; headers?: Record<string, string> } {
    return {
      ...(this.#request.maxRetries !== undefined ? { maxRetries: this.#request.maxRetries } : {}),
      ...(this.#request.headers ? { headers: { ...this.#request.headers } } : {}),
    };
  }

  async #connect(): Promise<void> {
    const stream = await this.#client.beta.sessions.events.stream(
      this.#session,
      { event_deltas: ['agent.message'] },
      { ...this.#options(), signal: this.#controller.signal },
    );
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  /** 断了以后：重新连上，再从上次读到的地方起对历史，补上没见过的。 */
  async #reconnect(cause: unknown): Promise<void> {
    if (this.#reconnects >= MAX_RECONNECTS) throw cause instanceof Error ? cause : new Error(String(cause));
    this.#reconnects += 1;
    const delay = Math.min(5_000, 250 * 2 ** this.#reconnects);
    this.#logger.warn('managed agents event stream dropped; reconnecting', {
      session: this.#session,
      attempt: this.#reconnects,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    await new Promise((resolve) => setTimeout(resolve, delay).unref());
    if (this.#closed) return;
    await this.#connect();
    const since = this.#last ?? this.#anchor.at;
    const missed: StreamEvent[] = [];
    for await (const event of this.#client.beta.sessions.events.list(
      this.#session,
      { order: 'asc', ...(since ? { 'created_at[gte]': since } : {}) },
      { ...this.#options(), signal: this.#controller.signal },
    )) {
      const id = idOf(event);
      if (id && this.#seen.has(id)) continue;
      missed.push(event);
    }
    this.#backlog.push(...missed);
  }

  /** 下一个没见过的事件；关掉了返回 `undefined`。 */
  next(): Promise<StreamEvent | undefined> {
    this.#reading ??= this.#read().finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  async #read(): Promise<StreamEvent | undefined> {
    for (;;) {
      if (this.#closed) return undefined;
      const queued = this.#backlog.shift();
      if (queued) {
        if (this.#accept(queued)) return queued;
        continue;
      }
      let result: IteratorResult<StreamEvent>;
      try {
        if (!this.#iterator) await this.#connect();
        result = await this.#iterator!.next();
      } catch (error) {
        if (this.#closed) return undefined;
        this.#iterator = undefined;
        await this.#reconnect(error);
        continue;
      }
      if (result.done) {
        if (this.#closed) return undefined;
        this.#iterator = undefined;
        await this.#reconnect(new Error('The event stream ended.'));
        continue;
      }
      // 连上以后读到了事件：重连的次数重新算。
      this.#reconnects = 0;
      if (this.#accept(result.value)) return result.value;
    }
  }

  #accept(event: StreamEvent): boolean {
    const id = event.type === 'event_start' || event.type === 'event_delta' ? undefined : idOf(event);
    if (id) {
      if (this.#seen.has(id)) return false;
      this.#seen.add(id);
    }
    const at = processedAt(event);
    if (at && (!this.#last || at > this.#last)) this.#last = at;
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#controller.abort();
  }
}
