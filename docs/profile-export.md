# Moving to SLICC 7 (`slicc-profile` v1 and v2)

SLICC 6 exports a whole profile for SLICC 7 (seven.sliccy.ai). SLICC 7's `freezer import` (Freezer → **Import from SLICC 6…**) reads the export. Each six cone becomes a frozen seven cone. The design and its decisions G1–G8 are in slicc-agent#6.

There are two versions of the format. Version 1 is the zip that Export for SLICC 7 saves. Version 2 is the [directory form](#version-2-the-directory-form): on www.sliccy.ai, where seven runs on six's origin, six writes it to OPFS, and files stay where they are (ai-ecoverse/slicc-bios#648).

## Entry points

- **Settings → Export for SLICC 7…** (the account settings dialog), and the banner's **Export your profile** button. Both open the same dialog.
  1. The dialog reads and redacts the profile and hashes each entry. Nothing is written yet.
  2. It then shows two notes: "Your API keys and logins don't move. You'll enter them again in SLICC 7's Settings", with the providers to set up again, and a warning listing every credential-like file the zip holds in the clear.
  3. **Export** saves the zip(s) to Downloads.
- **`export-profile [--dry-run]`** opens the same dialog in the leader tab and saves only once the user confirms there, then prints the same notes, so neither an agent nor a scoop can write the profile to Downloads unattended. In the kernel worker it reaches the leader page over the `profile-export` panel-RPC op. `--dry-run` plans the export and prints the report without opening the dialog or saving.
- **The banner** "SLICC 7 is at seven.sliccy.ai." sits between the nav and the shell in the leader tab. Dismissing it is remembered per origin (`slicc-seven-banner-dismissed`).

Every storage origin (`www.sliccy.ai`, `localhost:5710`, the extension) is its own profile, so you export once per origin. On `www.sliccy.ai`, seven can instead move the profile in place (ai-ecoverse/slicc-bios#648). Once it has, it sets `localStorage['slicc-os.six'] = 'upgraded'`, and six's page on www replaces itself with `/os/` from every route, before it registers or unregisters any service worker (`ui/boot/six-step-aside.ts`). The export runs in the leader page because only that page can see every store a profile lives in: the kernel VFS, `slicc-groups`, `slicc_accounts`, the global VFS and the mount table.

## Code

| Piece                                       | Where                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Format types, validator, flag rules, limits | `packages/shared-ts/src/profile-export.ts`                                   |
| Collector, planner, archive writer          | `packages/webapp/src/transcript/profile-export.ts`                           |
| Page-secret redactor and text redaction     | `packages/webapp/src/transcript/profile-redact.ts`                           |
| Page wiring (stores)                        | `packages/webapp/src/ui/profile-export-deps.ts`                              |
| Dialog, headless run, report                | `packages/webapp/src/ui/wc/wc-profile-export.ts`                             |
| Banner                                      | `packages/webapp/src/ui/wc/wc-seven-banner.ts`                               |
| Shell command                               | `packages/webapp/src/shell/supplemental-commands/export-profile-command.ts`  |
| Directory form (v2) planner                 | `planProfileDirectory` in `packages/webapp/src/transcript/profile-export.ts` |
| Directory writer (OPFS)                     | `packages/webapp/src/transcript/profile-directory-opfs.ts`                   |
| In-place exporter page                      | `packages/webapp/src/ui/upgrade-to-seven/`, `upgrade-to-seven.html`          |
| Six's stop for the upgrade                  | `packages/webapp/src/ui/six-upgrade-stop.ts`                                 |

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

- **MCP URLs** keep only their origin and path. Userinfo, the query and the fragment are dropped, and their values are redacted wherever else they appear.
- **Manifest labels** (cone and scoop names, frozen titles) pass the redactor too.
- **Never exported:**
  - provider API keys and OAuth tokens (`slicc_accounts`);
  - `secrets.env` and extension secrets;
  - the GitHub token, MCP tokens and headers;
  - mount handles.
- **Redacted wherever they occur:** `literalSecretsRedactor` replaces each account key and token, the GitHub token and MCP header values with `⟦REDACTED:provider-credential:psN⟧`. It runs before six's fail-closed known-secret redactor, so the replacement applies to transcripts too.
- **Text redaction:** every UTF-8 text file passes the known-secret redactor and the at-rest credential patterns (jwt, private-key, bearer-token, api-key), in 1 MiB batches; a file over 1 MiB is split after newlines so no secret straddles two batches. So do memory, `licks.json` and the gitconfig. Transcripts pass the full transcript redaction.
- **Binary files** are stored as-is, unless they contain a page-known secret verbatim; those are skipped (`secret`).
- **Credential-like files are stored byte for byte and listed in `flagged[]`.** These are `.env` and `.env.*` (`env`), `*.pem` (`pem`), `.git-credentials`, `.npmrc`, and anything under `.slicc/oauth/` (`slicc-oauth`). The dialog and the report warn that the zip holds them in the clear.

## Limits and parts

One archive holds at most 2 GiB and 60,000 entries, with the exact size computed from names and sizes. When the profile is bigger, the export writes one zip per cone plus a profile part. The profile part holds the frozen sessions, home-user, the global memory, skills, sprinkles, licks and the gitconfig. Each part is self-contained and carries its own attachments. If a single cone doesn't fit, the export fails with a message that names the cone.

The plan keeps redacted bytes in memory only where redaction changed them. Every other file is re-read when the archive is written, and its hash must still match the manifest. Otherwise the export fails with "changed while exporting".

## Version 2: the directory form

On `www.sliccy.ai`, seven runs next to six (`/7/`, then `/`) and shares six's origin, so its kernel's root is the OPFS root six uses. Six's kernel VFS is already inside seven's file system, at `/slicc-fs/`: ZenFS's `WebAccess` backend keeps each VFS file at the same path under OPFS `slicc-fs/` (`/workspace/notes.md` is `slicc-fs/workspace/notes.md`). Its modes and symlinks live only in the `.metadata.json` sidecar. That is why version 2 moves files instead of copying them: the upgrade needs no export and no re-import, and no second copy of a workspace (ai-ecoverse/slicc-bios#648, the exporter in slicc#4051, seven's import in ai-ecoverse/slicc-agent#487).

- **Where it lives:** a directory, not a zip: `/slicc-v6-upgrade/<exportId>/` (`PROFILE_DIRECTORY_ROOT`), in OPFS and in seven's kernel. It sits outside `/slicc-fs`.
- **What's in it:** the same entry names as the zip, `manifest.json` included, as plain files. `version` is `2`.
- **Files left in place:** a `files[]` row whose file six can leave where it is isn't written to the directory. Instead it carries `source`, the file's path in seven's kernel:

  ```json
  {
    "path": "files/cones/cone/notes.md",
    "size": 912,
    "sha256": "…",
    "source": "/slicc-fs/workspace/notes.md"
  }
  ```

  `path` keeps its meaning: it's the entry the manifest's references, `flagged[]` and seven's placement use. `size` and `sha256` are the file's, as six read it, and seven checks both after the move.

- **What stays in place:** files under `files/`, `skills/` and `sprinkles/` whose bytes redaction left unchanged, flagged credential-like files included.
- **What's written:** transcripts, frozen sessions, attachments, memory, `licks.json`, `git/gitconfig`, and every file redaction changed.
- **What's left out:** symlinks and empty directories, which the walk skips in both versions.
- **Validation:** `validateSliccProfileManifestV2` checks everything version 1 does, plus:
  - each `source` is a safe absolute path under `/slicc-fs/` (`isSafeProfileSourcePath`), never the sidecar;
  - a `source` sits only on `files/`, `skills/` or `sprinkles/` entries;
  - no file is moved twice;
  - there's no `part`, because nothing is split;
  - no skip has the reason `archive-limit`.

  Version 1 refuses a `source`. `validateSliccProfileManifest` picks the validator by `version`.

- **Limits:** the zip's limits (ZIP32, 2 GiB and 60,000 entries per archive, parts, `archive-limit`) don't apply. The 256 MiB file limit and the redaction rules do.
- **After the import:** seven deletes `/slicc-v6-upgrade/<exportId>/` once the import succeeded. When it fails, the moved files go back to their `source` paths, and the directory stays for the next try. What six leaves in `/slicc-fs` (caches, mounts, bundled files, `skipped[]`) is removed by seven's BIOS later.
- **The exporter:** `/upgrade-to-seven.html` writes this form (slicc#4051). See [the in-place exporter](#the-in-place-exporter).

### The in-place exporter

Seven's BIOS at `www.sliccy.ai/7/` runs `/upgrade-to-seven.html` in a hidden frame. The page does nothing unless every ancestor is on its own origin, and the worker serves it with `frame-ancestors 'self'`. It carries `<meta name="slicc-six-upgrade" content="1">`, so seven can check it's really this page and not the SPA fallback before framing it. It registers no service worker and boots no kernel. It opens six's stores itself: the `slicc-fs` VFS, `slicc-groups`, the conversation store, `slicc_accounts`, the global VFS and the mount table.

1. **Six stops.** Every six page holds the Web Lock `slicc-six-kernel` in `shared` mode from boot until it has stopped. The exporter posts `{ type: 'stop' }` on `BroadcastChannel('slicc-six-upgrade')`, again every 2 s while it waits. Each page then terminates its kernel worker, which takes the Python realm and the process workers with it. It stops its leader tray, shows _SLICC moved to seven in this browser_ with a link to `/os/`, and releases the lock. The exporter takes the lock `exclusive` and keeps it until its frame goes away. A six page that boots meanwhile can't get the lock, so it shows the same notice and registers no service worker. If some page still holds the lock after 30 s, the export fails.
2. **It plans** the directory form (`planProfileDirectory`), with the same collection, skip and redaction rules as the zip.
3. **It writes** every entry without a `source` to `/slicc-v6-upgrade/<exportId>/`, and `manifest.json` last.

It reports to its parent with `postMessage`, using `location.origin` as the target origin, never `*`:

- `{ type: 'slicc-six-upgrade', phase, done, total }`, where `phase` is `stopping`, `reading` or `writing`;
- `{ type: 'slicc-six-upgrade', done: true, exportId, dir }` when it finishes;
- `{ type: 'slicc-six-upgrade', error }` when it fails.

**Redaction in the frame:** the frame can't reach six's known-secret redactor (there's no node-server bridge and no extension id), so `secrets.env` and extension-secret values aren't replaced. Everything else still applies: the page-known secrets (`slicc_accounts` keys and tokens, the GitHub token, MCP headers and URL secrets) and the at-rest credential patterns. `secrets[]` doesn't list `secrets-env` or `chrome-storage`. Nothing leaves the origin: the directory sits next to `slicc-fs/`, where the same texts already are.

## Fixture

`packages/webapp/tests/fixtures/slicc6-profile-v1.zip` is the shared contract fixture. The same file is checked into ai-ecoverse/slicc-agent at `test/integration/fixtures/`, where seven's import tests read it. `tests/transcript/profile-export-fixture.test.ts` checks two things:

- the fixture passes `validateSliccProfileManifestV1` and the transcript validator, and its `files[]` hashes match;
- the exporter's output for the seeded profile has the same entry layout and manifest keys.
