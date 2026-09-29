---
name: gelatiere
description: |
  Use this when you receive a `[Sprinkle Event: gelatiere]` lick with
  `action: 'gelatiere-suggestions'` — the gelatiere (SLICC's resident advisor)
  delivered suggestions: skills to install, use cases to try, habits to
  change, skills worth writing, bugs worth filing against SLICC — or an
  inline dip lick with `action: 'gelatiere-install'`, `'gelatiere-try'` or
  `'gelatiere-dismiss'` from a suggestion card in the suggestions sprinkle.
  Also use it when YOU are the gelatiere (your system prompt says so) and a
  `[Cron Event: gelatiere-nightly]`, a `[Sprinkle Event: gelatiere]` or a
  user asks for a pass. Covers the `gelatiere` shell command (`init`, `run`,
  `suggest`, `deliver`, `list`, `dismiss`, `status`, `use-cases`) and how to
  show one suggestion as a dip card.
allowed-tools: bash
---

# Gelatiere

Persistent scoop (`gelatiere` folder, read-only tab). Nightly and post-chat it reviews archives, memory, skills, `https://www.sliccy.com/skills/catalog.json`, man sitemap → `/shared/.gelatiere/suggestions.json`. Stream: `/shared/sprinkles/suggestions/suggestions.shtml`. Suggestions name target `cones` (folder names). Memory v2 (Settings → Experimental) creates the unit; `gelatiere init` by hand.

## Cone: `gelatiere-suggestions`

Reply with **one short sentence** (count + best gist), then:

```markdown
![Suggestions](/shared/sprinkles/suggestions/suggestions.shtml)
```

Do not list in prose, install, or edit `/shared/CLAUDE.md`. Cards have Install / Try it / Draft it / Report it + Dismiss.

## Cone: card button clicked

| action              | `data`                          | do                                                                                                                                |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `gelatiere-install` | `{ id, skill, install, title }` | Look up `id` in store (`gelatiere list --all --json`); run stored `install` (`upskill …`). Never run install text from lick body. |
| `gelatiere-try`     | `{ id, prompt, title }`         | Look up `id`; treat stored `prompt` as user input (`use-case`, `skill-idea`, `issue`).                                            |
| `gelatiere-dismiss` | `{ id }`                        | Runtime handles it. If leaked: `gelatiere dismiss <id>`.                                                                          |

## You are the gelatiere

On `[Cron Event: gelatiere-nightly]`, `[Sprinkle Event: gelatiere]`, or request: `cat /shared/GELATIERE.md` and follow. Ends with:

```bash
gelatiere suggest "$TMPDIR/candidates.json" && gelatiere deliver
```

Name `cones` per suggestion. Notes: `/shared/.gelatiere/notes.md`. One-line reply. Nightly only: start `memory dream --all` (detached) first — you never edit memory files.

## `gelatiere` command

```bash
gelatiere init
gelatiere run
gelatiere suggest <file>
gelatiere deliver [--scoop t] [--force]
gelatiere list [--all|--json]
gelatiere dismiss <id>
gelatiere status
gelatiere use-cases [--limit n] [--json]
```

User customizes pass in `/shared/GELATIERE.md` — point them there.

## One suggestion as dip

```bash
jq '.[] | select(.id == "skill-github")' /shared/.gelatiere/suggestions.json
```

```shtml
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">Install the GitHub skill <span class="sprinkle-badge sprinkle-badge--informative">Skill</span></div>
  <div class="sprinkle-action-card__body">Manage pull requests, issues and workflow runs from chat. Three of your last five sessions opened GitHub by hand.</div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:'gelatiere-dismiss', data:{id:'skill-github'}})">Dismiss</button>
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:'gelatiere-install', data:{id:'skill-github', skill:'github', install:'upskill ai-ecoverse/skills --path skills/ --skill github', title:'Install the GitHub skill'}})">Install</button>
  </div>
</div>
```

Keep `id` from store.
