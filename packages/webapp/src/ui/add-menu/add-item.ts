/** Kinds of thing the add-menu can reference. All are reachable via the
 *  agent's tools, so they ride along as references (not inline content). */
export type AddItemKind = 'file' | 'folder' | 'skill' | 'session' | 'scoop';

export interface AddItem {
  kind: AddItemKind;
  /** Display name: filename / skill name / session title / scoop name. */
  label: string;
  /** Secondary line: path or context, e.g. "/workspace/src". */
  sublabel?: string;
  /** Resolvable reference for the preamble:
   *  file,folder → VFS path; skill → name; session → /sessions/<file>; scoop → jid. */
  locator: string;
}

/** User-facing category label for a reference kind. "session" reads as
 *  "conversation" to match the add-menu search placeholder; everything else
 *  uses its own name. */
const REFERENCE_KIND_LABELS: Record<AddItemKind, string> = {
  file: 'file',
  folder: 'folder',
  skill: 'skill',
  session: 'conversation',
  scoop: 'scoop',
};

export function referenceKindLabel(kind: AddItemKind): string {
  return REFERENCE_KIND_LABELS[kind];
}
