import { randomUUID } from "node:crypto";

import type {
  AgentOperationResult,
  AgentProgressEvent,
  AgentRetrieveResult,
  Effort,
  JsonValue,
  NodeMantisRetrieveOptions,
  NodeMantisRunOptions,
  NodeMantisStartOptions,
  ServiceTier,
} from "node-mantis";

/**
 * Background tasks for the MCP server. Each task runs in its own session,
 * while tool calls wait for a bounded time before returning a task id. The task list lives in this process: it is lost when
 * the server stops.
 */

/** The slice of a NodeMantis session a task needs (tests substitute a fake). */
export interface TaskSession {
  run(goal: string, options?: NodeMantisRunOptions): Promise<AgentOperationResult>;
  retrieve(prompt: string, options?: NodeMantisRetrieveOptions): Promise<AgentRetrieveResult>;
  close(): Promise<void>;
}

export type TaskSessionFactory = (options: NodeMantisStartOptions) => Promise<TaskSession>;

interface TaskSpecBase {
  apiKey: string;
  serviceTier: ServiceTier;
  effort?: Effort;
  useProxy: boolean;
  headless: boolean;
}

export interface RunTaskSpec extends TaskSpecBase {
  kind: "run_task";
  goal: string;
  startUrl?: string;
  resultSchema?: JsonValue;
  maxCostUsd?: number;
  maxSteps?: number;
  timeoutMs?: number;
  secrets?: Record<string, string>;
}

export interface RetrieveTaskSpec extends TaskSpecBase {
  kind: "retrieve_data";
  url: string;
  prompt: string;
  schema?: JsonValue;
}

export type TaskSpec = RunTaskSpec | RetrieveTaskSpec;

export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled";

/** What a tool call returns about a task. Snake case: this is model-facing JSON. */
export interface TaskSnapshot {
  task_id: string;
  tool: TaskSpec["kind"];
  status: TaskStatus;
  elapsed_seconds: number;
  progress?: { step?: number; max_steps?: number; message: string };
  result?: Record<string, unknown>;
  error?: { message: string; code?: string; cost_usd?: number };
}

interface Task {
  id: string;
  spec: TaskSpec;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  progress?: TaskSnapshot["progress"];
  result?: Record<string, unknown>;
  error?: TaskSnapshot["error"];
  abort: AbortController;
  session?: TaskSession;
  /** Resolves when the task has a final status. */
  settled: Promise<void>;
  /** Resolves when its browser session is closed as well. */
  closed: Promise<void>;
  listeners: Set<(message: string) => void>;
}

export class TaskLimitError extends Error {}

const FINISHED_TASK_TTL_MS = 60 * 60_000;
const MAX_FINISHED_TASKS = 200;
const HEARTBEAT_MS = 15_000;

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function describeError(error: unknown): NonNullable<TaskSnapshot["error"]> {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const costUsd = (error as { costUsd?: unknown } | null)?.costUsd;
  return compact({
    message,
    code: typeof code === "string" ? code : undefined,
    cost_usd: typeof costUsd === "number" ? costUsd : undefined,
  });
}

function progressMessage(event: AgentProgressEvent): string {
  const step = event.maxIterations ? `Step ${event.iteration}/${event.maxIterations}` : `Step ${event.iteration}`;
  const detail = [event.message, event.action].filter(Boolean).join(" — ");
  return detail ? `${step}: ${detail}` : step;
}

export class TaskManager {
  private readonly tasks = new Map<string, Task>();

  constructor(private readonly options: {
    startSession: TaskSessionFactory;
    maxRunning: number;
    now?: () => number;
  }) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Start a task in the background. Throws TaskLimitError when too many are running. */
  start(spec: TaskSpec): TaskSnapshot {
    this.prune();
    const running = [...this.tasks.values()].filter(task => task.status === "running");
    if (running.length >= this.options.maxRunning) {
      throw new TaskLimitError(
        `${running.length} tasks are already running (limit ${this.options.maxRunning}). `
        + `Wait for one to finish with get_task or stop one with cancel_task. Running task ids: ${running.map(task => task.id).join(", ")}`,
      );
    }
    let markSettled!: () => void;
    let markClosed!: () => void;
    const task: Task = {
      id: `task_${randomUUID()}`,
      spec,
      status: "running",
      startedAt: this.now(),
      abort: new AbortController(),
      settled: new Promise<void>(resolve => { markSettled = resolve; }),
      closed: new Promise<void>(resolve => { markClosed = resolve; }),
      listeners: new Set(),
    };
    this.tasks.set(task.id, task);
    void this.execute(task, markSettled).finally(markClosed);
    return this.snapshotOf(task);
  }

  snapshot(id: string): TaskSnapshot | undefined {
    const task = this.tasks.get(id);
    return task ? this.snapshotOf(task) : undefined;
  }

