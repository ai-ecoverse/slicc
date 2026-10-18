/**
 * `export-profile` — write this SLICC 6 profile as `slicc-profile` v1 zip(s)
 * to Downloads, for `freezer import` in SLICC 7 (seven.sliccy.ai).
 *
 *   export-profile [--dry-run]
 *
 * The export runs in the leader page, the only realm that sees every store a
 * profile lives in: directly when this shell is the page's, over panel RPC
 * (`profile-export`) from the kernel worker. Same zip and the same two notes
 * as Settings → Export for SLICC 7: the providers to re-enter, and the
 * credential-like files the zip holds in the clear.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import {
  getProfileExportRunner,
  type ProfileExportRunResult,
} from '../../transcript/profile-export-provider.js';
import { isHelpRequest } from './subcommand-help.js';

export const EXPORT_PROFILE_HELP = `usage: export-profile [--dry-run]

Save this SLICC 6 profile as slicc6-profile-<date>.zip in Downloads, to import
in SLICC 7 (https://seven.sliccy.ai) with Freezer → Import from SLICC 6, or
\`freezer import <zip>\`.

The zip holds every cone (transcript, workspace files, memory, scoops), frozen
chats, /home/user, user skills and sprinkles, and licks. Text is redacted.
Provider API keys and logins are NOT exported: you enter them again in SLICC 7's
Settings, and the report lists which. Credential-like files (.env*, *.pem,
.git-credentials, .npmrc, .slicc/oauth/*) are included as-is and listed.
secrets.env, the GitHub token, MCP tokens and /mnt mounts never move.

A profile over 2 GiB or 60,000 files is split into one zip per cone.

  --dry-run   plan and print the report without saving anything
  -h, --help  show this help
`;

/** Long enough for a multi-GiB profile: the page reads, redacts and spools it all. */
const EXPORT_TIMEOUT_MS = 60 * 60 * 1000;

async function run(dryRun: boolean): Promise<ProfileExportRunResult> {
  const local = getProfileExportRunner();
  if (local) return local({ dryRun });
  const rpc = getPanelRpcClient();
  if (!rpc) {
    throw new Error('the export runs in the SLICC leader tab, and none is connected');
  }
  return rpc.call('profile-export', { dryRun }, { timeoutMs: EXPORT_TIMEOUT_MS });
}

export function createExportProfileCommand(): Command {
  return defineCommand('export-profile', async (args) => {
    if (isHelpRequest(args)) return { stdout: EXPORT_PROFILE_HELP, stderr: '', exitCode: 0 };
    let dryRun = false;
    for (const arg of args) {
      if (arg === '--dry-run' || arg === '-n') dryRun = true;
      else {
        return {
          stdout: '',
          stderr: `export-profile: unknown argument ${JSON.stringify(arg)}\n${EXPORT_PROFILE_HELP}`,
          exitCode: 2,
        };
      }
    }
    try {
      const { report } = await run(dryRun);
      return { stdout: report, stderr: '', exitCode: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `export-profile: ${message}\n`, exitCode: 1 };
    }
  });
}
