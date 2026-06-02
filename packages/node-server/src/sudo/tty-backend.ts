/**
 * Headless editable-TTY sudo backend.
 *
 * When there's no GUI but the node-server has a controlling terminal, the
 * approval gesture is a keystroke on stdin: `[a]llow once / [d]eny / [A]lways`.
 * Choosing "Always" then reads an editable pattern line (blank keeps the
 * suggested default). Fail closed: a closed stream, EOF, or any error denies.
 */

import type { Interface as ReadlineInterface } from 'readline';
import { createInterface } from 'readline';
import type { SudoApproveRequest, SudoBackend, SudoDecision } from './types.js';

/** Seam for tests: build a question-asking interface over arbitrary streams. */
export interface TtyDeps {
  output?: NodeJS.WritableStream;
  createRl?: () => Pick<ReadlineInterface, 'question' | 'close'>;
}

function defaultRl(): Pick<ReadlineInterface, 'question' | 'close'> {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: Pick<ReadlineInterface, 'question'>, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, (answer) => resolve(answer)));
}

/** Create the editable-TTY backend. */
export function createTtyBackend(deps: TtyDeps = {}): SudoBackend {
  const out = deps.output ?? process.stdout;
  const makeRl = deps.createRl ?? defaultRl;

  return {
    name: 'tty',
    async prompt(req: SudoApproveRequest): Promise<SudoDecision> {
      const suggested = req.suggestedPattern?.trim() || req.detail.trim();
      const rl = makeRl();
      try {
        out.write(`\nSLICC sudo — approve ${req.kind}: ${req.detail}\n`);
        const choice = (await ask(rl, '[a]llow once / [d]eny / [A]lways (edit pattern): ')).trim();
        if (choice === 'a') return { decision: 'allow' };
        if (choice === 'A') {
          const edited = (await ask(rl, `Always pattern [${suggested}]: `)).trim();
          return { decision: 'always', pattern: edited.length > 0 ? edited : suggested };
        }
        return { decision: 'deny' };
      } catch {
        return { decision: 'deny' };
      } finally {
        try {
          (rl as { close?: () => void }).close?.();
        } catch {
          // ignore close errors
        }
      }
    },
  };
}
