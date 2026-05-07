"""SLICC-shaped tool stubs for the eval.

Mirrors the surface the cone agent sees in the real webapp
(`packages/webapp/src/tools/`): `read_file`, `write_file`, `bash`,
plus a couple of pure helpers (`calculator`, `is_prime`) that let
small math scenarios exercise multi-turn behavior without touching
the filesystem.

All file/bash tools are sandboxed to a per-scenario temp directory.
The sandbox is enforced in `Sandbox._resolve`, which rejects any path
that escapes the root after `Path.resolve()`. There is intentionally
no `chdir` tool, no symlink-following helper, and no "execute outside
the sandbox" escape — keep it that way; if a future scenario needs
broader access it should set up the sandbox to contain what it needs.
"""

from __future__ import annotations

import json
import math
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Tool schema (OpenAI-compatible)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolSpec:
    """An OpenAI-compatible tool description plus its Python handler.

    The `schema` is what we send to the model; `handler` is what we
    invoke when the model emits a `tool_call` for `name`. Handlers
    take the parsed `arguments` dict and return a string — the
    OpenAI tool-result content is always a string.
    """
    name: str
    description: str
    parameters: dict
    handler: Callable[[dict], str]

    def schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


# ---------------------------------------------------------------------------
# Sandbox + filesystem tools
# ---------------------------------------------------------------------------

class Sandbox:
    """A scenario-scoped filesystem root that backs `read_file`,
    `write_file`, and `bash`.

    Created with `tempfile.mkdtemp()` by the scenario runner; all
    paths the model sends are resolved relative to this root and
    rejected if they escape after canonicalization.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise ValueError(f"sandbox root does not exist: {self.root}")

    # Path resolution -------------------------------------------------------

    def _resolve(self, path: str) -> Path:
        # Treat an absolute path the model sends as relative to the
        # sandbox — we'd otherwise reject every absolute path the
        # model is statistically likely to emit.
        rel = Path(path)
        if rel.is_absolute():
            rel = Path(*rel.parts[1:]) if len(rel.parts) > 1 else Path()
        candidate = (self.root / rel).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as e:
            raise ValueError(
                f"path {path!r} escapes the sandbox at {self.root}"
            ) from e
        return candidate

    # Tool implementations --------------------------------------------------

    def read_file(self, args: dict) -> str:
        target = self._resolve(args["path"])
        if not target.exists():
            return f"error: file not found: {args['path']}"
        if target.is_dir():
            return f"error: {args['path']} is a directory; use bash with `ls`"
        return target.read_text(errors="replace")

    def write_file(self, args: dict) -> str:
        target = self._resolve(args["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        content = args["content"]
        target.write_text(content)
        # Loud, unambiguous success. Earlier wording ("wrote N bytes
        # to <path>") proved easy to misread as "maybe it didn't work,
        # try again" — Qwen 3.6 35B looped this 5+ times in the
        # write_then_run scenario before any tightening.
        return (
            f"OK: file '{args['path']}' was successfully written "
            f"({len(content)} bytes). The file now exists in the workspace "
            f"and is ready to read or execute."
        )

    def bash(self, args: dict) -> str:
        # Shell=True so the model can use pipes and redirects, just
        # like SLICC's `bash` tool. The sandbox cwd + 10 s timeout +
        # captured stdio limit blast radius if the model gets creative.
        cmd = args["command"]
        try:
            result = subprocess.run(
                cmd,
                shell=True,
                cwd=str(self.root),
                capture_output=True,
                text=True,
                timeout=10,
            )
        except subprocess.TimeoutExpired:
            return "error: command timed out after 10s"
        out = (
            f"exit={result.returncode}\n"
            f"--- stdout ---\n{result.stdout}"
            f"--- stderr ---\n{result.stderr}"
        )
        # Cap at 8 KB so a runaway `cat /dev/urandom` can't blow the
        # context window in a single tool result.
        return out[:8192]

    # Tool specs ------------------------------------------------------------

    def specs(self, names: list[str]) -> list[ToolSpec]:
        """Return ToolSpecs for each requested tool name. Lets a
        scenario opt into a tight subset of the available tools, which
        keeps the model from confusing itself with unused options."""
        registry = {
            "read_file": ToolSpec(
                name="read_file",
                description="Read a UTF-8 text file from the sandbox. Returns the file contents.",
                parameters={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
                handler=self.read_file,
            ),
            "write_file": ToolSpec(
                name="write_file",
                description="Write a UTF-8 text file inside the sandbox, creating parent dirs as needed. Overwrites if the file exists.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                },
                handler=self.write_file,
            ),
            "bash": ToolSpec(
                name="bash",
                description=(
                    "Run a bash command from the sandbox root. cwd is the "
                    "sandbox; absolute paths reaching outside are rejected. "
                    "Output is `exit=N\\n--- stdout ---\\n...\\n--- stderr "
                    "---\\n...` and is capped at 8 KB."
                ),
                parameters={
                    "type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"],
                },
                handler=self.bash,
            ),
        }
        return [registry[n] for n in names]


# ---------------------------------------------------------------------------
# Pure helpers (no sandbox dependency)
# ---------------------------------------------------------------------------

def _calculator(args: dict) -> str:
    expr = args["expression"]
    # Restricted eval — only arithmetic literals and operators. The
    # eval scenarios all send plain math; if a future scenario needs
    # function calls (`pow`, `sqrt`) extend the namespace explicitly.
    allowed = {"__builtins__": {}}
    try:
        return str(eval(expr, allowed, {}))  # noqa: S307 — restricted env
    except Exception as e:  # noqa: BLE001 — surface any error to the model
        return f"error: {type(e).__name__}: {e}"


def _is_prime(args: dict) -> str:
    n = args["n"]
    # Qwen 3.x sometimes emits an int as `"720"` even when the schema
    # says `integer`. Coerce — it's a known quirk and SLICC's real tool
    # handlers should be lenient too.
    try:
        n = int(n)
    except (TypeError, ValueError):
        return f"error: n must be an integer; got {n!r}"
    if n < 2:
        return "false"
    for i in range(2, int(math.isqrt(n)) + 1):
        if n % i == 0:
            return "false"
    return "true"


PURE_TOOLS: dict[str, ToolSpec] = {
    "calculator": ToolSpec(
        name="calculator",
        description="Evaluates a Python arithmetic expression like '12*5' or '60*12'. Returns the numeric result as a string.",
        parameters={
            "type": "object",
            "properties": {"expression": {"type": "string"}},
            "required": ["expression"],
        },
        handler=_calculator,
    ),
    "is_prime": ToolSpec(
        name="is_prime",
        description="Returns 'true' if the integer n is prime, 'false' otherwise.",
        parameters={
            "type": "object",
            "properties": {"n": {"type": "integer"}},
            "required": ["n"],
        },
        handler=_is_prime,
    ),
}


def execute(specs: list[ToolSpec], name: str, raw_arguments: str) -> str:
    """Look up `name` in `specs` and call its handler with the
    JSON-decoded arguments. Returns the result string the agent loop
    will append as the next `tool` message.
    """
    for spec in specs:
        if spec.name == name:
            try:
                args = json.loads(raw_arguments) if raw_arguments else {}
            except json.JSONDecodeError as e:
                return f"error: malformed arguments JSON: {e}"
            try:
                return spec.handler(args)
            except Exception as e:  # noqa: BLE001
                return f"error: {type(e).__name__}: {e}"
    return f"error: unknown tool {name!r}"


__all__ = [
    "PURE_TOOLS",
    "Sandbox",
    "ToolSpec",
    "execute",
]
