// @vitest-environment jsdom
/**
 * `<slicc-diff>` must render every file, whatever its extension.
 *
 * `@pierre/diffs` infers a grammar from the file name and, in the shipped
 * build, resolves it against the CURATED Shiki map (`src/shims/shiki-bundle.ts`,
 * served by `curatedShikiBundlePlugin`). A grammar missing there (`.abap`) made
 * the library throw "not found" and render nothing at all, so the element now
 * hands such a file over as `lang: 'text'`.
 *
 * Node's vitest run gives the library the FULL grammar set, so its own
 * `resolveLanguage` is replaced with one that consults the real curated map —
 * the same lookup it performs in the webapp build. `FileDiff` is a recorder:
 * what the element hands the library is its contract; how the library paints
 * plain text is exercised against the real thing in
 * `packages/webcomponents/tests/quick-look/` (real Chromium, shipped grammars).
 */

import type { FileContents, FileDiffMetadata } from '@pierre/diffs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RecordedRender {
  fileDiff?: FileDiffMetadata;
  oldFile?: FileContents;
  newFile?: FileContents;
  fileContainer?: HTMLElement;
}

const recorder = vi.hoisted(() => ({
  renders: [] as RecordedRender[],
  /** Grammar probes held open by a test, keyed by language. */
  held: new Map<string, Promise<void>>(),
}));

vi.mock('@pierre/diffs', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pierre/diffs')>();
  const { bundledLanguages } = await import('../../src/shims/shiki-bundle.js');
  class FileDiff {
    render(props: RecordedRender): void {
      recorder.renders.push(props);
    }
    setThemeType(): void {}
  }
  return {
    ...real,
    FileDiff,
    resolveLanguage: vi.fn(async (lang: string) => {
      await recorder.held.get(lang);
      if (!Object.hasOwn(bundledLanguages, lang)) {
        throw new Error(`resolveLanguage: "${lang}" not found in bundled or custom languages`);
      }
      return { name: lang, data: [] };
    }),
  };
});

const { resolveLanguage } = await import('@pierre/diffs');
const { SliccDiffElement } = await import('../../src/ui/slicc-diff.js');

const ABAP_PATCH = [
  'diff --git a/report.abap b/report.abap',
  '--- a/report.abap',
  '+++ b/report.abap',
  '@@ -1,2 +1,2 @@',
  ' REPORT zhello.',
  "-WRITE 'Hello'.",
  "+WRITE 'Hello, world'.",
  '',
].join('\n');

function mount(attrs: Record<string, string> = {}): InstanceType<typeof SliccDiffElement> {
  const el = document.createElement('slicc-diff') as InstanceType<typeof SliccDiffElement>;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  document.body.appendChild(el);
  return el;
}

/** A probe for `lang` that stays pending until the returned release runs. */
function holdProbe(lang: string): () => void {
  let release = (): void => {};
  recorder.held.set(
    lang,
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  return () => {
    recorder.held.delete(lang);
    release();
  };
}

describe('<slicc-diff> language fallback', () => {
  beforeEach(() => {
    recorder.renders.length = 0;
    recorder.held.clear();
    vi.mocked(resolveLanguage).mockClear();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('hands a two-file diff outside the curated set over as plain text', async () => {
    mount({
      'old-name': 'report.abap',
      'old-contents': "WRITE 'Hello'.\n",
      'new-name': 'report.abap',
      'new-contents': "WRITE 'Hello, world'.\n",
    });

    await vi.waitFor(() => expect(recorder.renders).toHaveLength(1));
    const [{ oldFile, newFile, fileContainer }] = recorder.renders as [RecordedRender];
    expect(newFile).toEqual({
      name: 'report.abap',
      contents: "WRITE 'Hello, world'.\n",
      lang: 'text',
    });
    expect(oldFile?.lang).toBe('text');
    expect(fileContainer?.tagName).toBe('DIFFS-CONTAINER');
  });

  it('hands a patch outside the curated set over as plain text', async () => {
    const el = mount();
    el.patch = ABAP_PATCH;

    await vi.waitFor(() => expect(recorder.renders).toHaveLength(1));
    const { fileDiff } = recorder.renders[0] as RecordedRender;
    expect(fileDiff?.name).toBe('report.abap');
    expect(fileDiff?.lang).toBe('text');
    expect(fileDiff?.additionLines.join('')).toContain("WRITE 'Hello, world'.");
  });

  it('leaves a curated language to inference, so it still highlights', async () => {
    const el = mount();
    el.oldFile = { name: 'main.ts', contents: 'const a = 1;\n' };
    el.newFile = { name: 'main.ts', contents: 'const a = 2;\n' };

    await vi.waitFor(() => expect(recorder.renders).toHaveLength(1));
    const { newFile } = recorder.renders[0] as RecordedRender;
    expect(newFile).toBe(el.newFile);
    expect(newFile?.lang).toBeUndefined();
    expect(resolveLanguage).toHaveBeenCalledWith('typescript');
  });

  it('does not let a slow probe paint over a newer diff', async () => {
    const release = holdProbe('typescript');
    const el = mount();
    el.oldFile = { name: 'main.ts', contents: 'a\n' };
    el.newFile = { name: 'main.ts', contents: 'b\n' };
    await vi.waitFor(() => expect(resolveLanguage).toHaveBeenCalledWith('typescript'));

    el.patch = ABAP_PATCH;
    await vi.waitFor(() => expect(recorder.renders).toHaveLength(1));
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(recorder.renders).toHaveLength(1);
    expect(recorder.renders[0]?.fileDiff?.name).toBe('report.abap');
  });

  it('does not render once the element has left the DOM', async () => {
    const release = holdProbe('typescript');
    const el = mount();
    el.oldFile = { name: 'main.ts', contents: 'a\n' };
    el.newFile = { name: 'main.ts', contents: 'b\n' };
    await vi.waitFor(() => expect(resolveLanguage).toHaveBeenCalledWith('typescript'));

    el.remove();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(recorder.renders).toHaveLength(0);
  });
});
