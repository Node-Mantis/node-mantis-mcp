"""Background tasks with bounded waits, cancellation, and result retention.

All task state belongs to this process and is lost when the server stops.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

FINISHED_TASK_TTL_SECONDS = 60 * 60
MAX_FINISHED_TASKS = 200
HEARTBEAT_SECONDS = 15.0


@dataclass
class TaskSpec:
    kind: str  # "run_task" | "retrieve_data"
    api_key: str
    service_tier: str
    headless: bool
    use_proxy: bool = False
    effort: Optional[str] = None
    # run_task
    goal: Optional[str] = None
    start_url: Optional[str] = None
    result_schema: Any = None
    max_cost_usd: Optional[float] = None
    max_steps: Optional[int] = None
    timeout_ms: Optional[int] = None
    secrets: Optional[Dict[str, str]] = None
    # retrieve_data
    url: Optional[str] = None
    prompt: Optional[str] = None


# Starts a NodeMantis session; tests substitute a fake.
SessionFactory = Callable[..., Awaitable[Any]]


class TaskLimitError(Exception):
    pass


@dataclass
class _Task:
    id: str
    spec: TaskSpec
    started_at: float
    status: str = "running"  # running | succeeded | failed | cancelled
    finished_at: Optional[float] = None
    progress: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, Any]] = None
    aborted: bool = False
    session: Any = None
    # Set when the task has a final status.
    settled: asyncio.Event = field(default_factory=asyncio.Event)
    # Done when its browser session is closed as well.
    runner: Optional["asyncio.Task[None]"] = None
    listeners: List[Callable[[str], None]] = field(default_factory=list)


def _compact(value: Dict[str, Any]) -> Dict[str, Any]:
    return {key: entry for key, entry in value.items() if entry is not None}


def _describe_error(error: BaseException) -> Dict[str, Any]:
    code = getattr(error, "code", None)
    cost_usd = getattr(error, "cost_usd", None)
    return _compact({
        "message": str(error) or type(error).__name__,
        "code": code if isinstance(code, str) else None,
        "cost_usd": cost_usd if isinstance(cost_usd, (int, float)) and not isinstance(cost_usd, bool) else None,
    })


def _progress_message(event: Any) -> str:
    step = f"Step {event.iteration}/{event.max_iterations}" if event.max_iterations else f"Step {event.iteration}"
    detail = " — ".join(part for part in (event.message, event.action) if part)
    return f"{step}: {detail}" if detail else step


async def _close_quietly(session: Any) -> None:
    try:
        await session.close()
    except Exception:  # noqa: BLE001 - close is best effort
        pass


class TaskManager:
    def __init__(
        self,
        *,
        start_session: SessionFactory,
        max_running: int,
        now: Callable[[], float] = time.monotonic,
        heartbeat_seconds: float = HEARTBEAT_SECONDS,
    ) -> None:
        self._start_session = start_session
        self._max_running = max_running
        self._now = now
        self._heartbeat_seconds = heartbeat_seconds
        self._tasks: Dict[str, _Task] = {}

    def start(self, spec: TaskSpec) -> Dict[str, Any]:
        """Start a task in the background. Raises TaskLimitError when too many are running."""
        self._prune()
        running = [task for task in self._tasks.values() if task.status == "running"]
        if len(running) >= self._max_running:
            raise TaskLimitError(
                f"{len(running)} tasks are already running (limit {self._max_running}). "
                "Wait for one to finish with get_task or stop one with cancel_task. "
                f"Running task ids: {', '.join(task.id for task in running)}"
            )
        task = _Task(id=f"task_{uuid.uuid4()}", spec=spec, started_at=self._now())
        self._tasks[task.id] = task
        task.runner = asyncio.ensure_future(self._execute(task))
        return self._snapshot_of(task)

    def snapshot(self, task_id: str) -> Optional[Dict[str, Any]]:
        task = self._tasks.get(task_id)
        return self._snapshot_of(task) if task else None

    async def wait(
        self,
        task_id: str,
        timeout_seconds: float,
        cancelled: asyncio.Event,
        on_progress: Callable[[str], None],
    ) -> Optional[Dict[str, Any]]:
        """Wait until the task finishes, the timeout passes, or the caller is
        cancelled, whichever is first, relaying progress meanwhile."""
        task = self._tasks.get(task_id)
        if task is None:
            return None
        if task.status != "running" or timeout_seconds <= 0 or cancelled.is_set():
            return self._snapshot_of(task)

        async def heartbeat() -> None:
            # Some clients extend their own timeout while progress keeps arriving.
            while True:
                await asyncio.sleep(self._heartbeat_seconds)
                on_progress(f"Still working ({round(self._now() - task.started_at)}s)")

        task.listeners.append(on_progress)
        waiters = [
            asyncio.ensure_future(task.settled.wait()),
            asyncio.ensure_future(cancelled.wait()),
            asyncio.ensure_future(heartbeat()),
        ]
        try:
            await asyncio.wait(waiters, timeout=timeout_seconds, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for waiter in waiters:
                waiter.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)
            if on_progress in task.listeners:
                task.listeners.remove(on_progress)
        return self._snapshot_of(task)

    def cancel(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Stop a running task and close its browser. Finished tasks are left as they are."""
        task = self._tasks.get(task_id)
        if task is None:
            return None
        if task.status == "running":
            task.status = "cancelled"
            task.finished_at = self._now()
            task.aborted = True
            task.settled.set()
            # Closing the session is what interrupts an operation in flight. A
            # session still starting is closed as soon as it exists.
            if task.session is not None:
                asyncio.ensure_future(_close_quietly(task.session))
        return self._snapshot_of(task)

    async def close_all(self) -> None:
        """Cancel everything and wait until every browser session is closed."""
        tasks = list(self._tasks.values())
        for task in tasks:
            self.cancel(task.id)
        runners = [task.runner for task in tasks if task.runner is not None]
        if runners:
            await asyncio.gather(*runners, return_exceptions=True)

    def _note(self, task: _Task, progress: Dict[str, Any], message: str) -> None:
        if task.status != "running":
            return
        task.progress = progress
        for listener in list(task.listeners):
            try:
                listener(message)
            except Exception:  # noqa: BLE001 - a listener fault never affects the task
                pass

    async def _execute(self, task: _Task) -> None:
        spec = task.spec
        session: Any = None
        try:
            self._note(task, {"message": "Preparing the browser"}, "Preparing the browser")
            session = await self._start_session(
                api_key=spec.api_key,
                start_url=spec.start_url if spec.kind == "run_task" else spec.url,
                headless=spec.headless,
                use_proxy=True if spec.use_proxy else None,
            )
            task.session = session
            if task.aborted:
                return

            if spec.kind == "run_task":
                self._note(task, {"message": "Working on the task"}, "Working on the task")

                def on_progress(event: Any) -> None:
                    message = _progress_message(event)
                    self._note(task, _compact({
                        "step": event.iteration, "max_steps": event.max_iterations, "message": message,
                    }), message)

                result = await session.run(
                    spec.goal,
                    effort=spec.effort,
                    service_tier=spec.service_tier,
                    max_iterations=spec.max_steps,
                    timeout=spec.timeout_ms,
                    max_cost=spec.max_cost_usd,
                    result_schema=spec.result_schema,
                    secrets=spec.secrets,
                    on_progress=on_progress,
                )
                if task.status != "running":
                    return
                task.result = _compact({
                    "ok": result.ok,
                    "reason": result.reason,
                    "value": result.value,
                    "retrieval": _retrieval_summary(result),
                    "steps": result.iterations,
                    "cost_usd": result.cost_usd,
                    "trace_id": result.trace_id,
                })
                task.status = "succeeded" if result.ok else "failed"
            else:
                self._note(task, {"message": "Reading the page"}, "Reading the page")
                result = await session.retrieve(
                    spec.prompt,
                    schema=spec.result_schema,
                    effort=spec.effort,
                    service_tier=spec.service_tier,
                )
                if task.status != "running":
                    return
                task.result = _compact({
                    "status": result.status,
                    "message": result.message,
                    "data": result.data,
                    "retryable": result.retryable if result.status == "unavailable" else None,
                    "final_url": result.final_url,
                    "cost_usd": result.cost_usd,
                    "trace_id": result.trace_id,
                })
                task.status = "succeeded" if result.status == "success" else "failed"
        except Exception as error:  # noqa: BLE001 - reported as the task's outcome
            if task.status == "running":
                task.status = "failed"
                task.error = _describe_error(error)
        finally:
            if task.finished_at is None:
                task.finished_at = self._now()
            task.settled.set()
            task.session = None
            if session is not None:
                await _close_quietly(session)

    def _snapshot_of(self, task: _Task) -> Dict[str, Any]:
        end = task.finished_at if task.finished_at is not None else self._now()
        return _compact({
            "task_id": task.id,
            "tool": task.spec.kind,
            "status": task.status,
            "elapsed_seconds": max(0, round(end - task.started_at)),
            "progress": task.progress if task.status == "running" else None,
            "result": task.result,
            "error": task.error,
        })

    def _prune(self) -> None:
        """Forget finished tasks after an hour, and beyond a fixed count."""
        now = self._now()
        finished = sorted(
            (task for task in self._tasks.values() if task.status != "running"),
            key=lambda task: task.finished_at or 0,
        )
        excess = max(0, len(finished) - MAX_FINISHED_TASKS)
        for index, task in enumerate(finished):
            if index < excess or now - (task.finished_at if task.finished_at is not None else now) > FINISHED_TASK_TTL_SECONDS:
                del self._tasks[task.id]


def _retrieval_summary(result: Any) -> Optional[Dict[str, Any]]:
    retrieval = getattr(result, "retrieval", None)
    if retrieval is None:
        return None
    return _compact({
        "status": retrieval.status,
        "message": retrieval.message,
        "retryable": retrieval.retryable,
    })
