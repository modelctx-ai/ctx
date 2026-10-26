import type { RunRequest, RunResult } from './harness.ts';

/**
 * 一次提交的运行处在哪一步。`completed`：跑完了；`failed`：`stopReason` 是 `error` 或 harness 抛错；
 * `cancelled`：被 `cancel` 或 `signal` 取消。
 */
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 提交后拿到的句柄。`done` 是进程内的等待方式；跨边界时用 `status` 轮询或订阅 `events`。 */
export interface RunHandle {
  readonly runId: string;
  readonly session: string;
  readonly done: Promise<RunResult>;
}

export interface OrchestratorEvent {
  readonly type: `run.${RunStatus}`;
  readonly runId: string;
  readonly session: string;
}

/** `recover` 找到并处理过的运行：日志里有 `ctx.run.started` 没有 `ctx.run.ended`。 */
export interface RecoveredRun {
  readonly session: string;
  readonly runId: string;
}

/**
 * 编排：什么时候、在哪个会话上跑一轮。协议只定最小的一组；链式、路由、并行、编排者-工作者这些模式由应用用
 * `Harness.run` 组合。
 */
export interface Orchestrator {
  /** 排进队列。同一会话的运行串行，不同会话并行。 */
  submit(request: RunRequest): Promise<RunHandle>;
  /** 不认识的 `runId` 返回 undefined。 */
  status(runId: string): Promise<RunStatus | undefined>;
  /** 取消排队中或运行中的一轮，返回是否真的取消了。 */
  cancel(runId: string): Promise<boolean>;
  /** 崩溃后：给断掉的运行补一条 `ctx.run.ended`（`stopReason: error`）或续跑，由实现决定。 */
  recover?(): Promise<RecoveredRun[]>;
  /** 状态变化的事件流，直到 `signal` 中止或 `close`。 */
  events?(options?: { readonly signal?: AbortSignal }): AsyncIterable<OrchestratorEvent>;
  /** 不再收新运行，等运行中的结束。 */
  close(): Promise<void>;
}
