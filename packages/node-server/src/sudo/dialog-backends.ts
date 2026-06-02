/**
 * GUI + fail-closed native sudo backends for the node-server float.
 *
 * Each backend turns a {@link SudoApproveRequest} into a real OS gesture
 * (osascript / PowerShell / zenity / kdialog) and parses the result into a
 * {@link SudoDecision}. They are deliberately injectable via {@link ExecFn} so
 * tests can assert the argv and parsing without spawning a real dialog.
 *
 * Fail-closed contract: a dismissed dialog, a non-zero exit, an unparsable
 * result, or a thrown error all resolve to `deny`. An `always` result with an
 * empty pattern falls back to the suggested default.
 */

import { execFile as nodeExecFile } from 'child_process';
import { promisify } from 'util';
import type { SudoApproveRequest, SudoBackend, SudoDecision } from './types.js';

/** Minimal exec seam: run a binary with args, resolve its stdout. */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = promisify(nodeExecFile);

/** Human-readable one-liner describing the gated action. */
export function describeRequest(req: SudoApproveRequest): string {
  return `${req.kind}: ${req.detail}`;
}

function fallbackPattern(req: SudoApproveRequest): string {
  return req.suggestedPattern?.trim() || req.detail.trim();
}

/** macOS: single `osascript display dialog` with 3 buttons + a text field. */
export function createOsascriptBackend(exec: ExecFn = defaultExec): SudoBackend {
  return {
    name: 'osascript',
    async prompt(req: SudoApproveRequest): Promise<SudoDecision> {
      const suggested = fallbackPattern(req);
      const message = `SLICC sudo — approve ${describeRequest(req)}\n\nEdit pattern for "Always":`;
      const script =
        `display dialog ${q(message)} default answer ${q(suggested)} ` +
        `buttons {"Deny", "Allow Once", "Always"} default button "Allow Once" ` +
        `with title "SLICC sudo" with icon caution`;
      try {
        const { stdout } = await exec('osascript', ['-e', script]);
        const button = /button returned:([^,\n]*)/.exec(stdout)?.[1]?.trim() ?? '';
        const text = /text returned:([\s\S]*)$/.exec(stdout)?.[1]?.trim() ?? '';
        if (button === 'Allow Once') return { decision: 'allow' };
        if (button === 'Always') {
          return { decision: 'always', pattern: text.length > 0 ? text : suggested };
        }
        return { decision: 'deny' };
      } catch {
        return { decision: 'deny' };
      }
    },
  };
}

/** Windows: MessageBox (Yes/No/Cancel) + InputBox for the "Always" pattern. */
export function createPowerShellBackend(exec: ExecFn = defaultExec): SudoBackend {
  return {
    name: 'powershell',
    async prompt(req: SudoApproveRequest): Promise<SudoDecision> {
      const suggested = fallbackPattern(req);
      const msg = `SLICC sudo — approve ${describeRequest(req)}\n\nYes = Allow once   No = Deny   Cancel = Always`;
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms,Microsoft.VisualBasic;',
        `$r=[System.Windows.Forms.MessageBox]::Show(${ps(msg)},'SLICC sudo','YesNoCancel','Warning');`,
        "if($r -eq 'Yes'){Write-Output 'ALLOW'}",
        `elseif($r -eq 'Cancel'){Write-Output 'ALWAYS'; Write-Output ([Microsoft.VisualBasic.Interaction]::InputBox('Edit the Always pattern','SLICC sudo',${ps(suggested)}))}`,
        "else{Write-Output 'DENY'}",
      ].join('\n');
      try {
        const { stdout } = await exec('powershell', ['-NoProfile', '-Command', script]);
        const lines = stdout.split(/\r?\n/).map((l) => l.trim());
        const verb = lines.find((l) => l.length > 0) ?? '';
        if (verb === 'ALLOW') return { decision: 'allow' };
        if (verb === 'ALWAYS') {
          const pattern = lines[lines.indexOf('ALWAYS') + 1]?.trim();
          return {
            decision: 'always',
            pattern: pattern && pattern.length > 0 ? pattern : suggested,
          };
        }
        return { decision: 'deny' };
      } catch {
        return { decision: 'deny' };
      }
    },
  };
}

/** Linux GUI: `zenity --question` (+ `--entry` for the pattern). */
export function createZenityBackend(exec: ExecFn = defaultExec): SudoBackend {
  return {
    name: 'zenity',
    async prompt(req: SudoApproveRequest): Promise<SudoDecision> {
      const suggested = fallbackPattern(req);
      const text = `SLICC sudo — approve ${describeRequest(req)}`;
      let allowed = false;
      let always = false;
      try {
        const { stdout } = await exec('zenity', [
          '--question',
          '--title=SLICC sudo',
          `--text=${text}`,
          '--ok-label=Allow once',
          '--cancel-label=Deny',
          '--extra-button=Always',
        ]);
        always = stdout.trim() === 'Always';
        allowed = true;
      } catch (err) {
        // Non-zero exit: either Deny (no stdout) or the extra "Always" button.
        always = stdoutOf(err).trim() === 'Always';
        allowed = always;
      }
      if (!allowed) return { decision: 'deny' };
      if (!always) return { decision: 'allow' };
      return entryDecision(
        exec,
        'zenity',
        [
          '--entry',
          '--title=SLICC sudo',
          '--text=Edit the Always pattern',
          `--entry-text=${suggested}`,
        ],
        suggested
      );
    },
  };
}

/** Linux GUI: `kdialog --warningyesnocancel` (+ `--inputbox`). */
export function createKdialogBackend(exec: ExecFn = defaultExec): SudoBackend {
  return {
    name: 'kdialog',
    async prompt(req: SudoApproveRequest): Promise<SudoDecision> {
      const suggested = fallbackPattern(req);
      const text = `SLICC sudo — approve ${describeRequest(req)}\n\nYes = Allow once   No = Deny   Cancel = Always`;
      let code: number;
      try {
        await exec('kdialog', ['--warningyesnocancel', text, '--title', 'SLICC sudo']);
        code = 0; // Yes
      } catch (err) {
        code = exitCodeOf(err);
      }
      if (code === 0) return { decision: 'allow' };
      if (code !== 2) return { decision: 'deny' }; // 1 = No / dismissed
      return entryDecision(
        exec,
        'kdialog',
        ['--inputbox', 'Edit the Always pattern', suggested, '--title', 'SLICC sudo'],
        suggested
      );
    },
  };
}

/** A backend that always denies — used when no native channel exists. */
export function createDenyBackend(name = 'none'): SudoBackend {
  return {
    name,
    async prompt(): Promise<SudoDecision> {
      return { decision: 'deny' };
    },
  };
}

async function entryDecision(
  exec: ExecFn,
  cmd: string,
  args: string[],
  suggested: string
): Promise<SudoDecision> {
  try {
    const { stdout } = await exec(cmd, args);
    const pattern = stdout.trim();
    return { decision: 'always', pattern: pattern.length > 0 ? pattern : suggested };
  } catch {
    return { decision: 'always', pattern: suggested };
  }
}

function stdoutOf(err: unknown): string {
  const s = (err as { stdout?: unknown })?.stdout;
  return typeof s === 'string' ? s : '';
}

function exitCodeOf(err: unknown): number {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'number' ? c : 1;
}

/** Quote a string for AppleScript. */
function q(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Quote a string as a PowerShell single-quoted literal. */
function ps(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
