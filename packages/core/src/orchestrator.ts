import {
  CTX_EVENTS,
  headSeq,
  isConflict,
  messageEntry,
  runEndedEntry,
  silentLogger,
  type AgentSpec,
  type Entry,
  type Harness,
  type JsonObject,
  type Logger,
  type Orchestrator,
  type OrchestratorEvent,
  type RecoveredRun,
  type RunHandle,
  type RunRequest,
  type RunResult,
  type RunStatus,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';

import { interruptedResults } from './harness.ts';

/** `recover` 找到的断掉的运行，交给 `resume` 决定续不续跑。 */
export interface InterruptedRun {
  readonly session: string;
  readonly runId: string;
  /** 它的 `ctx.run.started` 里记下的 `AgentSpec`（`agentSpecToJson` 的结果：模型只剩名字，请求头打了码）。 */
  readonly agent: JsonObject;
  /** 补了错误结果的悬空工具调用有几个。 */
  readonly interrupted: number;
}

export interface OrchestratorOptions {
  readonly harness: Harness;
  /** 给 `recover` 用：扫描它的会话找断掉的运行。不给就没有 `recover`。 */
  readonly store?: SessionStore;
  /**
   * 部署者给的稳定实例名（例如 `yoyo`）。写进每个运行的 `ctx.run.started`，`recover` 只处理同一个 `owner`
   * 的断掉的运行（都没配置也算相同）：两个进程共用一个库时各配一个名字，互不收对方的运行。
   */
  readonly owner?: string;
  /**
   * `recover` 收了一个断掉的运行之后续不续跑：返回一个 `AgentSpec`，就用它在这个会话上提交一轮不带新输入的运行，
   * 从日志接着跑（`RecoveredRun.resumed` 是它的 `runId`）；返回 `undefined` 或不给这个选项，只结束不续跑。
   * 日志里存的 `AgentSpec` 模型只剩名字、请求头打了码，不能原样拿来跑，所以由应用按 `run.agent` 给出完整的。
   */
  readonly resume?: (run: InterruptedRun) => AgentSpec | undefined | Promise<AgentSpec | undefined>;
  /**
   * 结束的运行只留状态，给 `status` 查，最多留这么多个（缺省 1000），再多就从最早结束的开始忘，
   * 忘掉之后 `status` 返回 `undefined`。请求、结果这些大对象在运行结束时就放手，常驻进程的内存不随运行数增长。
   */
  readonly retainEnded?: number;
  readonly logger?: Logger;
}

export interface LocalOrchestrator extends Orchestrator {
  events(options?: { readonly signal?: AbortSignal }): AsyncIterable<OrchestratorEvent>;
}

interface Run {
  readonly runId: string;
  readonly session: string;
  readonly request: RunRequest;
  readonly controller: AbortController;
  readonly done: PromiseWithResolvers<RunResult>;
  status: RunStatus;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `recover` 一次向存储要多少个会话名。 */
const RECOVER_PAGE = 100;
/** 结束的运行留多少个状态。 */
const RETAIN_ENDED = 1000;

/** 断掉的运行里写下了调用、没有结果的工具调用（`id` → 工具名）。服务商执行的不算。 */
function danglingCalls(entries: readonly Entry[]): Map<string, string> {
  const open = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'message' || typeof entry.message.content === 'string') continue;
    for (const part of entry.message.content) {
      if (part.type === 'tool-call' && part.providerExecuted !== true) open.set(part.id, part.name);
      else if (part.type === 'tool-result') open.delete(part.id);
    }
  }
  return open;
}

/**
 * 进程内编排器：每个会话一条队列，同一会话的运行串行，不同会话并行；一个 harness。
 * `recover` 收 `owner` 相同、日志里最后一个生命周期事件是 `ctx.run.started`（没有配对的 `ctx.run.ended`）的运行：
 * 写下了调用、没有结果的工具调用补一条错误结果，再补 `ctx.run.ended`（`stopReason: error`），一次写入，带 `expectSeq`，
 * 读到写入之间会话有新条目就说明那个运行其实在动，跳过。给了 `resume` 的再按它续跑。
 */
