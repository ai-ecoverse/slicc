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
