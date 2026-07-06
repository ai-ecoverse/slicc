/** `git tag` — create (lightweight/annotated), list, or delete tags. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { flagString, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function tag(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags, positionals: positional } = parseArgs(args, GIT_FLAG_SPECS.tag);
  const deleteFlag = flags.delete === true;
  const listPattern = flagString(flags, 'list');
  const annotate = flags.annotate === true;
  const message = flagString(flags, 'message');
  const force = flags.force === true;

  // Delete tag
  if (deleteFlag) {
    const tagName = positional[0];
    if (!tagName) {
      return { stdout: '', stderr: 'fatal: tag name required\n', exitCode: 128 };
    }
    await git.deleteTag({ fs: ctx.lfs, dir: cwd, ref: tagName });
    return { stdout: `Deleted tag '${tagName}'\n`, stderr: '', exitCode: 0 };
  }

  // List tags (with optional pattern)
  if (listPattern !== undefined || positional.length === 0) {
    const tags = await git.listTags({ fs: ctx.lfs, dir: cwd });
    let filtered = tags;
    const pattern = listPattern || undefined;
    if (pattern) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      filtered = tags.filter((t) => regex.test(t));
    }
    const output = filtered.map((t) => `${t}\n`).join('');
    return { stdout: output, stderr: '', exitCode: 0 };
  }

  // Create tag
  const tagName = positional[0];
  const target = positional[1]; // optional commit

  if (annotate || message) {
    const tagger = await ctx.resolveAuthor(cwd);
    // Annotated tag
    await git.annotatedTag({
      fs: ctx.lfs,
      dir: cwd,
      ref: tagName,
      message: message ?? tagName,
      object: target,
      tagger: {
        ...tagger,
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: 0,
      },
      force,
    });
  } else {
    // Lightweight tag
    await git.tag({
      fs: ctx.lfs,
      dir: cwd,
      ref: tagName,
      object: target,
      force,
    });
  }

  return { stdout: '', stderr: '', exitCode: 0 };
}