  /**
   * Wait until the task finishes, `timeoutMs` passes, or `signal` aborts,
   * whichever is first, relaying progress meanwhile.
   */
  async wait(
    id: string,
    timeoutMs: number,
    signal: AbortSignal,
    onProgress: (message: string) => void,
  ): Promise<TaskSnapshot | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (task.status !== "running" || timeoutMs <= 0 || signal.aborted) return this.snapshotOf(task);

    task.listeners.add(onProgress);
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        // Some clients extend their own timeout while progress keeps arriving.
        heartbeat = setInterval(() => {
          onProgress(`Still working (${Math.round((this.now() - task.startedAt) / 1000)}s)`);
        }, HEARTBEAT_MS);
        onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        void task.settled.then(resolve);
      });
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      task.listeners.delete(onProgress);
    }
    return this.snapshotOf(task);
  }

  /** Stop a running task and close its browser. Finished tasks are left as they are. */
  cancel(id: string): TaskSnapshot | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (task.status === "running") {
      task.status = "cancelled";
      task.finishedAt = this.now();
      task.abort.abort();
      // Closing the session is what interrupts an operation in flight.
      void task.session?.close().catch(() => undefined);
    }
    return this.snapshotOf(task);
  }

  /** Cancel everything and wait until every browser session is closed. */
  async closeAll(): Promise<void> {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) this.cancel(task.id);
    await Promise.allSettled(tasks.map(task => task.closed));
  }

  private note(task: Task, progress: NonNullable<TaskSnapshot["progress"]>, message: string): void {
    if (task.status !== "running") return;
    task.progress = progress;
    for (const listener of task.listeners) {
      try {
        listener(message);
      } catch {
        // A listener fault never affects the task.
      }
    }
  }

  private async execute(task: Task, markSettled: () => void): Promise<void> {
    const { spec } = task;
    let session: TaskSession | undefined;
    try {
      this.note(task, { message: "Preparing the browser" }, "Preparing the browser");
      session = await this.options.startSession({
        startUrl: spec.kind === "run_task" ? spec.startUrl : spec.url,
        headless: spec.headless,
        useProxy: spec.useProxy ? true : undefined,
        apiKey: spec.apiKey,
        signal: task.abort.signal,
      });
      task.session = session;
      if (task.abort.signal.aborted) return;

      if (spec.kind === "run_task") {
        this.note(task, { message: "Working on the task" }, "Working on the task");
        const result = await session.run(spec.goal, {
          effort: spec.effort,
          serviceTier: spec.serviceTier,
          maxIterations: spec.maxSteps,
          timeout: spec.timeoutMs,
          maxCost: spec.maxCostUsd,
          resultSchema: spec.resultSchema,
          secrets: spec.secrets,
          onProgress: event => this.note(
            task,
            compact({ step: event.iteration, max_steps: event.maxIterations, message: progressMessage(event) }),
            progressMessage(event),
          ),
        });
        if (task.status !== "running") return;
        task.result = compact({
          ok: result.ok,
          reason: result.reason,
          value: result.value,
          retrieval: result.retrieval,
          steps: result.iterations,
          cost_usd: result.costUsd,
          trace_id: result.traceId,
        });
        task.status = result.ok ? "succeeded" : "failed";
      } else {
        this.note(task, { message: "Reading the page" }, "Reading the page");
        const result = await session.retrieve(spec.prompt, {
          schema: spec.schema,
          effort: spec.effort,
          serviceTier: spec.serviceTier,
        });
        if (task.status !== "running") return;
        task.result = compact({
          status: result.status,
          message: result.message,
          data: result.data,
          retryable: result.status === "unavailable" ? result.retryable : undefined,
          final_url: result.finalUrl,
          cost_usd: result.costUsd,
          trace_id: result.traceId,
        });
        task.status = result.status === "success" ? "succeeded" : "failed";
      }
    } catch (error) {
      if (task.status === "running") {
        task.status = "failed";
        task.error = describeError(error);
      }
    } finally {
      task.finishedAt ??= this.now();
      markSettled();
      task.session = undefined;
      await session?.close().catch(() => undefined);
    }
  }

  private snapshotOf(task: Task): TaskSnapshot {
    const end = task.finishedAt ?? this.now();
    return compact({
      task_id: task.id,
      tool: task.spec.kind,
      status: task.status,
      elapsed_seconds: Math.max(0, Math.round((end - task.startedAt) / 1000)),
      progress: task.status === "running" ? task.progress : undefined,
      result: task.result,
      error: task.error,
    });
  }

  /** Forget finished tasks after an hour, and beyond a fixed count. */
  private prune(): void {
    const now = this.now();
    const finished = [...this.tasks.values()]
      .filter(task => task.status !== "running")
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
    const excess = Math.max(0, finished.length - MAX_FINISHED_TASKS);
    finished.forEach((task, index) => {
      if (index < excess || now - (task.finishedAt ?? now) > FINISHED_TASK_TTL_MS) this.tasks.delete(task.id);
    });
  }
}
