/**
 * `agent --help`. Kept out of `agent-command.ts` and imported only when help
 * is asked for, so the text stays off the kernel worker's boot-critical graph.
 */
export const AGENT_HELP = `usage: agent <cwd> <allowed-commands> <prompt>

Spawns a sub-scoop, feeds it a task, blocks until the agent loop completes,
then prints the scoop's final message on stdout.

Arguments:
  <cwd>               Working directory for the spawned scoop. Becomes the
                      scoop's sole writable prefix. Relative paths are resolved
                      against the current shell's cwd; '.', '..', and absolute
                      paths are all supported.
  <allowed-commands>  Comma-separated list of bash commands the scoop may run.
                      Use '*' to allow every command. Whitespace is trimmed
                      around each entry; duplicates are tolerated.
  <prompt>            Prompt forwarded verbatim to the scoop.

Default sandbox:
  The spawned scoop sees (read-only):  the OWNING cone's workspace (+ skills)
                                       + the invoking shell's cwd
  The spawned scoop writes to:         <cwd>, /shared/, /scoops/<name>/, /tmp/
  /tmp/ is always writable — no flag toggles it.

Options:
  --model <id>            Override the model id used by the spawned scoop.
                          Accepts an exact id, a shorthand ('haiku', 'sonnet',
                          'claude-haiku-4-5'), or the 'provider:model' form
                          the 'models' command prints
                          ('openrouter:openai/gpt-5.6-terra-pro'). A bare id
                          resolves against the selected provider first, then
                          against any other CONFIGURED provider that offers
                          it; matching several is an error listing the
                          qualified ids. The scoop runs on the provider the
                          model was resolved from. A model from a provider
                          other than the selected one must also be allowed in
                          /etc/models; the error quotes the line to add. An id
                          that cannot be resolved (or is not allowed) exits 1 —
                          it never falls back to the parent's model. Defaults
                          to inheriting the parent's model.
  --thinking <level>      Reasoning / thinking level for the spawned scoop.
                          One of: off, minimal, low, medium, high, xhigh.
                          Defaults to inheriting the parent's level (or 'off'
                          when there is no parent). 'xhigh' is silently
                          clamped to 'high' when the resolved model doesn't
                          support it. Ignored entirely for non-reasoning
                          models. Aliased as --effort.
  --workspace-mode <mode> Isolation policy for the spawned scoop's filesystem
                          view. One of: private, shared-readonly (default),
                          snapshot, shared-live. Default shared-readonly is
                          today's sandbox: parent workspace + skills + the
                          invoking cwd are visible, <cwd> + /shared/ + scratch
                          are writable, mounts stay readable. private is an
                          isolated sandbox (own cwd/scratch only — no parent
                          workspace, no implicit /shared/, mounts are NOT
                          auto-visible). snapshot and shared-live are not
                          implemented and exit 1. Explicit --read-only still
                          replaces the mode's visiblePaths.
  --read-only <paths>     Comma-separated VFS paths exposed read-only to the
                          spawned scoop (visiblePaths). Pure replace — the
                          owning cone's roots AND the implicit ctx.cwd add are
                          BOTH dropped. To keep them, name your own cone's
                          workspace ("$(pwd),/workspace/skills/") — a literal
                          /workspace/ is the PRIMARY cone's. Each entry is
                          normalized to a trailing slash.
  --background-after <s>  Seconds the spawned scoop's bash tool waits for a
                          command before detaching it to the background and
                          continuing (default 600). The detached command's exit
                          code and output come back to the scoop as a
                          "Background Command" lick, so a slow or stuck command
                          never wedges an unsupervised run. Use 0 to detach
                          every command immediately. Must be >= 0.
  --image <path>          Attach an image (PNG, JPEG, GIF or WebP) to the
                          prompt, so the scoop can see it without being
                          allowed a command to open it. Repeatable, up to 8;
                          --image=<path> also works. Relative paths resolve
                          against the current shell's cwd. A missing file, a
                          non-image, or a ninth image exits 1 before anything
                          is spawned. Large images are resized to the model's
                          limits.
  --no-escalate           Hold the scoop to its grant. Normally a command not
                          in <allowed-commands>, or a write outside its
                          writable paths, asks the invoking cone for approval;
                          with this flag it is refused at once and the scoop
                          is told it is not permitted for this call. Nothing
                          reaches the cone or the user, and stored "Always"
                          grants do not apply either.
  --persist-session       Write the spawned agent's full session transcript to
                          /sessions/agent-<name>-<timestamp>.md (durable —
                          survives a new chat) for later human analysis.
  --no-persist-session    Do not write a session transcript at all. With
                          NEITHER flag, the transcript is written to
                          /tmp/agent-<name>-<timestamp>.md, which a new chat
                          clears.
  -h, --help              Show this help message and exit.

Examples:
  agent . "*" "say hello in one word"
  agent /home ls,wc,find "how many files do I have in my home directory"
  agent --model claude-haiku-4-5 . "*" "summarize files in this directory"
  agent --thinking high . "*" "design a careful plan first"
  agent --read-only /workspace/,/shared/assets/ . "*" "review the docs"
  agent --workspace-mode private . "*" "work only in this directory"
  agent --background-after 60 . "*" "run the slow build and report"
  agent --no-escalate --image shot.png . ls "what does this page show?"
`;
