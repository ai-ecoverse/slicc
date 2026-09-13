import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const NO_COMMENT_MARKER = '.no-comment';

export function isNoCommentTree(root) {
  return existsSync(join(root, NO_COMMENT_MARKER));
}
