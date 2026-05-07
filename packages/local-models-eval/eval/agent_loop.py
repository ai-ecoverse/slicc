"""Agent driver: POST /v1/chat/completions, parse `tool_calls`, run
each one through the scenario's tool registry, append the results,
loop until `finish_reason=stop` (or the round budget is exhausted).

Mirrors the cone agent's loop in `packages/webapp/src/scoops/`, just
without the orchestrator overhead. The transcript it produces is what
the verifier inspects to decide pass/fail.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .tools import ToolSpec, execute


@dataclass
class RoundLog:
    """One server round-trip, kept for the verifier and for debug output."""
    index: int
    finish_reason: str | None
    elapsed_s: float
    prompt_tokens: int | None
    completion_tokens: int | None
    tool_calls: list[dict] = field(default_factory=list)  # the calls the model emitted
    tool_results: list[str] = field(default_factory=list)  # what we returned
    content: str = ""  # assistant text after the </think> trim
    raw_content: str = ""  # full content including thinking trace


@dataclass
class LoopResult:
    """End-of-loop summary the verifier and the CLI consume."""
    finished: bool                # finish_reason=stop reached cleanly
    rounds: list[RoundLog]
    final_message: str            # last assistant content (post-trim)
    total_elapsed_s: float
    error: str | None = None      # set on HTTP / transport failures


def _strip_think_prefix(content: str) -> str:
    """Qwen 3.x emits a bare `</think>` mid-content to delimit reasoning
    from the user-visible answer (with no `<think>` opener). The real
    SLICC client-side `ThinkSplitter` does the same routing — for
    verification we just want what comes *after* `</think>`."""
    if "</think>" in content:
        return content.split("</think>", 1)[1].strip()
    return content.strip()


def _post(endpoint: str, body: dict, timeout: int) -> dict:
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def run(
    *,
    endpoint: str,
    model: str,
    system: str,
    user: str,
    tools: list[ToolSpec],
    max_rounds: int = 8,
    request_timeout: int = 180,
    on_round: Any = None,  # optional callback(RoundLog) for live logging
) -> LoopResult:
    """Drive the agent loop until termination. Pure transport — does
    not interpret the result; that's the verifier's job."""

    messages: list[dict] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    rounds: list[RoundLog] = []
    tool_schemas = [t.schema() for t in tools]
    started = time.monotonic()

    for n in range(1, max_rounds + 1):
        round_started = time.monotonic()
        body = {
            "model": model,
            "messages": messages,
            "tools": tool_schemas,
            "tool_choice": "auto",
            "max_tokens": 4096,
            "stream": False,
        }
        try:
            resp = _post(endpoint, body, timeout=request_timeout)
        except urllib.error.HTTPError as e:
            return LoopResult(
                finished=False,
                rounds=rounds,
                final_message="",
                total_elapsed_s=time.monotonic() - started,
                error=f"HTTP {e.code}: {e.read().decode(errors='replace')[:500]}",
            )
        except (urllib.error.URLError, OSError) as e:
            return LoopResult(
                finished=False,
                rounds=rounds,
                final_message="",
                total_elapsed_s=time.monotonic() - started,
                error=f"transport error: {e}",
            )

        choice = resp["choices"][0]
        message = choice.get("message") or {}
        finish = choice.get("finish_reason")
        usage = resp.get("usage") or {}
        tcs = message.get("tool_calls") or []
        raw_content = message.get("content") or ""
        content = _strip_think_prefix(raw_content)

        log = RoundLog(
            index=n,
            finish_reason=finish,
            elapsed_s=round(time.monotonic() - round_started, 3),
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            tool_calls=tcs,
            content=content,
            raw_content=raw_content,
        )

        # Append the assistant message verbatim — preserving raw_content
        # so the model sees its own thinking trace on the next round.
        assistant_msg: dict = {"role": "assistant", "content": raw_content}
        if tcs:
            assistant_msg["tool_calls"] = tcs
        messages.append(assistant_msg)

        # Execute every tool call in order, append the results.
        for tc in tcs:
            fn = tc.get("function") or {}
            name = fn.get("name", "")
            raw_args = fn.get("arguments", "")
            result = execute(tools, name, raw_args)
            log.tool_results.append(result)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": result,
            })

        rounds.append(log)
        if on_round is not None:
            on_round(log)

        if not tcs:
            return LoopResult(
                finished=finish == "stop",
                rounds=rounds,
                final_message=content,
                total_elapsed_s=round(time.monotonic() - started, 3),
            )

    return LoopResult(
        finished=False,
        rounds=rounds,
        final_message="",
        total_elapsed_s=round(time.monotonic() - started, 3),
        error=f"hit max_rounds={max_rounds} without finishing",
    )


__all__ = ["LoopResult", "RoundLog", "run"]
