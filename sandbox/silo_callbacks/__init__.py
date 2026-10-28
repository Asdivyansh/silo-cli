"""
SILO Trace Callbacks

Auto-loaded by SILO when agent frameworks are active inside the container.
Provides callback adapters for supported frameworks that push trace events
to the SILO collector endpoint (`POST /_silo/traces`).

Supported frameworks:
  - CrewAI: via BaseEventListener (native event bus)
  - LangChain/LangGraph: via BaseCallbackHandler
  - Generic: silo_trace() function for any framework
"""
import json
import os
import urllib.request
import time
from typing import Any, Optional, Dict

# ---------------------------------------------------------------------------
# Trace transport
# ---------------------------------------------------------------------------

SILO_TRACE_URL = os.environ.get(
    "SILO_TRACE_URL",
    "http://host.docker.internal:8199/_silo/traces",
)

FRAMEWORK = "custom"


def _send_trace(event: str, framework: str = "custom", **kwargs: Any) -> None:
    """Send a trace event to the SILO collector (fire-and-forget)."""
    payload = {"framework": framework, "event": event}
    payload.update({k: v for k, v in kwargs.items() if v is not None})

    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            SILO_TRACE_URL,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass  # Non-fatal — never break the framework


# ---------------------------------------------------------------------------
# CrewAI: BaseEventListener adapter
# ---------------------------------------------------------------------------

class SiloCrewCallbacks:
    """
    CrewAI event listener that pushes traces to SILO.

    CrewAI uses its own event bus system (not LangChain callbacks).
    This class hooks into CrewAI's BaseEventListener to capture:
      - Agent start/end events
      - Task start/end events
      - Tool call hooks (before/after)

    Usage:
        from silo_callbacks import SiloCrewCallbacks

        # Option 1: As an event listener
        listener = SiloCrewCallbacks()
        listener.setup()  # registers with CrewAI event bus

        # Option 2: As tool hooks
        from crewai import Task
        task = Task(
            ...,
            callback=listener.task_callback,
        )
    """

    def setup(self) -> None:
        """Register with CrewAI's event bus if available."""
        try:
            from crewai.utilities.events import (  # type: ignore
                subscribe,
                AgentExecutionStartedEvent,
                AgentExecutionCompletedEvent,
                TaskStartedEvent,
                TaskCompletedEvent,
                ToolUsageStartedEvent,
                ToolUsageFinishedEvent,
            )

            subscribe(AgentExecutionStartedEvent, self._on_agent_start)
            subscribe(AgentExecutionCompletedEvent, self._on_agent_end)
            subscribe(TaskStartedEvent, self._on_task_start)
            subscribe(TaskCompletedEvent, self._on_task_end)
            subscribe(ToolUsageStartedEvent, self._on_tool_start)
            subscribe(ToolUsageFinishedEvent, self._on_tool_end)
        except ImportError:
            # Older CrewAI or event bus not available — fall back silently
            pass

    def _on_agent_start(self, event: Any) -> None:
        agent_name = getattr(event, "agent_name", None) or getattr(
            getattr(event, "agent", None), "role", "unknown"
        )
        _send_trace(
            "agent_start",
            framework="crewai",
            agent=str(agent_name),
            meta={"goal": getattr(getattr(event, "agent", None), "goal", None)},
        )

    def _on_agent_end(self, event: Any) -> None:
        agent_name = getattr(event, "agent_name", None) or getattr(
            getattr(event, "agent", None), "role", "unknown"
        )
        _send_trace(
            "agent_end",
            framework="crewai",
            agent=str(agent_name),
            result=str(getattr(event, "output", ""))[:2000],
        )

    def _on_task_start(self, event: Any) -> None:
        _send_trace(
            "task_start",
            framework="crewai",
            meta={
                "description": str(getattr(event, "description", ""))[:500],
            },
        )

    def _on_task_end(self, event: Any) -> None:
        _send_trace(
            "task_end",
            framework="crewai",
            result=str(getattr(event, "output", ""))[:2000],
        )

    def _on_tool_start(self, event: Any) -> None:
        _send_trace(
            "tool_call",
            framework="crewai",
            tool=getattr(event, "tool_name", "unknown"),
            args={"input": str(getattr(event, "tool_input", ""))[:2000]},
        )

    def _on_tool_end(self, event: Any) -> None:
        _send_trace(
            "tool_call",
            framework="crewai",
            tool=getattr(event, "tool_name", "unknown"),
            result=str(getattr(event, "output", ""))[:2000],
            meta={"phase": "result"},
        )

    def task_callback(self, output: Any) -> None:
        """Use as Task(callback=listener.task_callback)."""
        _send_trace(
            "task_end",
            framework="crewai",
            result=str(output)[:2000],
        )

    @staticmethod
    def before_tool_hook(context: Any) -> bool:
        """Use as crew-level before_tool_call hook."""
        tool_name = getattr(context, "tool_name", "unknown")
        _send_trace(
            "tool_call",
            framework="crewai",
            tool=tool_name,
            args={"input": str(getattr(context, "arguments", ""))[:2000]},
        )
        return True  # Allow execution

    @staticmethod
    def after_tool_hook(context: Any) -> None:
        """Use as crew-level after_tool_call hook."""
        tool_name = getattr(context, "tool_name", "unknown")
        _send_trace(
            "tool_call",
            framework="crewai",
            tool=tool_name,
            result=str(getattr(context, "output", ""))[:2000],
            meta={"phase": "result"},
        )


