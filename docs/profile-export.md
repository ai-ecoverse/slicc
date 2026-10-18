# Moving to SLICC 7 (`slicc-profile` v1)

SLICC 6 exports a whole profile for SLICC 7 (seven.sliccy.ai). SLICC 7's `freezer import` (Freezer → **Import from SLICC 6…**) reads the export. Each six cone becomes a frozen seven cone. The design and its decisions G1–G8 are in slicc-agent#6.

## Entry points

- **Settings → Export for SLICC 7…** (the account settings dialog), and the banner's **Export your profile** button. Both open the same dialog.
  1. The dialog reads and redacts the profile and hashes each entry. Nothing is written yet.
  2. It then shows two notes: "Your API keys and logins don't move. You'll enter them again in SLICC 7's Settings", with the providers to set up again, and a warning listing every credential-like file the zip holds in the clear.
  3. **Export** saves the zip(s) to Downloads.
- **`export-profile [--dry-run]`** writes the same zip and prints the same notes. In the kernel worker it reaches the leader page over the `profile-export` panel-RPC op. `--dry-run` plans the export and prints the report without saving.
- **The banner** "SLICC 7 is at seven.sliccy.ai." sits between the nav and the shell in the leader tab. Dismissing it is remembered per origin (`slicc-seven-banner-dismissed`).

Every storage origin (`www.sliccy.ai`, `localhost:5710`, the extension) is its own profile, so you export once per origin. The export runs in the leader page because only that page can see every store a profile lives in: the kernel VFS, `slicc-groups`, `slicc_accounts`, the global VFS and the mount table.

## Code

| Piece                                       | Where                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Format types, validator, flag rules, limits | `packages/shared-ts/src/profile-export.ts`                                  |
| Collector, planner, archive writer          | `packages/webapp/src/transcript/profile-export.ts`                          |
| Page-secret redactor and text redaction     | `packages/webapp/src/transcript/profile-redact.ts`                          |
| Page wiring (stores)                        | `packages/webapp/src/ui/profile-export-deps.ts`                             |
| Dialog, headless run, report                | `packages/webapp/src/ui/wc/wc-profile-export.ts`                            |
| Banner                                      | `packages/webapp/src/ui/wc/wc-seven-banner.ts`                              |
| Shell command                               | `packages/webapp/src/shell/supplemental-commands/export-profile-command.ts` |

The export reuses the transcript pipeline:

- `DefaultTranscriptExportService.snapshotCone` collects one cone and its scoops through `collectActiveTranscriptSources` with `rootJid`;
- `snapshotFrozen` reads a stored snapshot or the legacy archive;
- `createZipStream` is the stored ZIP writer;
- `transcriptZipToBlob` spools the zip through OPFS.

## Archive

A stored ZIP (method 0) in ZIP32. Names are UTF-8. There are no directory entries, extra fields or external attributes. `manifest.json` is always the first entry.

```
manifest.json
transcripts/<coneFolder>.json   TranscriptDocumentV1: the cone plus its scoops
frozen/<safeId>.json            TranscriptDocumentV1 per /sessions entry
attachments/<sha256>            content-addressed, shared across transcripts
files/cones/<coneFolder>/...    the cone workspace (/workspace or /cones/<f>/workspace)
files/scoops/<scoopFolder>/...  /scoops/<f>/workspace
files/home-user/...             /home/user
memory/global.md                /shared/CLAUDE.md
memory/<coneFolder>.md          the cone's CLAUDE.md
skills/<name>/...               user skills from /workspace/skills
sprinkles/<name>/...            user sprinkles from /shared/sprinkles and /workspace/sprinkles
licks.json                      { crontasks, tasks, webhooks }: raw six records
git/gitconfig                   the [user] section of the global .gitconfig
```

Some routing rules:

- The primary cone's `skills/`, `sprinkles/` and `CLAUDE.md` go to `skills/`, `sprinkles/` and `memory/`. They are not duplicated under `files/`.
- Each `attachments[].path` in a transcript is rewritten to `attachments/<sha256>`.
- Each cron and webhook record in `licks.json` gains a `targetFolder`: the folder six's `lickScoopMatches` resolves its `scoop` field to, or `null` for the cone.
- `safeId` is the session id when it matches `[A-Za-z0-9._-]{1,128}`. Otherwise it is `s-<first 16 hex of sha256(id)>`.

### Manifest

