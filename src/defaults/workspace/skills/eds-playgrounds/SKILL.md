---
name: eds-playgrounds
description: Handle lick events from EDS audit playgrounds (SEO, accessibility, content, performance) — delegate to scoops that analyze pages via DA commands and push results back
allowed-tools: bash
---

# EDS Audit Playgrounds

Handles lick events from full-tab playground UIs that audit AEM Edge Delivery Services sites. Each audit playground is a thin HTML shell — all analysis is performed by a dedicated scoop using the `da` shell command and LLM intelligence.

## When This Skill Applies

When you receive a sprinkle/playground lick event from any of these paths:
- `/shared/seo-audit.html` — SEO analysis
- `/shared/accessibility-audit.html` — Accessibility analysis (future)
- `/shared/content-audit.html` — Content quality analysis (future)
- `/shared/performance-audit.html` — Performance analysis (future)

## Lick Event Format

Events arrive as:
```
[Sprinkle Event: playground:/shared/seo-audit.html:abc123]
```json
{"action": "run-audit", "data": {"path": "/tavex", "org": "paolomoz", "repo": "az-sitebuilder", "ref": "main"}}
```
```

The playground ID after the path (`:abc123`) is a random suffix — use the full `playground:/shared/seo-audit.html` prefix when sending updates back.

## Cone Orchestration

**Rule: One scoop per playground instance, named after the audit type.**

When a lick arrives from an audit playground:

1. Extract the playground name from the event (e.g. `playground:/shared/seo-audit.html:abc123`)
2. Check if a scoop already exists for this audit type (e.g. `seo-audit`)
3. If not, create one: `scoop_scoop("seo-audit")`
4. Forward the full lick payload to the scoop via `feed_scoop`

The scoop name should be the audit type (`seo-audit`, `a11y-audit`, `content-audit`, `perf-audit`), NOT the full playground ID. One scoop handles all instances of that audit type.

### Creating the SEO audit scoop

```
scoop_scoop("seo-audit")
feed_scoop("seo-audit", "You own the playground 'seo-audit'. Read /workspace/skills/eds-playgrounds/seo-audit-brief.md for your full instructions.

A lick event just arrived:
Action: run-audit
Data: {\"path\": \"/tavex\", \"org\": \"paolomoz\", \"repo\": \"az-sitebuilder\", \"ref\": \"main\"}

The playground ID for sending updates is: playground:/shared/seo-audit.html

Execute the audit now. Stay ready for follow-up lick events (fix-issue, fix-all).")
```

### Forwarding subsequent licks

```
feed_scoop("seo-audit", "Lick event on YOUR playground (playground:/shared/seo-audit.html):
Action: fix-issue
Data: {\"path\": \"/tavex/dosing\", \"issueId\": \"missing-meta-description\", \"fixAction\": \"add-meta-description\"}

Handle this fix request. Stay ready for more.")
```

## Update Protocol (scoop → playground)

The scoop sends structured JSON updates back to the playground UI via `sprinkle send`. All updates MUST include an `action` field.

### Progress updates
```bash
sprinkle send playground:/shared/seo-audit.html '{"action":"audit-progress","message":"Analyzing page 2 of 5...","current":2,"total":5}'
```

### Results
```bash
sprinkle send playground:/shared/seo-audit.html '{"action":"audit-results","summary":{"overallScore":72,"errors":3,"warnings":5,"total":4},"pages":[{"path":"/tavex/dosing","title":"Dosing Guide","issues":[{"id":"missing-meta-description","severity":"error","description":"Missing meta description","suggestion":"Add a <meta name=\"description\"> tag with 150-160 chars summarizing the page","fixable":true,"fixAction":"add-meta-description"},{"id":"short-title","severity":"warning","description":"Title tag is too short (12 chars, recommended 30-60)","suggestion":"Expand the title to include the primary keyword and brand","fixable":true,"fixAction":"expand-title"}]}]}'
```

### Fix progress
```bash
sprinkle send playground:/shared/seo-audit.html '{"action":"fix-progress","path":"/tavex/dosing","issueId":"missing-meta-description"}'
```

### Fix complete
```bash
sprinkle send playground:/shared/seo-audit.html '{"action":"fix-complete","path":"/tavex/dosing","issueId":"missing-meta-description"}'
```

### Fix all complete
```bash
sprinkle send playground:/shared/seo-audit.html '{"action":"fix-all-complete","fixed":[{"path":"/tavex/dosing","issueId":"missing-meta-description"},{"path":"/tavex/dosing","issueId":"short-title"}]}'
```

### Error
```bash
sprinkle send playground:/shared/seo-audit.html '{"action":"error","message":"Failed to fetch page: 404"}'
```

## Issue Schema

Each issue in the results MUST have:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique ID within the page (e.g. `missing-meta-description`, `no-h1`) |
| `severity` | `"error"` \| `"warning"` \| `"info"` | yes | Severity level |
| `description` | string | yes | Human-readable description of the issue |
| `suggestion` | string | no | Specific suggestion for how to fix it |
| `fixable` | boolean | no | Whether the agent can auto-fix this issue |
| `fixAction` | string | if fixable | Machine-readable action name for the fix |
| `fixed` | boolean | no | Set to true after the fix is applied |

## Fix Actions

When `fixable: true`, the `fixAction` tells the scoop what to do. Common fix actions for SEO:

| fixAction | What the scoop does |
|-----------|-------------------|
| `add-meta-description` | Generate and insert a `<meta name="description">` tag |
| `expand-title` | Rewrite the `<title>` tag to be more descriptive |
| `add-h1` | Add or fix the H1 heading |
| `fix-heading-hierarchy` | Restructure heading levels to be sequential |
| `add-alt-text` | Generate alt text for images missing it |
| `add-canonical` | Add a canonical URL link tag |
| `fix-link-text` | Replace generic link text ("click here") with descriptive text |

The scoop uses `da get` to fetch the page, modifies the HTML, `da put` to save it, and `da preview` to trigger a preview rebuild.
