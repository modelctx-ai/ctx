import {
  CTX_EVENTS,
  runEndedEntry,
  silentLogger,
  type Harness,
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

export interface OrchestratorOptions {
  readonly harness: Harness;
  /** 给 `recover` 用：扫描它的会话找断掉的运行。不给就没有 `recover`。 */
  readonly store?: SessionStore;
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

/**
 * 进程内编排器：每个会话一条队列，同一会话的运行串行，不同会话并行；一个 harness。
 * `recover` 给日志里有 `ctx.run.started` 没有 `ctx.run.ended` 的运行补一条 `ctx.run.ended`（`stopReason: error`），不续跑。
 */
export function createOrchestrator(options: OrchestratorOptions): LocalOrchestrator {
  const { harness, store } = options;
  const logger = options.logger ?? silentLogger;
  const runs = new Map<string, Run>();
  /** 每个会话队尾的那一轮跑完的时刻。 */
  const tails = new Map<string, Promise<void>>();
  const listeners = new Set<(event: OrchestratorEvent) => void>();
  const closers = new Set<() => void>();
  let closed = false;

  function emit(run: Run, status: RunStatus): void {
    run.status = status;
    const event: OrchestratorEvent = { type: `run.${status}`, runId: run.runId, session: run.session };
    for (const listener of listeners) listener(event);
  }

  function skipped(run: Run): RunResult {
    return { runId: run.runId, text: '', messages: [], recorded: [], stopReason: 'aborted' };
  }

  async function execute(run: Run): Promise<void> {
    if (run.status !== 'queued') return;
    emit(run, 'running');
    try {
      const result = await harness.run({ ...run.request, runId: run.runId, signal: run.controller.signal });
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
      if (runs.has(runId)) throw new Error(`Run "${runId}" was already submitted.`);
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
      return runs.get(runId)?.status;
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
      for (const session of await store.sessions()) {
        const open = new Set<string>();
        for (const entry of await store.list(session, { types: ['event'] })) {
          if (entry.type !== 'event') continue;
          const runId = (entry.data as { runId?: unknown } | undefined)?.runId;
          if (typeof runId !== 'string') continue;
          if (entry.kind === CTX_EVENTS.runStarted) open.add(runId);
          else if (entry.kind === CTX_EVENTS.runEnded) open.delete(runId);
        }
        for (const runId of open) {
          // 这个编排器自己正在跑的不算断掉。
          const known = runs.get(runId);
          if (known && (known.status === 'queued' || known.status === 'running')) continue;
          await store.append(session, [runEndedEntry({ runId, stopReason: 'error' }, { source: 'orchestrator' })]);
          recovered.push({ session, runId });
        }
      }
      return recovered;
    };
  }

  return orchestrator;
}
