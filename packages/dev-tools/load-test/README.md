# SLICC Load Testing Harness

Spawns N parallel SLICC instances, sends each a prompt via CDP, waits for
completion, and collects timing metrics.

## Prerequisites

```bash
npm run build   # Must have dist/node-server/index.js
```

## Usage

```bash
# 3 instances, same prompt
npx tsx packages/dev-tools/load-test/runner.ts \
  --instances 3 \
  --prompt "Create a file /workspace/hello.txt with 'Hello World'" \
  --env-file .env \
  --timeout 120

# 5 instances, different scenarios from JSONL
npx tsx packages/dev-tools/load-test/runner.ts \
  -n 5 \
  --prompts-file packages/dev-tools/load-test/scenarios/basic.jsonl \
  --env-file .env

# Verbose (see all instance stdout/stderr)
LOAD_TEST_VERBOSE=1 npx tsx packages/dev-tools/load-test/runner.ts \
  -n 2 --prompt "Write hello.py" --env-file .env
```

## How It Works

Each instance is fully isolated:

- Own Express server on a unique port (basePort + index \* 10)
- Own Chrome process with port-keyed user-data-dir
- Own IndexedDB (VFS, sessions, scoops) scoped by browser origin
- CDP WebSocket at `ws://localhost:{port}/cdp` for programmatic control

Control flow per instance:

1. Spawn `node dist/node-server/index.js` with `PORT=N`
2. Poll `GET /api/runtime-config` until 200
3. Connect to CDP WebSocket, enable `Runtime` domain
4. Poll DOM for agent idle state (stop button hidden)
5. Set textarea value + click send via `Runtime.evaluate`
6. Poll DOM until agent finishes (stop button hidden again)
7. Optionally verify VFS file content via LightningFS IndexedDB
8. Tear down: close CDP, SIGTERM server, SIGKILL if needed

## Scenarios

JSONL format — one scenario per line:

```jsonl
{
  "prompt": "Create /workspace/hello.txt containing 'Hello'",
  "expectFile": "/workspace/hello.txt",
  "expectContains": "Hello"
}
```

Fields:

- `prompt` (required) — the message to send to the agent
- `expectFile` — VFS path to verify exists after completion
- `expectContains` — substring the file content must include

If fewer scenarios than instances, they're assigned round-robin.

## Output

```
Instance 1 (port 5800): PASS    23.4s
Instance 2 (port 5810): PASS    19.8s
Instance 3 (port 5820): TIMEOUT N/A — Timeout waiting for agent idle after 120000ms

Summary: 2/3 passed, 1 timed out
Timing:  avg 21.6s, p50 21.6s, p95 23.4s
```

A JSON report is also saved to `load-test-report-{timestamp}.json`.
