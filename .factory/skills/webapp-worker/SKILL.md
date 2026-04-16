---
name: webapp-worker
description: Implements the `agent` supplemental shell command in the SLICC webapp — writes TypeScript, adds tests, runs CI gates, and manually validates via CDP-connected browser.
---

# webapp-worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Any feature that:

- Adds or modifies code in `packages/webapp/`, `packages/chrome-extension/`, or `packages/node-server/`
- Implements or touches the `agent` supplemental shell command
- Modifies the scoops / orchestrator / shell / tools subsystems
- Adds Vitest tests for any of the above

## Required Skills

- **`agent-browser`** — Required for manually validating the `agent` command end-to-end in the running SLICC app. Use after implementation + unit tests pass, to drive the real UI via CDP. Launch `http://localhost:5710`, open terminal panel, run the command, observe output. Capture screenshots as evidence for the interactiveChecks handoff field.

## Work Procedure

Follow this procedure strictly. Do not skip steps.

### 1. Understand the feature

- Read `mission.md` and `validation-contract.md` in missionDir for the full requirements.
- Read `.factory/library/architecture.md` for the design.
- Read the feature's `description`, `preconditions`, `expectedBehavior`, `verificationSteps`, and `fulfills` — these define "done".
- For each assertion ID in `fulfills`, locate the assertion in `validation-contract.md` — your implementation must make that assertion pass.
- If anything is ambiguous or contradicts what you find in the codebase, stop and return to orchestrator.

### 2. Verify baseline is green (on first feature only, or after mission-wide changes)

Run these and confirm all pass BEFORE making changes:

```bash
npx prettier --check .
npm run typecheck
npm run test
```

If any fails on baseline, STOP and return to orchestrator — do not start work on broken ground.

### 3. Write tests FIRST (red)

- Add the tests for this feature to the appropriate file in `packages/webapp/tests/...` (follow existing structure — mirror `src/`).
- Use the patterns in sibling test files: `defineCommand` factories + mock `CommandContext`, `fake-indexeddb/auto` for FS tests, `vi.stubGlobal` for global hooks.
- Run the new tests — they MUST fail (red). If a test passes before you implement, the test is wrong.
- Commit nothing yet.

### 4. Implement (green)

- Write the minimum code to make the new tests pass.
- Match existing code style: TypeScript strict, `defineCommand` for supplementals, `createLogger('namespace')` for logging, `import type` for type-only imports.
- For any new file, run `npx prettier --write <file>` immediately after writing it.
- Re-run the tests — they MUST now pass.

### 5. Run ALL CI gates

Run in order. All must pass:

```bash
npx prettier --write packages/  # format ALL changed files
npm run typecheck
npm run test
npm run build -w @slicc/webapp
npm run build -w @slicc/chrome-extension
```

If any step fails, fix it before proceeding. Every commit must leave these gates green.

### 6. Manual verification via CDP-connected browser

**This is REQUIRED. Do not skip.** The user has explicitly asked for the dev server to stay open during development for manual investigation.

1. Check if the dev service is already running: `curl -sf http://localhost:5710` and `curl -sf http://localhost:9222/json/version`.
2. If NOT running, start it:

   ```bash
   # Foreground (blocks): use fireAndForget=true in Execute so you can continue
   PORT=5710 npx tsx packages/node-server/src/index.ts --dev
   ```

   Wait ~5 seconds, then healthcheck both endpoints.

3. Invoke the `agent-browser` skill to connect to the running Chrome via CDP (port 9222) and navigate to `http://localhost:5710`.
4. Take a screenshot of the initial UI.
5. Open the terminal panel (it may need to be toggled via `debug on`).
6. Type a representative `agent` invocation for the feature under test (e.g., for an arg-parsing feature, test `agent --help`; for the scoop-spawn feature, test `agent . "*" "say hello"` with a configured provider).
7. Capture the output and take screenshots.
8. Record EVERY manual step as a separate `interactiveChecks` entry in your handoff.
9. **Leave the dev server running** for the next worker / the user's manual investigation.

If the dev server cannot be started (port conflict, missing dep, build failure), STOP and return to orchestrator with diagnostic info.

### 7. Update `.factory/library/` if you discovered new facts

If you learned something a future worker would benefit from (gotcha, API detail, constraint), append a short, dated note to the relevant library file (`architecture.md`, `environment.md`, or `user-testing.md`).

### 8. Commit

- Stage only files relevant to your feature.
- Commit with a descriptive message (conventional-commit style OK but not required).
- Run `git status` after commit — no stragglers should remain in the working tree unless they belong to a later feature.

### 9. Handoff

Fill in the handoff with the level of detail shown in the Example Handoff below. Specifically:

