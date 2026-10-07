---
name: mcp
description: |
  Connect to remote MCP servers, and publish this cone's .jsh CLIs as one
  remote MCP server with `mcp --serve`. Use when an agent should call an
  external MCP tool, or when a skill CLI should be reachable from another
  MCP client while this session is the leader.
allowed-tools: bash
---

# mcp

`mcp add` connects this cone to someone else's server. `mcp --serve` does the opposite: it publishes `.jsh` CLIs from this session as one server.

## Publish CLIs

```bash
mcp --serve /workspace/skills/jira/jira.jsh
mcp --serve gh=/workspace/skills/github/scripts/gh.jsh
```

The first call prints one URL, `https://<token>.sliccy.now/mcp`. A later `mcp --serve` joins that same URL. `name=path` sets the tool prefix when two files would otherwise collide.

```bash
mcp --serve --list
mcp --serve --stop gh
mcp --serve --stop
```

`--list` prints the URL and the CLI names. `--stop` with a name drops that CLI and leaves the URL valid. `--stop` alone revokes the server.

Each call runs the script once. Calls for one CLI run one at a time. A call that passes the time budget returns an error and leaves the script running; the next call for that CLI waits until it exits. Tool names always carry the CLI prefix: `jira_get`, `jira_help`, `jira_invoke`, `gh_pr_list`. `invoke` takes `{ "argv": ["get", "PROJ-1"], "stdin": "optional" }`. `argv` is one element per argument.

The other client signs in on that URL. Accept lets it run every CLI in the set, including each script's `skill.token` and the signed-in browser tabs. Adding a file after Accept asks again. Stopping one CLI does not.

The URL lasts while the publication does, including across reload. Tool calls need this session to be the leader. Discovery and token refresh still answer when it is away.

A script may print JSON on `--mcp` and exit 0 to name its own commands. Otherwise commands come from `--help`.

The publication file is `/workspace/.mcp/served.json`. That is not `/workspace/.mcp/servers.json`, which is the list of servers this cone connects to.

## Connect to a server

```bash
mcp add https://example.com/mcp weather
mcp exposure weather direct
mcp invoke weather get-forecast --lat 51.5 --lon -0.12
mcp list
mcp delete weather
```

`mcp exposure weather direct` exposes that server's tools to the agent. The default keeps them inside a server-local QuickJS tool.
