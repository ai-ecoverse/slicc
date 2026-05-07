"""Scenario definitions — the data driving the eval.

Each `Scenario` pairs a system + user prompt with a tool subset and a
verifier that decides pass/fail from the final assistant message and
the per-round transcript.

Conventions:

  * Verifiers inspect `result.final_message` (post-`</think>` trim) by
    default, because that's what the user actually sees in the SLICC
    chat panel. Reach into `result.rounds` only when the test *is*
    about call shape (e.g. "round 1 must contain at least two parallel
    tool_calls").
  * Setup callbacks receive a `Sandbox` and pre-populate it. Don't
    assume any default content.
  * Keep prompts deterministic — no "tell me a story" — so the
    verifier can match on a stable expected answer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .agent_loop import LoopResult
from .tools import PURE_TOOLS, Sandbox, ToolSpec


# ---------------------------------------------------------------------------
# Scenario shape
# ---------------------------------------------------------------------------

@dataclass
class VerifierResult:
    ok: bool
    reason: str

    @classmethod
    def passes(cls, reason: str = "ok") -> "VerifierResult":
        return cls(ok=True, reason=reason)

    @classmethod
    def fails(cls, reason: str) -> "VerifierResult":
        return cls(ok=False, reason=reason)


@dataclass
class Scenario:
    name: str
    description: str
    system: str
    user: str
    tool_names: list[str]                     # subset to expose to the model
    verify: Callable[[LoopResult], VerifierResult]
    setup: Callable[[Sandbox], None] | None = None
    max_rounds: int = 6
    # Pure scenarios skip the sandbox entirely (calculator-style); a
    # value of False here causes the runner to skip mkdtemp and pass
    # an empty tool set from the sandbox.
    needs_sandbox: bool = True
    # `False` marks a scenario as expected to fail with the current
    # model/SwiftLM combo — usually a known model weakness we don't
    # want to engineer around in the prompt. Pytest convention:
    #   expected=True,  actual=pass  →  PASS  (counts toward suite ok)
    #   expected=True,  actual=fail  →  FAIL  (suite exits 1)
    #   expected=False, actual=fail  →  XFAIL (known; suite stays ok)
    #   expected=False, actual=pass  →  XPASS (model improved!
    #                                          surface but don't fail)
    # When you mark a scenario xfail, leave a comment on the line
    # describing the failure mode so it can be re-evaluated later.
    expected_pass: bool = True

    def tools(self, sandbox: Sandbox | None) -> list[ToolSpec]:
        specs: list[ToolSpec] = []
        sandbox_tool_names = {"read_file", "write_file", "bash"}
        for name in self.tool_names:
            if name in sandbox_tool_names:
                if sandbox is None:
                    raise RuntimeError(
                        f"scenario {self.name!r} requested {name!r} but has needs_sandbox=False"
                    )
                spec = next(t for t in sandbox.specs([name]))
            elif name in PURE_TOOLS:
                spec = PURE_TOOLS[name]
            else:
                raise RuntimeError(f"unknown tool {name!r} in scenario {self.name!r}")
            specs.append(spec)
        return specs


# ---------------------------------------------------------------------------
# Scenario implementations
# ---------------------------------------------------------------------------

# ─── parallel_math ─────────────────────────────────────────────────────────

_MATH_SYSTEM = (
    "You are a precise math assistant. Use the calculator and is_prime "
    "tools to answer. When you have all the values needed, give a brief "
    "final answer with no more tool calls."
)

_MATH_USER = (
    "Compute 12 multiplied by 5 and 3 multiplied by 4 IN PARALLEL "
    "(both calls in one response). Then multiply the two results "
    "together. Then check whether the final number is prime. Tell me "
    "both the number and whether it's prime."
)


def _verify_parallel_math(result: LoopResult) -> VerifierResult:
    if result.error:
        return VerifierResult.fails(result.error)
    if not result.finished:
        return VerifierResult.fails("agent loop did not reach finish_reason=stop")
    msg = result.final_message.lower()
    if "720" not in msg:
        return VerifierResult.fails(f"final answer missing the number 720: {msg!r}")
    if not re.search(r"\bnot\s+prime\b|composite", msg):
        return VerifierResult.fails(f"final answer didn't say it's not prime: {msg!r}")
    # Also pin the call-shape: round 1 must have >=2 tool_calls (the
    # parallel ask). This is the part that distinguishes "real
    # parallel" from "the agent serialized them anyway."
    if len(result.rounds) < 1 or len(result.rounds[0].tool_calls) < 2:
        return VerifierResult.fails(
            f"round 1 must emit ≥2 tool_calls (parallel); got "
            f"{len(result.rounds[0].tool_calls) if result.rounds else 0}"
        )
    return VerifierResult.passes(
        f"720 not prime; round1 had {len(result.rounds[0].tool_calls)} parallel calls"
    )


# ─── file_exploration ──────────────────────────────────────────────────────

_FILE_SYSTEM = (
    "You are a helpful assistant with access to a small workspace. "
    "Use the bash tool to discover what files exist, and read_file to "
    "inspect their contents. After you have the information you need, "
    "give a brief final answer."
)

_FILE_USER = (
    "How many total lines are in all the .txt files in this directory "
    "combined? Look at every .txt file, count its lines, and tell me "
    "the total."
)

# Three files, line counts chosen to be small enough to read in full
# but large enough that the model has to actually count rather than
# guess. Total: 5 + 12 + 3 = 20.
_FILE_FIXTURES = {
    "alpha.txt": (
        "first line\n"
        "second line\n"
        "third line\n"
        "fourth line\n"
        "fifth line\n"
    ),
    "beta.txt": (
        "one\n"
        "two\n"
        "three\n"
        "four\n"
        "five\n"
        "six\n"
        "seven\n"
        "eight\n"
        "nine\n"
        "ten\n"
        "eleven\n"
        "twelve\n"
    ),
    "gamma.txt": (
        "alpha\n"
        "beta\n"
        "gamma\n"
    ),
    "decoy.md": (
        "# this file is markdown — should NOT be counted\n"
        "extra line\n"
    ),
}
_FILE_EXPECTED_TOTAL = 5 + 12 + 3


def _setup_file_exploration(sandbox: Sandbox) -> None:
    for name, content in _FILE_FIXTURES.items():
        (sandbox.root / name).write_text(content)


def _verify_file_exploration(result: LoopResult) -> VerifierResult:
    if result.error:
        return VerifierResult.fails(result.error)
    if not result.finished:
        return VerifierResult.fails("agent loop did not reach finish_reason=stop")
    msg = result.final_message
    # Look for the exact answer as a standalone token, not a substring
    # of a larger number (e.g. "20" must not match "120" or "200").
    if not re.search(rf"\b{_FILE_EXPECTED_TOTAL}\b", msg):
        return VerifierResult.fails(
            f"final answer missing total {_FILE_EXPECTED_TOTAL}: {msg!r}"
        )
    return VerifierResult.passes(f"reported total = {_FILE_EXPECTED_TOTAL}")


# ─── write_then_run ────────────────────────────────────────────────────────

_WRITE_SYSTEM = (
    "You are a helpful coding assistant. To answer the user, do EXACTLY "
    "this workflow:\n"
    "  1. Call write_file ONCE to create the script.\n"
    "  2. Call bash ONCE to execute the script.\n"
    "  3. Give a brief final answer that includes the script's actual "
    "stdout from step 2.\n"
    "Do not call write_file a second time unless the first call returned "
    "an error. Do not skip the bash step. Do not fabricate output — use "
    "what bash actually returned."
)

_WRITE_USER = (
    "Create a Python script called `greet.py` that prints exactly the "
    "phrase: HELLO_FROM_EVAL_4242 . Then run it with `python3 greet.py` "
    "and tell me what it printed."
)

# Sentinel chosen to be unmistakable in transcripts and unlikely to
# appear by chance in any pretraining data the model could hallucinate.
_WRITE_SENTINEL = "HELLO_FROM_EVAL_4242"


def _verify_write_then_run(result: LoopResult) -> VerifierResult:
    if result.error:
        return VerifierResult.fails(result.error)
    if not result.finished:
        return VerifierResult.fails("agent loop did not reach finish_reason=stop")
    if _WRITE_SENTINEL not in result.final_message:
        return VerifierResult.fails(
            f"final answer missing sentinel {_WRITE_SENTINEL!r}: "
            f"{result.final_message!r}"
        )
    # Pin that the model actually wrote *and* ran the file rather than
    # just writing the sentinel into its answer directly. Look for a
    # write_file call followed by a bash call somewhere in the rounds.
    saw_write = False
    saw_bash_after_write = False
    for r in result.rounds:
        for tc in r.tool_calls:
            name = (tc.get("function") or {}).get("name", "")
            if name == "write_file":
                saw_write = True
            elif name == "bash" and saw_write:
                saw_bash_after_write = True
    if not saw_write:
        return VerifierResult.fails("agent never called write_file")
    if not saw_bash_after_write:
        return VerifierResult.fails(
            "agent called write_file but never followed up with bash to run it"
        )
    return VerifierResult.passes("wrote, ran, and reported the sentinel")


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

SCENARIOS: list[Scenario] = [
    Scenario(
        name="parallel_math",
        description="Parallel tool calls in round 1, sequential rounds 2–3, final natural-language answer in round 4. Pure tools (no sandbox).",
        system=_MATH_SYSTEM,
        user=_MATH_USER,
        tool_names=["calculator", "is_prime"],
        verify=_verify_parallel_math,
        max_rounds=6,
        needs_sandbox=False,
    ),
    Scenario(
        name="file_exploration",
        description="bash + read_file: discover .txt files, count lines, sum across files.",
        system=_FILE_SYSTEM,
        user=_FILE_USER,
        tool_names=["bash", "read_file"],
        verify=_verify_file_exploration,
        setup=_setup_file_exploration,
        max_rounds=8,
    ),
    Scenario(
        name="write_then_run",
        description="write_file + bash: create a script, execute it, surface stdout.",
        system=_WRITE_SYSTEM,
        user=_WRITE_USER,
        tool_names=["write_file", "bash"],
        verify=_verify_write_then_run,
        max_rounds=6,
        # Qwen 3.6 35B-A3B-4bit (b644) loops on write_file in this
        # scenario — its thinking trace insists "I forgot the
        # parameters" even when the call clearly includes them, so
        # it never advances to the bash step. Three prompt iterations
        # + a louder tool success message all failed to break the
        # loop. Re-test on the next SwiftLM bump or model swap; if it
        # passes, the model has improved (XPASS) and this xfail can
        # be removed.
        expected_pass=False,
    ),
]


def by_name(name: str) -> Scenario | None:
    for s in SCENARIOS:
        if s.name == name:
            return s
    return None


__all__ = ["SCENARIOS", "Scenario", "VerifierResult", "by_name"]