- `verification.commandsRun` — every gate you ran, with exit codes and the key output observation.
- `verification.interactiveChecks` — every browser-based step, with action and observed outcome.
- `tests.added` — list each new test case by name with what it verifies.
- `discoveredIssues` — any bugs, surprises, or tech debt you uncovered.
- `whatWasLeftUndone` — be honest; if you skipped a validation step, say so.

## Example Handoff

```json
{
  "successState": "success",
  "salientSummary": "Added `agent` supplemental command arg parsing + help (`--help`, `-h`, usage syntax, flag + positional parsing). Wrote 8 new vitest cases (all passing). Ran full CI gates (prettier, typecheck, test, webapp build, extension build) — all green. Started dev server on :5710, connected via CDP to :9222, verified `agent --help` prints usage in the terminal panel.",
  "whatWasImplemented": "Created packages/webapp/src/shell/supplemental-commands/agent-command.ts with createAgentCommand() factory. Registered it in supplemental-commands/index.ts. Added entry to COMMAND_CATEGORIES in help-command.ts. Implemented argument parsing: <cwd> <allowed-commands> <prompt>, plus --model <id>, --help, -h. Returns usage on --help; errors on missing args with clear stderr and exitCode 1. Stub calls into globalThis.__slicc_agent (bridge wiring is a later feature). Added packages/webapp/tests/shell/supplemental-commands/agent-command.test.ts with 8 test cases.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npx prettier --check .",
        "exitCode": 0,
        "observation": "No formatting issues."
      },
      {
        "command": "npm run typecheck",
        "exitCode": 0,
        "observation": "browser + node + worker typecheck all clean."
      },
      {
        "command": "npm run test -- shell/supplemental-commands/agent-command",
        "exitCode": 0,
        "observation": "8 tests passed, 0 failed."
      },
      {
        "command": "npm run test",
        "exitCode": 0,
        "observation": "Full suite: 1247 passed, 0 failed."
      },
      {
        "command": "npm run build -w @slicc/webapp",
        "exitCode": 0,
        "observation": "dist/ui/ built cleanly in 14s."
      },
      {
        "command": "npm run build -w @slicc/chrome-extension",
        "exitCode": 0,
        "observation": "dist/extension/ built cleanly."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Started dev service: `PORT=5710 npx tsx packages/node-server/src/index.ts --dev` (fireAndForget).",
        "observed": "curl http://localhost:5710 returns 200; curl http://localhost:9222/json/version returns Chrome version JSON."
      },
      {
        "action": "Connected via agent-browser to CDP port 9222, navigated to http://localhost:5710.",
        "observed": "SLICC UI loaded; took screenshot showing chat panel and files panel."
      },
      {
        "action": "Typed `debug on` in chat to reveal terminal panel, then switched to terminal tab.",
        "observed": "Terminal panel became visible with bash prompt `/ $`."
      },
      {
        "action": "Typed `agent --help` and pressed Enter in the terminal.",
        "observed": "Usage text printed — lines match the USAGE constant in agent-command.ts; exit code 0 (prompt returned without error)."
      },
      {
        "action": "Typed `agent` with no args.",
        "observed": "Error on stderr: 'agent: missing required argument <cwd>'; exit code 1."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "packages/webapp/tests/shell/supplemental-commands/agent-command.test.ts",
        "cases": [
          { "name": "has correct command name", "verifies": "command registered as 'agent'" },
          {
            "name": "prints help with --help",
            "verifies": "usage text contains 'agent <cwd>' and lists --model flag"
          },
          { "name": "prints help with -h", "verifies": "-h alias behaves identically to --help" },
          {
            "name": "errors when called with no args",
            "verifies": "exitCode 1, stderr contains 'missing required argument'"
          },
          {
            "name": "errors when called with only cwd",
            "verifies": "exitCode 1, stderr mentions <allowed-commands>"
          },
          {
            "name": "errors when called with only cwd+commands (no prompt)",
            "verifies": "exitCode 1, stderr mentions <prompt>"
          },
          {
            "name": "parses --model flag in any position",
            "verifies": "model is extracted, positional args remain in order"
          },
          {
            "name": "resolves relative cwd against ctx.cwd",
            "verifies": "'.' resolves to ctx.cwd; '/abs' unchanged"
          }
        ]
      }
    ]
  },
  "discoveredIssues": [],
  "handedOffLibraryUpdates": []
}
```

## When to Return to Orchestrator

- Baseline CI gates fail on clean checkout
- The `dev` service cannot be started (port conflict, Chrome launch failure, missing deps)
- CDP port 9222 is not reachable even after the dev server comes up
- A test you wrote as red unexpectedly passes without your implementation — the spec is ambiguous
- You hit a scope creep moment — the feature requires touching files the description didn't mention, AND those changes would be substantial
- An assertion in your `fulfills` cannot be made to pass without violating another assertion
- Any `agent-browser` session fails to connect and you cannot recover after two retries