export function createOrchestrator(options: OrchestratorOptions): LocalOrchestrator {
  const { harness, store } = options;
  const logger = options.logger ?? silentLogger;
  const retainEnded = Math.max(0, Math.floor(options.retainEnded ?? RETAIN_ENDED));
  /** 排着队和正在跑的运行。 */
  const runs = new Map<string, Run>();
  /** 结束的运行只剩状态，按结束的先后排，超过 `retainEnded` 就丢最早的。 */
  const finished = new Map<string, RunStatus>();
  /** 每个会话队尾的那一轮跑完的时刻。 */
  const tails = new Map<string, Promise<void>>();
  const listeners = new Set<(event: OrchestratorEvent) => void>();
  const closers = new Set<() => void>();
  let closed = false;

  function emit(run: Run, status: RunStatus): void {
    run.status = status;
    if (status !== 'queued' && status !== 'running') retire(run);
    const event: OrchestratorEvent = { type: `run.${status}`, runId: run.runId, session: run.session };
    for (const listener of listeners) listener(event);
  }

  /** 运行结束：从活动表里摘掉，只留状态。调用方手里的 `done` 不受影响。 */
  function retire(run: Run): void {
    runs.delete(run.runId);
    if (retainEnded === 0) return;
    finished.set(run.runId, run.status);
    for (const oldest of finished.keys()) {
      if (finished.size <= retainEnded) break;
      finished.delete(oldest);
    }
  }

  function skipped(run: Run): RunResult {
    return { runId: run.runId, text: '', messages: [], recorded: [], stopReason: 'aborted' };
  }

  async function execute(run: Run): Promise<void> {
    if (run.status !== 'queued') return;
    emit(run, 'running');
    try {
      const owner = run.request.owner ?? options.owner;
      const result = await harness.run({
        ...run.request,
        runId: run.runId,
        ...(owner !== undefined ? { owner } : {}),
        signal: run.controller.signal,
      });
      emit(run, result.stopReason === 'error' ? 'failed' : result.stopReason === 'aborted' ? 'cancelled' : 'completed');
      run.done.resolve(result);
    } catch (error) {
      logger.warn('run failed', { runId: run.runId, error: messageOf(error) });
      emit(run, 'failed');
      run.done.reject(error);
    }
  }

  const orchestrator: LocalOrchestrator = {
    async submit(request) {
      if (closed) throw new Error('Orchestrator is closed.');
      const runId = request.runId ?? crypto.randomUUID();
      if (runs.has(runId) || finished.has(runId)) throw new Error(`Run "${runId}" was already submitted.`);
      const controller = new AbortController();
      const run: Run = {
        runId,
        session: request.session,
        request,
        controller,
        done: Promise.withResolvers<RunResult>(),
        status: 'queued',
      };
      // 没人等 done 时，harness 抛错也不能变成未处理的 rejection。
      run.done.promise.catch(() => {});
      // 这一轮结束（跑完、取消、出错）就摘掉监听：调用方长期复用同一个 signal 时不会越积越多。
      if (request.signal) {
        const onAbort = (): void => void orchestrator.cancel(runId);
        request.signal.addEventListener('abort', onAbort, { once: true });
        void run.done.promise.then(
          () => request.signal?.removeEventListener('abort', onAbort),
          () => request.signal?.removeEventListener('abort', onAbort),
        );
      }
      runs.set(runId, run);
      emit(run, 'queued');
      const previous = tails.get(run.session) ?? Promise.resolve();
      const tail = previous.then(() => execute(run));
      tails.set(run.session, tail);
      void tail.finally(() => {
        if (tails.get(run.session) === tail) tails.delete(run.session);
      });
      if (request.signal?.aborted) await orchestrator.cancel(runId);
      return { runId, session: run.session, done: run.done.promise } satisfies RunHandle;
    },
    async status(runId) {
      return runs.get(runId)?.status ?? finished.get(runId);
    },
    async cancel(runId) {
      const run = runs.get(runId);
      if (!run) return false;
      if (run.status === 'queued') {
        emit(run, 'cancelled');
        run.done.resolve(skipped(run));
        return true;
      }
      if (run.status === 'running') {
        if (run.controller.signal.aborted) return false;
        run.controller.abort(new Error('Run cancelled.'));
        return true;
      }
      return false;
    },
    async *events(eventOptions = {}) {
      const { signal } = eventOptions;
      if (closed || signal?.aborted) return;
      const queue: OrchestratorEvent[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const listener = (event: OrchestratorEvent): void => {
        queue.push(event);
        wake?.();
      };
      const stop = (): void => {
        ended = true;
        wake?.();
      };
      listeners.add(listener);
      closers.add(stop);
      signal?.addEventListener('abort', stop, { once: true });
      try {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        listeners.delete(listener);
        closers.delete(stop);
        signal?.removeEventListener('abort', stop);
      }
    },
    async close() {
      closed = true;
      await Promise.allSettled(tails.values());
      for (const stop of closers) stop();
    },
  };

  if (store) {
    orchestrator.recover = async (): Promise<RecoveredRun[]> => {
      const recovered: RecoveredRun[] = [];
      for (let after: string | undefined; ;) {
        const page = await store.sessions({ limit: RECOVER_PAGE, ...(after !== undefined ? { after } : {}) });
        for (const session of page) {
          // 只看最后一个生命周期事件：它是 started 就是断掉的运行。不读消息正文，每个会话一次查询。
          const [last] = await store.list(session, {
            kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded],
            last: 1,
          });
          if (last?.type !== 'event' || last.kind !== CTX_EVENTS.runStarted) continue;
          const data = last.data as { runId?: unknown; owner?: unknown } | undefined;
          const runId = data?.runId;
          if (typeof runId !== 'string') continue;
          // 别的实例的运行不归这个编排器收。
          if ((typeof data?.owner === 'string' ? data.owner : undefined) !== options.owner) continue;
          // 这个编排器自己正在跑的不算断掉。
          if (runs.has(runId)) continue;
          // 写 ended 时带这个末尾：读和写之间会话有新条目，说明那个运行在动。只有找到断点的会话才多读这两次。
          const head = await headSeq(store, session);
          const open = danglingCalls(await store.list(session, { after: last.seq, types: ['message'] }));
          try {
            await store.append(
              session,
              [
                ...(open.size > 0 ? [messageEntry(interruptedResults(open), { source: 'orchestrator' })] : []),
                runEndedEntry({ runId, stopReason: 'error' }, { source: 'orchestrator' }),
              ],
              { expectSeq: head },
            );
          } catch (error) {
            // 读和写之间会话有新条目：那个运行在动，不收。
            if (isConflict(error)) continue;
            throw error;
          }
          const agent = await options.resume?.({
            session,
            runId,
            agent: ((data as { agent?: unknown }).agent ?? {}) as JsonObject,
            interrupted: open.size,
          });
          if (agent === undefined || closed) {
            recovered.push({ session, runId });
            continue;
          }
          const handle = await orchestrator.submit({ session, agent });
          recovered.push({ session, runId, resumed: handle.runId });
        }
        const next = page.at(-1);
        // 不满一页就是读完了；存储不认 `after` 时每页都一样，不能原地转圈。
        if (page.length < RECOVER_PAGE || next === undefined || next === after) break;
        after = next;
      }
      return recovered;
    };
  }

  return orchestrator;
}
