import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createCuaS1Command } from '../../../src/shell/supplemental-commands/cua-s1-command.js';
import {
  parseQuestionShorthand,
  parseStateText,
} from '../../../src/shell/supplemental-commands/decision/kev-questions.js';
import { planToPlaywrightLines } from '../../../src/shell/supplemental-commands/decision/plan-commands.js';
import {
  type CuaRuntime,
  explainDecisionError,
  type KevRuntime,
} from '../../../src/shell/supplemental-commands/decision/runtime.js';
import { elementsFromSnapshot } from '../../../src/shell/supplemental-commands/decision/snapshot-elements.js';
import { createKevCommand } from '../../../src/shell/supplemental-commands/kev-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const SNAPSHOT = `Page URL: https://clinic.example
Page Title: Northwind Clinic - New Patient Registration - Google Chrome

- main
  - textbox "Phone number" [ref=e3]: ""
  - checkbox "I consent to treatment" [ref=e4]
  - button "Submit" [ref=e5]
  - link "Home" [ref=e2]
  - radio "Yes" [ref=e6]
  - textbox "Note" [ref=e7]: "already"
`;

function files(map: Record<string, string>): Partial<IFileSystem> {
  return {
    readFile: vi.fn(async (path: string) => {
      const text = map[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    }),
  };
}

describe('snapshot elements', () => {
  it('keeps the three roles cua-s1 was trained on and strips the browser suffix', () => {
    const form = elementsFromSnapshot(SNAPSHOT);
    expect(form.title).toBe('Northwind Clinic - New Patient Registration');
    expect(form.elements.map((element) => [element.role, element.token, element.label])).toEqual([
      ['Edit', 'e3', 'Phone number'],
      ['CheckBox', 'e4', 'I consent to treatment'],
      ['Button', 'e5', 'Submit'],
      ['Edit', 'e7', 'Note'],
    ]);
    expect(form.elements[1].checked).toBe(false);
    expect(form.elements[3].value).toBe('already');
  });

  it('reads an explicit checked marker', () => {
    const form = elementsFromSnapshot('- checkbox "News" [ref=e1] [checked=true]');
    expect(form.elements[0].checked).toBe(true);
  });
});

describe('kev questions', () => {
  it('parses noul, choice, and score shorthand', () => {
    expect(parseQuestionShorthand('billing:noul:Is this about billing?')).toEqual([
      'billing',
      { type: 'noul', instructions: 'Is this about billing?' },
    ]);
    expect(parseQuestionShorthand('tone:choice:What tone?::calm|frustrated')).toEqual([
      'tone',
      { type: 'choice', instructions: 'What tone?', criteria: { calm: null, frustrated: null } },
    ]);
    expect(parseQuestionShorthand('urgency:score:How urgent?::can wait|today')[1]).toMatchObject({
      type: 'score',
      criteria: ['can wait', 'today'],
    });
  });

  it('keeps a JSON object as structured state and leaves prose as text', () => {
    expect(parseStateText('{"ticket":"twice"}')).toEqual({ ticket: 'twice' });
    expect(parseStateText('not {json')).toBe('not {json');
  });
});

describe('plan commands', () => {
  it('prints fill, check, and click in playwright-cli form', () => {
    const lines = planToPlaywrightLines(
      {
        title: 'Clinic',
        minConfidence: 0.5,
        allowSubmit: false,
        entities: [{ label: 'Tel', value: '(503) 555-0142' }],
        decisions: [],
        actions: [
          {
            token: 'e3',
            role: 'Edit',
            label: 'Phone number',
            action: 'fill',
            probability: 0.91,
            entityIndex: 0,
          },
          {
            token: 'e4',
            role: 'CheckBox',
            label: 'I consent',
            action: 'check',
            probability: 0.8,
            entityIndex: null,
          },
          {
            token: 'e5',
            role: 'Button',
            label: 'Submit',
            action: 'click',
            probability: 0.7,
            entityIndex: null,
          },
        ],
      },
      'E9A3F'
    );
    expect(lines).toEqual([
      "playwright-cli fill --tab=E9A3F e3 '(503) 555-0142'",
      'playwright-cli check --tab=E9A3F e4',
      'playwright-cli click --tab=E9A3F e5',
    ]);
  });
});

describe('decision runtime errors', () => {
  it('names ipk add when the wasm file is missing from the preview path', () => {
    const message = explainDecisionError(
      new Error(
        'Failed to fetch dynamically imported module: http://localhost:8787/preview/workspace/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'
      )
    );
    expect(message).toContain('ipk add onnxruntime-web');
    expect(message).toContain('ort-wasm-simd-threaded.mjs');
  });
});

describe('kev command', () => {
  const runtime: KevRuntime = {
    ask: vi.fn(async () => ({
      model: 'kev-0.8b',
      latency_ms: 108,
      answers: {
        billing: { type: 'noul' as const, noul: 1 },
        tone: { type: 'choice' as const, choice: 'frustrated', confidence: 0.7 },
      },
    })),
  };

  it('scores piped text and prints yes/no plus the choice', async () => {
    const cmd = createKevCommand({ runtime });
    const result = await cmd.execute(
      ['ask', 'billing:noul:Is this about billing?', 'tone:choice:What tone?::calm|frustrated'],
      mockCommandContext({ stdin: 'I was charged twice.', stdinIsTTY: false })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('billing\tyes\t1.00');
    expect(result.stdout).toContain('tone\tfrustrated\t0.70');
    expect(runtime.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'I was charged twice.',
        model: '0.8b',
        dateFacts: false,
      })
    );
  });

  it('answers ask --help without scoring', async () => {
    vi.mocked(runtime.ask).mockClear();
    const cmd = createKevCommand({ runtime });
    const result = await cmd.execute(['ask', '--help'], mockCommandContext());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('ask');
    expect(runtime.ask).not.toHaveBeenCalled();
  });

  it('refuses to ask with no text and no question', async () => {
    const cmd = createKevCommand({ runtime });
    const empty = await cmd.execute(['ask'], mockCommandContext());
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toMatch(/question/);
  });
});

describe('cua-s1 command', () => {
  it('answers plan --help without reading a snapshot', async () => {
    const cmd = createCuaS1Command();
    const result = await cmd.execute(['plan', '--help'], mockCommandContext());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('plan');
  });

  it('maps a snapshot file without loading a model', async () => {
    const cmd = createCuaS1Command();
    const result = await cmd.execute(
      ['elements', '--snapshot', '/tmp/snap.txt'],
      mockCommandContext({ fs: files({ '/tmp/snap.txt': SNAPSHOT }) })
    );
    expect(result.exitCode).toBe(0);
    const form = JSON.parse(result.stdout) as { title: string; elements: { token: string }[] };
    expect(form.title).toBe('Northwind Clinic - New Patient Registration');
    expect(form.elements.map((element) => element.token)).toEqual(['e3', 'e4', 'e5', 'e7']);
  });

  it('plans through the injected runtime and prints playwright lines from that plan', async () => {
    const runtime: CuaRuntime = {
      plan: vi.fn(async (input) => ({
        title: input.title,
        minConfidence: input.minConfidence,
        allowSubmit: input.allowSubmit,
        entities: [{ label: 'Tel', value: '(503) 555-0142' }],
        decisions: [
          {
            token: 'e3',
            role: 'Edit',
            label: 'Phone number',
            action: 'fill' as const,
            probability: 0.91,
            entityIndex: 0,
          },
        ],
        actions: [
          {
            token: 'e3',
            role: 'Edit',
            label: 'Phone number',
            action: 'fill' as const,
            probability: 0.91,
            entityIndex: 0,
          },
        ],
      })),
    };
    const cmd = createCuaS1Command({ runtime });
    const planned = await cmd.execute(
      ['plan', '--snapshot', '/tmp/snap.txt', '--document', '/tmp/doc.txt', '--json'],
      mockCommandContext({
        fs: files({
          '/tmp/snap.txt': SNAPSHOT,
          '/tmp/doc.txt': 'Tel: (503) 555-0142\n',
        }),
      })
    );
    expect(planned.exitCode).toBe(0);
    expect(runtime.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Northwind Clinic - New Patient Registration',
        allowSubmit: false,
        minConfidence: 0.5,
      })
    );

    const lines = await cmd.execute(
      ['commands', '--plan', '-', '--tab', 'E9A3F'],
      mockCommandContext({ stdin: planned.stdout, stdinIsTTY: false })
    );
    expect(lines.exitCode).toBe(0);
    expect(lines.stdout).toBe("playwright-cli fill --tab=E9A3F e3 '(503) 555-0142'\n");
  });

  it('leaves submit off unless asked', async () => {
    const runtime: CuaRuntime = {
      plan: vi.fn(async (input) => ({
        title: input.title,
        minConfidence: input.minConfidence,
        allowSubmit: input.allowSubmit,
        entities: [],
        decisions: [],
        actions: [],
      })),
    };
    const cmd = createCuaS1Command({ runtime });
    await cmd.execute(
      ['plan', '--elements', '/tmp/el.json', '--document', '-', '--allow-submit'],
      mockCommandContext({
        stdin: 'Tel: (503) 555-0142\n',
        stdinIsTTY: false,
        fs: files({
          '/tmp/el.json': JSON.stringify({
            title: 'Clinic',
            elements: [{ role: 'Edit', label: 'Phone', token: 'e3', index: 0 }],
          }),
        }),
      })
    );
    expect(runtime.plan).toHaveBeenCalledWith(expect.objectContaining({ allowSubmit: true }));
  });
});