`SliccProfileManifestV1` in `shared-ts` is the source of truth. Its fields:

- `format: "slicc-profile"`, `version: 1`, `exportId` (a UUID, shared by every part), `producer { slicc, origin }`, `createdAt`, and `part { index, of }` (only when the export is split);
- `cones[]`: `{ key, folder, name, transcript, conversation, files, memory, scoops[] }`. Each scoop is `{ key, folder, name, conversation, files }`:
  - `key` is six's conversation key (`<workspace>::<jid>`);
  - `conversation` is the `TranscriptConversation.id` inside that cone's transcript;
- `frozen[]` (`{ id, title, frozenAt, transcript }`), `skills[]` and `sprinkles[]` (`{ name, path }`), `licks` and `gitconfig` (paths, or null);
- `files[]`: `{ path, size, sha256 }`, one per entry except the manifest. The sha256 is the lowercase hex of the stored bytes;
- `skipped[]`: `{ path, reason }`. The reason is one of `mount`, `cache`, `bundled`, `secret`, `too-large`, `unreadable` or `archive-limit`;
- `flagged[]`: `{ path, size, rule }`, one per credential-like file;
- `providers[]`: provider ids only, without MCP OAuth providers. `mcp[]`: `{ name, url }`. `secrets[]`: what never moves (`secrets-env`, `chrome-storage`, `github-token`, `mcp-tokens`);
- `redactionCounts` (by category) and `totals`.

`validateSliccProfileManifestV1` checks the shape, the enums and the entry paths. It also checks that every path the manifest references names an entry in `files[]`.

## What is skipped

| Skipped                                                                                   | Why                                    |
| ----------------------------------------------------------------------------------------- | -------------------------------------- |
| Mount targets (the mount table; `/mnt` is never walked)                                   | Directory handles belong to one origin |
| `node_modules`, `.cache`, `__pycache__`, `.git/hooks`                                     | Caches. No hooks run in seven          |
| Files byte-identical to the bundled vfs-root copy, and whole bundled skills and sprinkles | Seven ships its own                    |
| `.git/github-token`, `.mcp/servers.json`                                                  | Secrets                                |
| Files over 256 MiB                                                                        | Seven refuses them                     |
| Unreadable files and frozen sessions                                                      | Recorded, and the export continues     |

## Secrets (G6, G8)

- **Never exported:**
  - provider API keys and OAuth tokens (`slicc_accounts`);
  - `secrets.env` and extension secrets;
  - the GitHub token, MCP tokens and headers;
  - mount handles.
- **Redacted wherever they occur:** `literalSecretsRedactor` replaces each account key and token, the GitHub token and MCP header values with `⟦REDACTED:provider-credential:psN⟧`. It runs before six's fail-closed known-secret redactor, so the replacement applies to transcripts too.
- **Text redaction:** every UTF-8 text file up to 1 MiB passes the known-secret redactor and the at-rest credential patterns (jwt, private-key, bearer-token, api-key). So do memory, `licks.json` and the gitconfig. Transcripts pass the full transcript redaction.
- **Credential-like files are stored byte for byte and listed in `flagged[]`.** These are `.env` and `.env.*` (`env`), `*.pem` (`pem`), `.git-credentials`, `.npmrc`, and anything under `.slicc/oauth/` (`slicc-oauth`). The dialog and the report warn that the zip holds them in the clear.

## Limits and parts

One archive holds at most 2 GiB and 60,000 entries, with the exact size computed from names and sizes. When the profile is bigger, the export writes one zip per cone plus a profile part. The profile part holds the frozen sessions, home-user, the global memory, skills, sprinkles, licks and the gitconfig. Each part is self-contained and carries its own attachments. If a single cone doesn't fit, the export fails with a message that names the cone.

The plan keeps redacted bytes in memory only where redaction changed them. Every other file is re-read when the archive is written, and its hash must still match the manifest. Otherwise the export fails with "changed while exporting".

## Fixture

`packages/webapp/tests/fixtures/slicc6-profile-v1.zip` is the shared contract fixture. The same file is checked into ai-ecoverse/slicc-agent at `test/integration/fixtures/`, where seven's import tests read it. `tests/transcript/profile-export-fixture.test.ts` checks two things:

- the fixture passes `validateSliccProfileManifestV1` and the transcript validator, and its `files[]` hashes match;
- the exporter's output for the seeded profile has the same entry layout and manifest keys.
