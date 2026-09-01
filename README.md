![A screenshot of a macOS desktop](docs/screenshots/full-desktop.png)

You are looking at a macOS desktop, with four windows running:

1. Google Chrome, running SLICC as a web application. It shows a Welcome page, a hidden tab with meeting preparation notes that were created by the agent, and a terminal, showing that the operating system is of the unlikely `Mozilla/5.0` kind. What?
2. Slack, the desktop app. Err. Slack the Electron app. It has an overlay injected, showing the ice cream logo asking to join a tray. If you do this, Slack can be remote-controlled by your agent. What the?
3. Sliccstart, the desktop app. It's an actual macOS app, but one that controls browsers, and browsers that pretend to be native apps alike. What the ice cream?
4. An image of an anthropomorphized ice cream cone made out of felt and googly eyes. It's sticking out its tongue, half in astonishment, half in anticipation. What the ice cream truck?

If this scares, confuses, or excites you, keep reading.

# slicc — Self-Licking Ice Cream Cone

[![50% Vibe_Coded](https://img.shields.io/badge/50%25-Vibe_Coded-ff69b4?style=for-the-badge&logo=claude&logoColor=white)](https://github.com/ai-ecoverse/vibe-coded-badge-action)

[![npm](https://img.shields.io/npm/v/sliccy)](https://www.npmjs.com/package/sliccy)

> A browser-native AI agent for getting practical work done in and through the browser.

🍦 **Home page & hosted app:** [www.sliccy.com](https://www.sliccy.com)

SLICC runs in a browser and controls the browser it runs in. It combines a shell, files, browser automation, and multi-agent delegation so you can do real work from one workspace — coding, web automation, authenticated app tasks, and the weird in-between jobs that do not fit neatly inside a chat panel. SLICC can orchestrate multiple browsers, and even some apps through telepathy, making it a powerful hub for your digital work.

The fastest ways to try it:

- **Open [www.sliccy.com](https://www.sliccy.com) in Chrome** — the hosted webapp boots SLICC straight in your browser tab.
- **Install the macOS app** — grab the latest `.dmg` from [releases](https://github.com/ai-ecoverse/slicc/releases). No Windows or Linux UI yet.
- **Run the CLI** — `npx sliccy` launches Chrome with the local workspace attached. Node 22+ required.
- **Install the headless follower CLI** — `curl -fsSL https://www.sliccy.ai/install-cli | sh` installs the Go `slicc` follower binary (macOS, Linux, WSL, Git Bash) into `~/.local/bin` (or a writable `/usr/local/bin`). Native Windows: `irm https://www.sliccy.ai/install-cli.ps1 | iex`.
- **Load the Chrome extension** — a thin bridge that opens SLICC in an on-demand Chrome side panel.

Once you're in, you can:

- Connect other browser windows or Electron apps into one shared session
- Run leader-shell commands from the native iOS follower's Terminal tab, or ask the leader to open another iOS app after an on-device approval
- Act on what the agent wrote without leaving the iOS chat: tap a snippet or long-press a code block to copy or share it, tap a file it mentioned or a pasted base64 blob to preview it, tap a link to open it in Sliccy's own browser, and tap a phone number to text it
- Approve the agent's sudo requests from your iPhone with Face ID — including when the leader is running headless in the cloud — and get a push when a turn finishes or an approval is waiting
- Keep an eye on the session from a **Cones & Scoops** home-screen widget on iPhone, iPad and the Mac desktop: what the cone is doing, the scoops under it, how full each context is, and whether anything needs you ([details](docs/widgets.md))
- Install skills that teach the agent how to perform challenging tasks
- Give it practical tools models already know how to use (`bash`, `git`, `node`, `python`, `playwright`)
- Delegate parallel work to sub-agents so tasks get done faster

> Status: active working prototype. The macOS app is the easiest way in today; the extension has been submitted to the Chrome Web Store.

## Why SLICC is different

- **Browser-native, not browser-adjacent.** The agent runtime lives in the browser, and the agent can act on the same browser it lives in. A great mix of power and containment. If you don't like what the AI does, close the browser tab and it's over.
- **A real shell environment.** Many browser agents are constrained by the tools provided to them. SLICC has an almost-too-real shell with commands like `git`, "`node`", `python`, `playwright`, built-in.
- **UI on the fly.** SLICC can generate rich user interfaces on the fly. These can be small visualizations in a chat response, or full-blown web applications that run in a sidebar, or even a separate tab.
- **Built around Skills.** Agents don't suffer from missing capabilities, they suffer from skill issues. SLICC can install native skills into `/workspace/skills`, and it also discovers compatible `.agents` / `.claude` skills read-only across the reachable VFS.
- **More than a coding panel.** Coding is one strong use case, but SLICC is built for practical browser work too: authenticated web apps, repetitive tab work, content operations, debugging, research, and automation.
- **Works across runtimes.** Start in the CLI, run the thin Chrome extension that loads SLICC from `sliccy.ai`, connect multiple tray sessions, attach to Electron apps, embed SLICC into any third-party page via the [`@ai-ecoverse/cherry`](packages/cherry/) host SDK, or join from an iOS follower (`SliccFollower`) with read/write leader files in Files.app — all on the same core.
- **Delegates in parallel.** The main agent can spin up isolated sub-agents for task-specific work instead of stuffing everything into one conversation.

## Who it is for

SLICC is for you if:

- you spend a lot of your day in browsers, terminals, and web apps
- you want an agent that can act, not just answer
- you are curious about automation, shell tools, and technical workflows
- you want one system that can span local dev work, browser tasks, and Electron surfaces
- you are an AI/web-dev-adjacent builder, power user, who's comfortable with things being broken from time to time (we are working hard to make this smoother)

## What you can do with it

- **Launch an agent from the CLI and let it work in the browser it controls.** Start one command, open the workspace, and give the agent shell tools, files, and live browser access in one place.
- **Automate repetitive workflows in authenticated web apps.** Use browser automation, page inspection, screenshots, storage access, and scripted tab control where your logged-in browser session already has the context.
- **Hand work off from another coding agent into your live browser session.** Open any URL whose response carries an RFC 8288 `Link` header with a SLICC handoff or upskill rel (the tray-hub `/handoff?handoff=...` / `?upskill=...` endpoint is a convenience) and SLICC prompts you to approve the action inside the Chat tab.
- **Solve technical tasks with practical tools.** Reach for `bash`, `git`, `grep`, `node`, `python`, previews, and browser automation when the job is bigger than text generation.
- **See image-producing tool results directly in chat.** Supported `<img:data:image/...;base64,...>` markers from commands such as `open --view` and `screencapture` render as bounded, lazy-loaded inline images in chat tool rows. Each tool body displays at most four images and shows an explicit overflow indication when more are present.
- **Serve driveable previews.** `serve --bridge <dir>` mints a URL whose every visitor tab becomes a live, leader-driveable synthetic-CDP target — the agent can navigate/click/evaluate/screenshot and weave in webhook licks. **Security: opt-in only; cross-subdomain cookie risk accepted and documented (host-only cookies isolated per preview; `Domain=.sliccy.now` cookies readable across all previews).**
- **Publish persistent previews.** `serve --ttl 30d <dir>` uploads an immutable snapshot that remains available without the tray leader for up to 30 days; `serve --stop <token>` revokes it early.
- **Click a file the agent mentions.** When the agent writes a file name in chat — `bb.jsh`, `check.sh`, `packages/webapp/src/main.ts:42` — SLICC checks it against the workspace in the background and turns the ones that really exist into links. Clicking opens a preview; a mention that does not resolve stays plain text, so there are no dead links. A file with uncommitted changes opens on its diff. Names are read in the context of what the agent has already DONE: after `echo "test" > /home/lars/foo.md`, a later "see foo.md" links to that exact file — even when it lives outside the workspace, and even when three other `foo.md` files exist.
- **Preview a pasted base64 payload instead of scrolling past it.** A blob pasted into chat — a screenshot as a `data:` URL, the output of `base64 < report.pdf` — collapses to a chip naming what it is and how big it is (`png · 12 KB`). Clicking opens it in the same previewer a file name does: images render, PDFs and audio play, text and JSON are syntax-highlighted. Only payloads SLICC can actually decode and recognize are collapsed; anything else stays exactly as you typed it, and long strings of every kind now wrap instead of dragging the chat column sideways.
- **Read markdown and HTML, or read their source.** A `.md` or `.html` preview opens as the document — formatted prose, a laid-out page — with a **Source** toggle for the syntax-highlighted markup (and **Diff** when the file has uncommitted changes). HTML renders in a sandboxed frame that cannot run scripts or reach the app.
- **Preview any file, not just the well-known types.** The previewer identifies files from their CONTENT rather than a list of extensions, so an unrecognized extension (`.jsh`, a `Justfile`) previews as source instead of refusing. Text is syntax-highlighted, PDFs render inline, and images, audio, and video play as before.
- **Add visual and file context directly in chat.** Drop images or files onto the workspace, or use the paperclip button. Dropped `.skill` archives still install into `/workspace/skills`.
- **Inspect experimental features from the avatar menu.** When centrally managed flags enable the surface for the current runtime, click your avatar and choose **Experimental features…** to open its standalone dialog. The dialog may honestly be empty: `experimental-settings` controls its availability but is not itself user-toggleable.
- **Steer a running turn instead of waiting for it.** In the chat composer, `Enter` sends — including from a hardware keyboard in the native iOS follower — and queues behind whatever the cone is already doing; `Shift+Enter` inserts a newline. `Ctrl+Enter` (`Cmd+Enter` on macOS) steers: the message is injected as soon as the current step finishes, so you can redirect the agent mid-turn.
- **Boot full x86 virtual machines in the browser.** `v86 start` runs real operating systems (Alpine, FreeDOS, KolibriOS, ...) on the wasm-based [v86](https://github.com/copy/v86) emulator, entirely client-side. The agent drives the guest from the shell — type, click, screenshot, stream the screen live, save/restore state — and `-net <model>,relay=fetch` gives the guest HTTP access through SLICC's fetch proxy. Install with `ipk add -g v86`.
- **Delegate parallel work to scoops.** Split tasks into isolated sub-agents with their own sandboxes and context, then let the main agent coordinate the results.
- **Turn one-off wins into reusable workflows.** Package behavior as skills, build interactive sprinkles, and react to external events with webhooks and cron-driven licks.
- **Mount your local file system.** By default, SLICC is confined to your browser. But you can ask it to mount folders from your local file system, so it can read and write from there. Mount into an empty path such as `/mnt/myproject` so you do not hide existing skills or scripts. Tear one down with `umount /mnt/myproject` (or the longer `mount unmount /mnt/myproject`). Picker mounts ask again after a page reload; for folders you always want available, map them in the launcher's mount table (`npx slicc --mount=~/Projects/foo:/mnt/foo`, or Settings → Mounts in Sliccstart.app) and they are mounted automatically on every launch, with no picker or permission prompt — see [Auto-mounted host folders](docs/mounts.md#auto-mounted-host-folders-the-mount-table).
- **Mount remote storage as if it were local.** Beyond local folders, `mount --source` bridges S3 buckets, S3-compatible services like Cloudflare R2 and MinIO, and Adobe authoring content — both da.live repositories and Helix 6 sites on the AEM Source Bus — into the same VFS surface. Reads use TTL+ETag caching with conditional revalidation; writes use ETag-conditional PUTs that surface concurrent-edit conflicts as `EBUSY`. Credentials live server-side (`~/.slicc/secrets.env` in CLI, `chrome.storage.local` in the extension via the **Extension options** page) and never reach the agent. After setup: `mount --source s3://my-bucket --profile r2 /mnt/r2`, `mount --source da://my-org/my-repo /mnt/da`, or `mount --source aem://my-org/my-site /mnt/aem`. A `da://` source checks the site config first and re-routes to the Source Bus when the site has been upgraded to Helix 6, rather than quietly mounting a store that no longer holds its content. See [docs/mounts.md](docs/mounts.md) for the full guide.

## Getting started

### 1. Quick start with npx

The fastest way to try SLICC — no clone, no install:

```bash
npx sliccy
```

This downloads the latest release, launches Chrome, and opens the workspace. Configure your LLM provider in the first-run settings dialog. Requires Node >= 22.

### 2. Install globally

If you plan to use SLICC regularly:

```bash
npm install -g sliccy
slicc
```

### 3. Run from source (contributors)

```bash
git clone https://github.com/ai-ecoverse/slicc.git
cd slicc
npm install
npm run dev
```

`npm run dev` runs the node-server with Vite HMR, launches Chrome, and opens the workspace on `http://localhost:5710`. `npm start` runs the pre-built bundle from `dist/`, so use it only after `npm run build`.

- Optionally pre-configure providers: `cp packages/dev-tools/providers.example.json packages/webapp/providers.json`
- See [packages/dev-tools/providers.example.json](packages/dev-tools/providers.example.json) for the available provider fields.
- For contributor-focused setup details, see [docs/development.md](docs/development.md).

### 4. Chrome extension

The extension is a **thin CDP bridge** — no bundled UI, no offscreen agent engine. The full SLICC webapp loads from the hosted leader tab (`https://www.sliccy.ai/?slicc=leader`); the extension just pins that tab, proxies `chrome.debugger` to it, and — when you click the toolbar icon — opens an on-demand Chrome side panel that iframes the hosted `?cherry=1` follower for inline use.

```bash
npm install
npm run build -w @slicc/chrome-extension
```

Load `dist/extension/` as an unpacked extension in `chrome://extensions`. The service worker pins the hosted leader tab on install; clicking the toolbar icon focuses it (or recreates it if the user closed it). Each page you visit gets the launcher overlay, which iframes the same hosted webapp as an auto-follow follower.

### 5. Run a second browser

SLICC can mirror itself across multiple browsers, even on other machines:

1. **First browser:** click your avatar in the top-right header and choose **Enable multi-browser sync**. A dialog opens with the sync URL (already copied to your clipboard) and step-by-step instructions. The same dialog has a **Reset URL** button if you want to invalidate the link and disconnect connected browsers. (You can also type `host` in the built-in terminal to print the URL.)
2. **Second browser:** open the account dialog, click **Connect to another browser**, and paste the URL. The "How do I get the sync URL?" hint inside the dialog walks through the same steps.
3. **Leaving the tray:** click the avatar on either browser to open the popover — the tray section now has a **Stop multi-browser sync** (leader) or **Disconnect from leader** (follower) action. From the terminal, `host leave` does the same thing; `host leave --leader <worker-url>` leaves the current role and becomes a leader on that worker.

Tray protocol changes are additive, so older browsers keep syncing while newer controls stay hidden until both peers support them. Once connected, the sessions stay in sync in real time. A follower can switch the model of the cone it is viewing — model selection is per cone, so this never disturbs the cone the leader is working in — and adjust thinking for its selected scoop, while provider credentials remain on the leader.

### 6. Electron

SLICC can also attach to Electron apps and inject the same shared overlay into their pages. The best way to use it with Electron apps is to use the Join Tray feature, so that the Electron app becomes a remote-controllable target.

```bash
npm run dev:electron -- /Applications/Slack.app
```

For the full Electron workflow, see [docs/electron.md](docs/electron.md).

### 7. Headless follower CLI

`slicc` (the Go CLI in `packages/slicc-cli/`) joins a leader session from any terminal — `prompt`, `exec`, `watch`, and `follow` over the same WebRTC tray channel the browser and iOS followers use. Install the released binary for your platform:

```bash
npx sliccy --install-cli
```

This finds the newest release carrying CLI binaries (they only attach when the CLI changed) and installs the one for your OS/architecture to the idiomatic place: `~/.local/bin` when it is on your `PATH`, otherwise `/usr/local/bin` when writable without privileges, otherwise `~/.local/bin` with a PATH hint (`%LOCALAPPDATA%\Programs\slicc` on Windows; `--install-dir <dir>` overrides).

On macOS, launching a terminal follower from Sliccstart also exposes its managed CLI at `~/.local/bin/slicc`. Existing user installs are never replaced, and failure to create the symlink does not block the terminal launch.

## How it works

SLICC shares one core across every runtime ("float"). The browser is not just where you view the product — it is where the agent runtime lives.

- **Browser-first runtime:** the agent loop, virtual filesystem, shell, UI, and tools run client-side.
- **Thin server where needed:** the CLI path mainly exists to launch Chrome, proxy CDP, and bridge the few things browsers cannot do alone. The Chrome extension is even thinner — UI and agent engine load from the hosted leader tab.
- **One model across floats:** CLI / standalone, thin Chrome extension, Electron, Cherry (embedded follower in third-party pages), hosted-leader / cloud (`@slicc/cloud-core` over an e2b sandbox), and the native macOS / iOS surfaces (`Sliccstart`, `slicc-server`, `SliccFollower`) all reuse the same underlying system.
- **Cone + scoops delegation:** the main agent orchestrates; sub-agents execute in isolated sandboxes and report back.
- **Skills explain the world to the agent:** don't expect the agent to know everything, ask it to search and install skills that are relevant to the task.

## The SLICC vocabulary and lore

Once the product makes sense, the ice-cream language is easier to enjoy: it maps to real architecture, not just mascot energy.

- **Cone** — the main agent you interact with. It holds the broad context, owns the overall workflow, and delegates work. Experimental: with the **Multiple cones** flag on (Settings → Experimental), the left rail's action row gains **New cone** (name it; your current chat stays where it is) and **Drop cone** (its chat goes to the Freezer without memory extraction, together with its scoops; the last cone can never be dropped). Cones switch from the tab strip — all cones first, then the scoops of the one you are in. Each cone keeps its own conversation and its own model: the model picker changes the cone you are looking at, switching cones switches the model back, a new cone starts on the model of the cone you created it from, and a scoop keeps the model its cone had when it was spawned. **New chat** / **New chat, fast** / **Discard** archive and clear the cone you are looking at. There is one Freezer for all cones; a thawed chat says which cone it came from. Licks and the first-run welcome stay with the original cone. Each extra cone also gets its own workspace (`/cones/<folder>/workspace`) and memory file, so cones do not overwrite each other's files or interleave each other's memory — what a cone learns is remembered for that cone; `/shared`, `/tmp` and installed skills stay common. **You never talk to a scoop directly**: opening one from the tab strip shows its transcript with no composer — you watch it work, and everything it needs from you (a sudo request, an approval, a nudge when it goes idle) appears in the chat of the cone that owns it. The cone is where you answer, and `feed_scoop` from the cone is the only way to send a scoop input. The iPhone/iPad follower shows the same read-only scoop view.
- **Scoops** — isolated sub-agents with their own filesystem sandbox, shell, and conversation history.
- **Licks** — external events that wake an agent up: webhooks, cron jobs, and other signals from the outside world.
- **Floats** — normal engineers would call it runtimes, but would normal engineers have come up with this?
- **Tray** — multiple floats can form a tray, a joint session with remote control.
- **Sprinkles** — everything is better with sprinkles: small, optional enhancements you can add on top of the core system.

Why the name? SLICC stands for **Self-Licking Ice Cream Cone**: a recursive system that can help build, extend, and operate itself. A browser agent running inside the browser: that's as self-recursive as tongue-out gelato.

## Keyboard mode

SLICC's main control is a text field, so it has no always-on shortcuts to collide with your typing. Instead it has a **mode**, like vim — and, like vim, the mode is where you rest: keyboard mode is on whenever nothing is focused for typing, and every key below is a bare letter. Press <kbd>Esc</kbd> to leave the composer for it, or just click somewhere that is not a text field. To type again, press <kbd>⏎</kbd> or <kbd>i</kbd> (or click into the composer). While the mode is on, a pill above the composer says so.

| Key                          | Action                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| <kbd>Esc</kbd>               | Leave the composer for keyboard mode (again: exit full screen)    |
| <kbd>i</kbd> or <kbd>⏎</kbd> | Back to the composer                                              |
| <kbd>?</kbd>                 | This list, in an overlay                                          |
| <kbd>1</kbd>…<kbd>9</kbd>    | Switch to that agent in the tab strip (<kbd>9</kbd> = last)       |
| <kbd>→</kbd> / <kbd>←</kbd>  | Next / previous agent, looping                                    |
| <kbd>n</kbd> / <kbd>N</kbd>  | New conversation / new conversation, erasing this one             |
| <kbd>c</kbd> / <kbd>C</kbd>  | New cone / drop this cone                                         |
| <kbd>r</kbd>                 | Archived chats (with <kbd>1</kbd>–<kbd>9</kbd>: restore that one) |
| <kbd>s</kbd>                 | Stop the running turn                                             |
| <kbd>a</kbd>                 | Go to the pending approval                                        |
| <kbd>u</kbd>                 | Attach a file or skill                                            |
| <kbd>v</kbd>                 | Dictate — press again to send                                     |
| <kbd>y</kbd> / <kbd>Y</kbd>  | Copy the last reply / the whole chat                              |
| <kbd>j</kbd> / <kbd>k</kbd>  | Next / previous message — or entry, inside an open list           |
| <kbd>f</kbd>                 | File browser (with <kbd>1</kbd>–<kbd>9</kbd>: open that row)      |
| <kbd>t</kbd>                 | Terminal                                                          |
| <kbd>b</kbd>                 | Browser tabs (then 1–9 to switch)                                 |
| <kbd>p</kbd>                 | Peek a tab (then 1–9: show it and come back)                      |
| <kbd>m</kbd>                 | Memory (with <kbd>1</kbd>–<kbd>9</kbd>: open that entry)          |
| <kbd>g</kbd>                 | Monitor                                                           |
| <kbd>e</kbd>                 | Sprinkles (with <kbd>1</kbd>–<kbd>9</kbd>: open that one)         |
| <kbd>[</kbd> / <kbd>]</kbd>  | Toggle the left rail / the right panel                            |
| <kbd>z</kbd>                 | Full screen the open panel                                        |
| <kbd>l</kbd>                 | Model picker                                                      |
| <kbd>,</kbd>                 | Accounts                                                          |

**Chords.** Anything that owns a list takes a digit straight after it, and the digit picks from THAT list instead of the tab strip: <kbd>f</kbd> <kbd>3</kbd> is the third file, <kbd>r</kbd> <kbd>1</kbd> is the chat you archived most recently, <kbd>p</kbd> <kbd>2</kbd> is the second sprinkle. <kbd>9</kbd> is always the last one, exactly as it is for agents. The first key acts immediately, so <kbd>f</kbd> on its own is still just "open the files panel", and a digit pressed on its own is still an agent.

**Tabs.** <kbd>b</kbd> opens the tab switcher, and its cards are numbered: press <kbd>1</kbd>–<kbd>9</kbd> to switch to one (<kbd>9</kbd> is always the last). <kbd>p</kbd> opens it ready to **peek** instead — so <kbd>p</kbd> <kbd>1</kbd> shows you that tab and brings you back five seconds later, without you losing your place. <kbd>p</kbd> also arms peek from inside the switcher if you are already looking at it; the chip in the header says so, it applies to a click too, and closing the switcher disarms it.

<kbd>j</kbd> and <kbd>k</kbd> walk the same lists, looping — <kbd>p</kbd> <kbd>j</kbd> <kbd>j</kbd> steps through your sprinkles, <kbd>f</kbd> <kbd>k</kbd> jumps straight to the last file — and with no list open they walk the conversation a message at a time instead. A list stays addressable for exactly as long as its keys are still showing on the pill, and every digit or step key keeps both alive, so a walk down a long list never expires under you.

Every key you press shows up as a cap on the pill — dimmed if it was not bound to anything, so a mistyped key reads as "that did nothing" rather than as a dead keyboard. The strip clears after a moment of quiet.

Keys that navigate, or toggle chrome (digits, the arrows, <kbd>j</kbd>, <kbd>k</kbd>, <kbd>[</kbd>, <kbd>]</kbd>, <kbd>s</kbd>, <kbd>v</kbd>, <kbd>z</kbd>, help), keep the mode on; anything that hands focus to a surface leaves it, whether that is a shortcut, a click, or a panel that opens with a field ready. Inside a text field nothing is intercepted at all, and a focused button keeps its own <kbd>⏎</kbd> and <kbd>Space</kbd>. The overlay is also in the avatar menu, under **Keyboard mode**.

**Switching agents keeps your place.** The mode you were in when you left a cone is the mode you land back in: leave it typing and the caret is waiting in the new cone's composer, leave it in keyboard mode and the pill is still up. A scoop's transcript is read-only and has no composer at all, so it always puts you in keyboard mode — but it does not overwrite what you left behind, so cone → scoop → cone gives your caret back.

**Rebinding.** The keys live in `/etc/slicc/keys.json` in the VFS — edit it and reload the tab. It ships EMPTY: the keymap above lives in SLICC itself and the file holds only your overrides, so anything you do not mention follows the shipped map, including keys a later version adds. Each entry maps a key to a command (`"q": "terminal"`) and several keys can share one; `null` removes a binding. The file lists every command it accepts, and a chord follows its command — rebind `files` to <kbd>q</kbd> and <kbd>q</kbd> <kbd>3</kbd> is the third file. <kbd>Esc</kbd> and the digits are reserved. A bad line is skipped with a warning rather than costing you the rest of the file, and the help overlay always shows what is actually bound.

> **Upgrading from 6.110 or earlier?** That version wrote its whole keymap into `/etc/slicc/keys.json`, which would have pinned you to it forever. If you never edited the file, SLICC replaces it once with the empty one so the map above reaches you; if you did edit it, your file is left exactly as it is. To keep the old keys, the file's comment carries them as a block you can paste back into `"bindings"`.

## API Keys and Providers

To use SLICC, you need an LLM provider. SLICC is very much a BYOT (bring your own tokens) affair. We have built-in support for many providers, and these have actually been tested.

- Adobe (for AEM customers. Talk to the team to get enabled)
- AWS Bedrock (because enterprise)
- AWS Bedrock CAMP (this is Adobe-internal. Did I say "because enterprise" already?)
- Anthropic

The other providers are in YMMV territory. Please file an issue if you find them working or broken.

## Secrets

SLICC can safely manage API keys, tokens, and credentials with domain-scoped injection. The agent never sees real secret values — only masked placeholders — and secrets are only injected into requests destined for authorized domains. This protects against prompt-injection attacks that try to exfiltrate credentials.

See [docs/secrets.md](docs/secrets.md) for setup instructions.

## Related projects and lineage

SLICC is part of the [AI Ecoverse](https://github.com/ai-ecoverse), a growing set of AI-native tools and workflows. Its distinctive angle is simple: browser-native, practical, and job-oriented.

- [yolo](https://github.com/ai-ecoverse/yolo) — worktree-friendly CLI launcher for AI agent workflows
- [upskill](https://github.com/ai-ecoverse/upskill) — installs reusable agent skills from other repositories (and built-in in SLICC)
- [ai-aligned-git](https://github.com/ai-ecoverse/ai-aligned-git) and [ai-aligned-gh](https://github.com/ai-ecoverse/ai-aligned-gh) — guardrails and attribution helpers for AI-assisted Git/GitHub work

SLICC would not have been possible without the pioneering inspiration of [OpenClaw](https://github.com/openclaw/openclaw), [NanoClaw](https://github.com/qwibitai/nanoclaw), and [Pi](https://github.com/earendil-works/pi-mono). Pi is actually the frozen heart of every SLICC instance.

## Development and deeper docs

If you want to go deeper, the detailed docs live here:

- [Development guide](docs/development.md)
- [Architecture](docs/architecture.md)
- [Testing](.agents/skills/writing-slicc-tests/SKILL.md)
- [Shell reference](docs/shell-reference.md)
- [Secrets](docs/secrets.md)
- [Mounts (local + S3 / R2 / DA)](docs/mounts.md)
- [Transcript export](docs/transcript-export.md)
- [Adding features](.agents/skills/adding-slicc-features/SKILL.md)
- [Electron notes](docs/electron.md)