# ---------------------------------------------------------------------------
# LangChain / LangGraph: BaseCallbackHandler adapter
# ---------------------------------------------------------------------------

class SiloLangChainCallbacks:
    """
    LangChain BaseCallbackHandler-compatible class that pushes traces to SILO.
    Works with LangGraph since it uses LangChain's callback system.

    Usage:
        from silo_callbacks import SiloLangChainCallbacks
        graph.invoke(input, config={"callbacks": [SiloLangChainCallbacks()]})
    """

    def __init__(self) -> None:
        self._timers: Dict[str, float] = {}

    # -- Chain (node) events ------------------------------------------------

    def on_chain_start(
        self,
        serialized: Any = None,
        inputs: Any = None,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        rid = str(run_id) if run_id else ""
        self._timers[rid] = time.time()
        name = ""
        if serialized and isinstance(serialized, dict):
            name = serialized.get("name", "")
            if not name:
                id_list = serialized.get("id", [])
                name = id_list[-1] if id_list else "unknown"
        _send_trace(
            "node_enter",
            framework="langgraph",
            agent=str(name),
            meta={"run_id": rid},
        )

    def on_chain_end(
        self,
        outputs: Any = None,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        rid = str(run_id) if run_id else ""
        elapsed = time.time() - self._timers.pop(rid, time.time())
        _send_trace(
            "node_exit",
            framework="langgraph",
            result=str(outputs)[:2000] if outputs else None,
            durationMs=int(elapsed * 1000),
            meta={"run_id": rid},
        )

    # -- Tool events --------------------------------------------------------

    def on_tool_start(
        self,
        serialized: Any = None,
        input_str: str = "",
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        tool_name = ""
        if serialized and isinstance(serialized, dict):
            tool_name = serialized.get("name", "unknown")
        _send_trace(
            "tool_call",
            framework="langgraph",
            tool=tool_name,
            args={"input": input_str[:2000]} if input_str else None,
        )

    def on_tool_end(
        self,
        output: str = "",
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        _send_trace(
            "tool_call",
            framework="langgraph",
            result=output[:2000] if output else None,
            meta={"phase": "result"},
        )

    def on_tool_error(
        self,
        error: Any = None,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        _send_trace(
            "error",
            framework="langgraph",
            result=str(error)[:2000] if error else None,
            meta={"type": "tool_error"},
        )

    # -- LLM events (lightweight) ------------------------------------------

    def on_llm_start(
        self,
        serialized: Any = None,
        prompts: Any = None,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        rid = str(run_id) if run_id else ""
        self._timers[rid] = time.time()

    def on_llm_end(
        self,
        response: Any = None,
        *,
        run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        rid = str(run_id) if run_id else ""
        elapsed = time.time() - self._timers.pop(rid, time.time())
        _send_trace(
            "step",
            framework="langgraph",
            meta={"type": "llm_call", "durationMs": int(elapsed * 1000)},
        )


# ---------------------------------------------------------------------------
# Generic trace helper
# ---------------------------------------------------------------------------

def silo_trace(
    event: str,
    framework: str = "custom",
    tool: Optional[str] = None,
    agent: Optional[str] = None,
    args: Optional[dict] = None,
    result: Optional[str] = None,
    parent: Optional[str] = None,
    meta: Optional[dict] = None,
    durationMs: Optional[int] = None,
) -> None:
    """
    Send a custom trace event to SILO from any Python code.

    Usage:
        from silo_callbacks import silo_trace
        silo_trace("tool_call", framework="my_agent", tool="search", args={"q": "test"})
    """
    _send_trace(
        event,
        framework=framework,
        tool=tool,
        agent=agent,
        args=args,
        result=result,
        parent=parent,
        meta=meta,
        durationMs=durationMs,
    )
