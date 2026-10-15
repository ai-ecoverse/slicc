// @vitest-environment jsdom
/**
 * Secrets page: unreadable-row copy and the Re-enter flow. Each case checks
 * the normal (readable) row first as the control.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSecretRow,
  prefillCustomSecret,
  UNREADABLE_SECRET_COPY,
} from '../src/secrets-entry.js';

const html = readFileSync(resolve(__dirname, '../secrets.html'), 'utf8');

function loadPage(): void {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = doc.head.innerHTML;
  document.body.innerHTML = doc.body.innerHTML;
}

const buttonsOf = (row: HTMLElement) =>
  [...row.querySelectorAll('button')].map((b) => ({ text: b.textContent, cls: b.className }));

describe('secrets page — unreadable rows', () => {
  beforeEach(loadPage);

  it('uses the exact copy, and only on unreadable rows', () => {
    const normal = createSecretRow({ name: 'OK', domains: ['a.com'] });
    expect(normal.querySelector('.secret-unreadable')).toBeNull();
    expect(normal.className).toBe('secret-row');
    const bad = createSecretRow({ name: 'LOST', domains: ['b.com'], unreadable: true });
    expect(bad.querySelector('.secret-unreadable')?.textContent).toBe(
      "This value can't be read any more. Enter it again."
    );
    expect(UNREADABLE_SECRET_COPY).toBe("This value can't be read any more. Enter it again.");
    expect(bad.className).toBe('secret-row secret-row-unreadable');
  });

  it('adds a Re-enter button styled like the normal rows’ buttons', () => {
    const normal = buttonsOf(createSecretRow({ name: 'OK', domains: ['a.com'] }));
    expect(normal.map((b) => b.text)).toEqual(['Copy name', 'Delete']);
    const bad = buttonsOf(createSecretRow({ name: 'LOST', domains: ['b.com'], unreadable: true }));
    expect(bad.map((b) => b.text)).toEqual(['Re-enter', 'Copy name', 'Delete']);
    // Same classes as the normal row's buttons; Re-enter matches Copy name.
    expect(bad.slice(1)).toEqual(normal);
    expect(bad[0]?.cls).toBe(normal[0]?.cls);
  });

  it('Re-enter opens the Custom secret tab with name and domains prefilled, value empty', () => {
    // Control: the S3 tab is active on load and the custom form is empty.
    expect(document.querySelector('.tab.active')?.getAttribute('data-pane')).toBe('s3');
    expect(document.getElementById('pane-custom')?.classList.contains('active')).toBe(false);
    (document.getElementById('c-value') as HTMLInputElement).value = 'stale-typed-value';
    const row = createSecretRow({
      name: 'LOST_TOKEN',
      domains: ['api.example.com', '*.example.com'],
      unreadable: true,
    });
    document.getElementById('list')?.replaceChildren(row);
    row.querySelector('button')?.click();
    expect(document.querySelector('.tab.active')?.getAttribute('data-pane')).toBe('custom');
    expect(document.getElementById('pane-custom')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('pane-s3')?.classList.contains('active')).toBe(false);
    expect((document.getElementById('c-name') as HTMLInputElement).value).toBe('LOST_TOKEN');
    expect((document.getElementById('c-domains') as HTMLInputElement).value).toBe(
      'api.example.com, *.example.com'
    );
    expect((document.getElementById('c-value') as HTMLInputElement).value).toBe('');
    expect(document.activeElement?.id).toBe('c-value');
  });

  it('prefillCustomSecret works for a secret with no domains', () => {
    prefillCustomSecret({ name: 'X', domains: [] });
    expect((document.getElementById('c-domains') as HTMLInputElement).value).toBe('');
  });

  it('stacks labels above inputs below 600 px (and keeps the two-column grid above)', () => {
    const css = document.head.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.form-grid\s*{[^}]*grid-template-columns:\s*140px 1fr/);
    const narrow = /@media \(max-width: 600px\)\s*{([\s\S]*?)\n {6}}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/\.form-grid\s*{[^}]*grid-template-columns:\s*1fr;/);
  });
});
