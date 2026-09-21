/**
 * Map a `playwright-cli snapshot` transcript onto the element roles cua-s1
 * was trained on. The model scores Edit, CheckBox, and Button. Links, radios,
 * and selects stay out, matching the cua-s1 demo.
 */

export interface FormElement {
  role: 'Edit' | 'CheckBox' | 'Button';
  label: string;
  value?: string;
  checked?: boolean;
  index: number;
  token: string;
}

export interface SnapshotForm {
  title: string;
  elements: FormElement[];
}

const ROLE_MAP: Record<string, FormElement['role']> = {
  textbox: 'Edit',
  searchbox: 'Edit',
  checkbox: 'CheckBox',
  button: 'Button',
};

/** Browser-name suffixes `normalizeTitle` strips. Kept here so `elements` stays offline. */
const APP_SUFFIXES = [
  ' - Google Chrome',
  ' - Microsoft Edge',
  ' - Mozilla Firefox',
  ' - Brave',
  ' - Safari',
];

export function normalizeFormTitle(title: string): string {
  for (const suffix of APP_SUFFIXES) {
    if (title.endsWith(suffix)) return title.slice(0, -suffix.length);
  }
  return title;
}

function unescapeYaml(value: string): string {
  return value.replace(/\\([\\n"])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch));
}

const SNAPSHOT_LINE =
  /^(\s*)- ([A-Za-z][\w-]*)(?: "((?:\\.|[^"\\])*)")?(?: \[ref=([^\]]+)\])?(?:: "((?:\\.|[^"\\])*)")?(.*)$/;

/**
 * Pull actionable fields out of a snapshot. `Page Title:` becomes the form
 * title after the browser suffix is removed. Elements without a ref keep a
 * synthetic token so a later plan can still name them.
 */
export function elementsFromSnapshot(snapshot: string): SnapshotForm {
  let title = '';
  const elements: FormElement[] = [];

  for (const rawLine of snapshot.split('\n')) {
    const titleMatch = /^Page Title:\s*(.*)$/.exec(rawLine.trim());
    if (titleMatch && !title) {
      title = normalizeFormTitle(titleMatch[1].trim());
      continue;
    }

    const match = SNAPSHOT_LINE.exec(rawLine);
    if (!match) continue;
    const role = ROLE_MAP[match[2].toLowerCase()];
    if (!role) continue;

    const label = match[3] ? unescapeYaml(match[3]) : '';
    const token = match[4] || `e${elements.length + 1}`;
    const value = match[5] !== undefined ? unescapeYaml(match[5]) : '';
    const rest = match[6] ?? '';
    const checkedMatch = /\[checked(?:=(true|false))?\]/.exec(rest);
    const element: FormElement = { role, label, index: elements.length, token };
    if (role === 'CheckBox') {
      element.checked = checkedMatch ? checkedMatch[1] !== 'false' : false;
    } else if (value) {
      element.value = value;
    }
    elements.push(element);
  }

  return { title, elements };
}
