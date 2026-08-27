/**
 * In-page sudo approval dialog (`<slicc-dialog>`), issue #2062.
 *
 * Two callers share it:
 *  - the **leader page** when it has no native modal of its own (the hosted
 *    leader viewed directly in a browser tab) — registered via
 *    `setSudoPagePrompt`;
 *  - a **web follower** rendering a prompt the leader delegated to it
 *    (`onSudoApprovalRequest`).
 *
 * "Always" is offered only when `allowAlways` is set: the leader accepts it
 * solely from biometric-gated followers, and a web follower is not one, so
 * showing the button would be a lie. The pattern field is editable; an empty
 * edit keeps the suggestion (narrowest generalization) rather than widening.
 */

import type { SudoDecision, SudoRequest } from '../../sudo/types.js';

/** Human-readable heading per kind. */
const KIND_HEADING: Record<SudoRequest['kind'], string> = {
  command: 'Run command?',
  read: 'Allow read?',
  write: 'Allow write?',
  secret: 'Allow secret access?',
  export: 'Export transcript?',
  'guest-message': 'Send guest message to the cone?',
};

/** What the detail row is labelled per kind. */
const KIND_LABEL: Record<SudoRequest['kind'], string> = {
  command: 'Command',
  read: 'Path',
  write: 'Path',
  secret: 'Secret',
  export: 'Transcript',
  'guest-message': 'Message',
};

export interface SudoApprovalDialogOptions {
  /** Who is asking, when known (scoop label, follower label). */
  requester?: string;
  /** Offer the "Always" button + pattern editor. */
  allowAlways?: boolean;
  /** Closes the dialog with `deny` when aborted (leader cancel / timeout). */
  signal?: AbortSignal;
  /** Epoch ms after which the leader denies; shown as a hint. */
  expiresAt?: number;
}

function describeExportSubject(detail: string): string {
  if (detail === 'active') return 'Active session';
  if (detail.startsWith('frozen:')) return `Archived session (${detail.slice('frozen:'.length)})`;
  return detail;
}

/** Open the dialog; resolves with the human's decision (never rejects). */
export function openSudoApprovalDialog(
  req: SudoRequest,
  opts: SudoApprovalDialogOptions = {}
): Promise<SudoDecision> {
  if (opts.signal?.aborted) return Promise.resolve({ decision: 'deny' });
  return new Promise<SudoDecision>((resolve) => {
    const dialog = document.createElement('slicc-dialog');
    dialog.setAttribute('heading', KIND_HEADING[req.kind] ?? 'Approve action?');

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:0.75rem;padding:0.25rem 0;';

    const row = (label: string, value: string, mono = false): HTMLElement => {
      const el = document.createElement('div');
      el.style.cssText = 'display:grid;grid-template-columns:7rem 1fr;gap:0.5rem;';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'color:var(--s2-content-secondary,#717171);font-size:0.875rem;';
      lbl.textContent = label;
      const val = document.createElement('span');
      val.style.cssText = `font-size:0.875rem;word-break:break-all;${mono ? 'font-family:ui-monospace,monospace;' : ''}`;
      val.textContent = value;
      el.append(lbl, val);
      return el;
    };

    if (opts.requester) body.append(row('Requested by', opts.requester));
    body.append(
      row(
        KIND_LABEL[req.kind] ?? 'Detail',
        req.kind === 'export' ? describeExportSubject(req.detail) : req.detail,
        req.kind !== 'export'
      )
    );

    let patternInput: HTMLInputElement | null = null;
    const suggested = req.suggestedPattern?.trim() || req.detail.trim();
    if (opts.allowAlways) {
      const wrap = document.createElement('label');
      wrap.style.cssText =
        'display:grid;grid-template-columns:7rem 1fr;gap:0.5rem;align-items:center;';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'color:var(--s2-content-secondary,#717171);font-size:0.875rem;';
      lbl.textContent = '"Always" pattern';
      patternInput = document.createElement('input');
      patternInput.type = 'text';
      patternInput.value = suggested;
      patternInput.setAttribute('aria-label', 'Always allow pattern');
      patternInput.style.cssText =
        'font-family:ui-monospace,monospace;font-size:0.8125rem;padding:0.35rem 0.5rem;' +
        'border:1px solid var(--s2-border-color,#e0e0e0);border-radius:0.375rem;background:transparent;color:inherit;';
      wrap.append(lbl, patternInput);
      body.append(wrap);
    }

    const hint = document.createElement('p');
    hint.style.cssText = 'font-size:0.8125rem;color:var(--s2-content-secondary,#717171);margin:0;';
    hint.textContent =
      req.kind === 'export'
        ? '⚠️ A complete binary copy of the transcript leaves this session. One-time unless you choose Always.'
        : 'Allow runs it once. Deny stops it. The agent cannot answer this prompt itself.';
    body.append(hint);
    dialog.append(body);

    const makeBtn = (text: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.setAttribute('slot', 'footer');
      btn.setAttribute('data-sudo-action', text.toLowerCase());
      btn.style.cssText = primary
        ? 'padding:0.5rem 1.25rem;border-radius:0.375rem;border:none;cursor:pointer;' +
          'background:var(--s2-accent-color,#0265dc);color:#fff;font-size:0.875rem;'
        : 'padding:0.5rem 1.25rem;border-radius:0.375rem;cursor:pointer;' +
          'background:transparent;border:1px solid var(--s2-border-color,#e0e0e0);font-size:0.875rem;';
      btn.addEventListener('click', onClick, { once: true });
      return btn;
    };

    let resolved = false;
    const settle = (decision: SudoDecision): void => {
      if (resolved) return;
      resolved = true;
      opts.signal?.removeEventListener('abort', onAbort);
      (dialog as HTMLElement & { hide?: () => void }).hide?.();
      dialog.remove();
      resolve(decision);
    };
    const onAbort = (): void => settle({ decision: 'deny' });
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    dialog.append(makeBtn('Allow', true, () => settle({ decision: 'allow', attestation: 'none' })));
    if (opts.allowAlways) {
      dialog.append(
        makeBtn('Always', false, () => {
          const edited = patternInput?.value.trim();
          settle({ decision: 'always', pattern: edited || suggested, attestation: 'none' });
        })
      );
    }
    dialog.append(makeBtn('Deny', false, () => settle({ decision: 'deny' })));

    dialog.addEventListener('slicc-dialog-close', () => settle({ decision: 'deny' }));

    document.body.append(dialog);
    (dialog as HTMLElement & { show?: () => void }).show?.();
  });
}
