"""CLI entry: `python3 -m eval` from the package root.

Discovers `/v1/models` against the endpoint, picks the first available
LLM if `--model` isn't given, runs the requested scenarios in order,
prints per-scenario lines + a summary, and exits with the conventional
codes documented in CLAUDE.md (`0` pass, `1` fail, `2` unreachable,
`64` usage error).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from . import agent_loop, scenarios
from .tools import Sandbox

DEFAULT_ENDPOINT = "http://127.0.0.1:5413"
DEFAULT_MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit"


def _probe_endpoint(endpoint: str) -> tuple[bool, str]:
    """Returns (reachable, model_or_error). Falls back to the default
    model name if /v1/models doesn't list anything LLM-shaped."""
    try:
        with urllib.request.urlopen(f"{endpoint}/health", timeout=5) as resp:
            if resp.status != 200:
                return False, f"/health returned HTTP {resp.status}"
        with urllib.request.urlopen(f"{endpoint}/v1/models", timeout=5) as resp:
            payload = json.loads(resp.read())
        models = [m.get("id") for m in payload.get("data", []) if m.get("id")]
        # Filter out obvious non-text models the model server may
        # advertise (mlx_lm.server lists Flux, Z-Image, etc.).
        text_models = [m for m in models if not any(
            kw in m.lower() for kw in ("flux", "z-image", "stable-diffusion")
        )]
        if not text_models:
            return False, "no text-capable model available at /v1/models"
        return True, text_models[0]
    except (urllib.error.URLError, OSError) as e:
        return False, f"endpoint unreachable: {e}"


def _print_round_logs(scenario_name: str, result: agent_loop.LoopResult) -> None:
    for r in result.rounds:
        head = f"  R{r.index}  finish={r.finish_reason}  {r.elapsed_s}s"
        if r.completion_tokens is not None:
            head += f"  tokens={r.prompt_tokens}→{r.completion_tokens}"
        print(head)
        for tc in r.tool_calls:
            fn = tc.get("function") or {}
            args = fn.get("arguments", "")
            if len(args) > 120:
                args = args[:120] + "…"
            print(f"     → {fn.get('name')}({args})")
        for i, res in enumerate(r.tool_results):
            preview = res.replace("\n", " ⏎ ")
            if len(preview) > 120:
                preview = preview[:120] + "…"
            print(f"     ← {preview}")
        if r.content and not r.tool_calls:
            preview = r.content if len(r.content) <= 240 else r.content[:240] + "…"
            print(f"     final: {preview}")


def _run_scenario(
    scenario: scenarios.Scenario,
    endpoint: str,
    model: str,
    verbose: bool,
) -> str:
    """Run one scenario; return its outcome marker.

    Markers (pytest-style):
      PASS  — expected pass, actual pass    → suite remains ok
      FAIL  — expected pass, actual fail    → suite exits 1
      XFAIL — expected fail, actual fail    → suite remains ok (known)
      XPASS — expected fail, actual pass    → suite remains ok, surfaced
    """
    sandbox: Sandbox | None = None
    sandbox_root: Path | None = None
    try:
        if scenario.needs_sandbox:
            sandbox_root = Path(tempfile.mkdtemp(prefix=f"slicc-eval-{scenario.name}-"))
            sandbox = Sandbox(sandbox_root)
            if scenario.setup is not None:
                scenario.setup(sandbox)
        tool_specs = scenario.tools(sandbox)
        result = agent_loop.run(
            endpoint=f"{endpoint}/v1/chat/completions",
            model=model,
            system=scenario.system,
            user=scenario.user,
            tools=tool_specs,
            max_rounds=scenario.max_rounds,
        )
        verdict = scenario.verify(result)
        if verdict.ok and scenario.expected_pass:
            marker = "PASS"
        elif verdict.ok and not scenario.expected_pass:
            marker = "XPASS"
        elif not verdict.ok and not scenario.expected_pass:
            marker = "XFAIL"
        else:
            marker = "FAIL"
        rounds_taken = len(result.rounds)
        print(
            f"[{marker:<5}] {scenario.name:<20} "
            f"{rounds_taken} rounds  {result.total_elapsed_s}s  "
            f"— {verdict.reason}"
        )
        # Print the round transcript when a real fail occurs OR when
        # an xfail unexpectedly passes (so we can update the scenario).
        if verbose or marker in ("FAIL", "XPASS"):
            _print_round_logs(scenario.name, result)
        return marker
    finally:
        if sandbox_root and sandbox_root.exists():
            shutil.rmtree(sandbox_root, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m eval")
    parser.add_argument(
        "--endpoint", default=DEFAULT_ENDPOINT,
        help=f"OpenAI-compatible base URL (default: {DEFAULT_ENDPOINT})",
    )
    parser.add_argument(
        "--model", default=None,
        help="Model id; if omitted, auto-detected from /v1/models",
    )
    parser.add_argument(
        "--scenario", default=None,
        help="Run a single scenario by name (default: run them all)",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List available scenarios and exit",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Print per-round transcripts even on PASS",
    )
    parser.add_argument(
        "--pkg-root", default=".",
        help="Package root (used by npm scripts; ignored otherwise)",
    )
    args = parser.parse_args(argv)

    if args.list:
        print(f"{len(scenarios.SCENARIOS)} scenario(s):")
        for s in scenarios.SCENARIOS:
            print(f"  {s.name:<20} — {s.description}")
        return 0

    selected: list[scenarios.Scenario]
    if args.scenario:
        s = scenarios.by_name(args.scenario)
        if s is None:
            names = ", ".join(s.name for s in scenarios.SCENARIOS)
            print(f"unknown scenario {args.scenario!r}; choose from: {names}", file=sys.stderr)
            return 64
        selected = [s]
    else:
        selected = list(scenarios.SCENARIOS)

    reachable, info = _probe_endpoint(args.endpoint)
    if not reachable:
        print(f"endpoint check failed: {info}", file=sys.stderr)
        return 2

    model = args.model or info
    print(f"endpoint: {args.endpoint}")
    print(f"model:    {model}")
    print(f"running:  {len(selected)} scenario(s)")
    print()

    counts: dict[str, list[str]] = {"PASS": [], "FAIL": [], "XFAIL": [], "XPASS": []}
    for scenario in selected:
        marker = _run_scenario(scenario, args.endpoint, model, args.verbose)
        counts[marker].append(scenario.name)

    print()
    parts = []
    for m in ("PASS", "FAIL", "XFAIL", "XPASS"):
        if counts[m]:
            parts.append(f"{m}={len(counts[m])}")
    print("summary: " + "  ".join(parts))
    # Real failure = expected pass that didn't pass. Everything else
    # (xfail of a known issue, xpass that surprises us upward) is
    # informational and doesn't break the suite.
    if counts["FAIL"]:
        print(f"failed: {', '.join(counts['FAIL'])}")
        return 1
    if counts["XPASS"]:
        print(
            f"unexpected pass: {', '.join(counts['XPASS'])} — "
            "consider flipping expected_pass=True in scenarios.py"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
