# Architecture Diagrams

## Diagram 1 — Floats & Tray Topology

How the runtime environments ("floats") connect: leaders own the cone, followers
lend a browser target, all coordinated by the Cloudflare worker (signaling +
TURN credentials) and relayed over WebRTC (with `CF TURN` as fallback relay).

```mermaid
flowchart TB
    subgraph cloud["☁️ sliccy.ai — Cloudflare"]
        WORKER["CF Worker<br/><i>tray hub: session coordination,<br/>signaling, TURN credentials</i>"]
        TURN["CF TURN<br/><i>WebRTC relay fallback</i>"]
    end

    subgraph e2b["E2B.dev — hosted-leader (cloud) sandbox"]
        direction LR
        CHROME["Chrome<br/>(headless)"]
        LEADER["SLICC<br/><b>Leader</b> (cone)"]
        NODE["node-server<br/>--hosted"]
        CHROME --- LEADER
        LEADER -- "WS" --> NODE
    end

    subgraph local["Local float (CLI / extension / Electron)"]
        direction LR
        FOLLOWER["SLICC<br/><b>Follower</b>"]
        SWIFTL["Swift<br/>(slicc-server)"]
        FOLLOWER --- SWIFTL
    end

    subgraph ios["iOS device"]
        IOSAPP["SliccFollower<br/>(Swift) — <b>Follower</b>"]
    end

    subgraph cherrybox["Third-party host page"]
        FRAME["Host page<br/>(FRAME)"]
        CHERRY["SLICC <i>?cherry=1</i><br/><b>Follower</b><br/>synthetic CDP (CE) · postMessage (PM)"]
        FRAME --- CHERRY
    end

    %% Signaling / coordination (control plane)
    LEADER -. "signaling / tray join" .-> WORKER
    FOLLOWER -. "signaling" .-> WORKER
    IOSAPP -. "signaling" .-> WORKER
    CHERRY -. "signaling" .-> WORKER

    %% Media / data plane (WebRTC, TURN-relayed when needed)
    IOSAPP == "WebRTC" ==> LEADER
    FOLLOWER == "WebRTC" ==> LEADER
    CHERRY == "WebRTC" ==> LEADER
    LEADER -. "relay" .-> TURN
```

**Legend**

- **Leader** — owns the cone (the main agent). The hosted-leader float runs the
  whole webapp + headless Chrome + `node-server --hosted` inside an E2B.dev
  sandbox.
- **Follower** — lends its browser to a leader as a CDP target. Followers shown:
  a local float, the native **iOS** app (`SliccFollower`), and **Cherry** (the
  webapp embedded in a third-party page's iframe via `?cherry=1`, exposing a
  capability-limited **synthetic CDP** target over postMessage).
- **Solid double arrows** = WebRTC media/data plane. **Dotted arrows** = control
  plane (signaling, tray join) through the Cloudflare worker; `CF TURN` is the
  relay fallback when a direct peer connection can't be established.

---

## Diagram 2 — Layer Stack (webapp internals)

How a turn flows through the webapp, from the shell at the bottom up to the
cone/scoops orchestrator. Supplemental shell commands sit on top of `$bash`;
external events ("licks") feed the core agent; secrets are injected on the way.

```mermaid
flowchart BT
    subgraph shell["Shell — AlmostBashShell (just-bash)"]
        BASH["$bash"]
        CMDS["supplemental commands:<br/>node · npm · npx · python3 · sqlite3<br/>ffmpeg · convert (imagemagick) · esbuild · tsc<br/>git · upskill · webhook · crontask · workflow<br/>(WASM where needed)"]
        BASH --- CMDS
    end

    VFS["VirtualFS / RestrictedFS<br/><i>(rFS — OPFS-backed, path ACLs per scoop)</i>"]
    CDP["CDP<br/><i>(BrowserAPI over CDPTransport)</i>"]
    TOOLS["Tools<br/><i>(read_file · write_file · edit_file · bash)</i>"]

    CORE["Core Agent (LLM)<br/><i>pi-agent-core loop · pi-ai streaming</i>"]
    LICKS(["Licks<br/><i>webhooks · cron · workflows</i>"])

    subgraph orch["Scoops Orchestrator"]
        CONE["Cone<br/><i>(main agent)</i>"]
        SCOOPS["Scoops<br/><i>(isolated sub-agents)</i>"]
        CONE == "feed_scoop / drop_scoop" ==> SCOOPS
    end

    UI["UI<br/><i>(chat · terminal · files · memory)</i>"]
    SECRETS[("Secrets<br/><i>masking pipeline</i>")]

    shell --> VFS --> CDP --> TOOLS --> CORE
    LICKS -- "events" --> CORE
    CORE --> orch
    SECRETS -. "injected / masked" .-> CORE
    orch --> UI
```

**Legend**

- Bottom-to-top flow mirrors the layer stack in
  [`docs/architecture.md`](architecture.md): **Shell → VirtualFS →
  CDP → Tools → Core Agent → Scoops Orchestrator → UI**.
- `rFS` on the whiteboard = `RestrictedFS` wrapping the OPFS-backed `VirtualFS`
  with per-scoop path ACLs.
- **Licks** are external triggers (webhooks, cron tasks, workflow completions)
  that drive the agent loop.
- **Secrets** flow through the `@slicc/shared-ts` masking pipeline so the agent
  never holds raw credentials in context.
