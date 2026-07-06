/** `git config` — get, set, unset, and list repo/global config. */

import * as git from 'isomorphic-git';
import {
  GLOBAL_GITCONFIG_PATH,
  readGlobalGitConfigValue,
  removeGitConfigKey,
  writeGlobalGitConfigValue,
} from '../git-config.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function config(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const listFlag = args.includes('--list') || args.includes('-l');
  const unsetFlag = args.includes('--unset');
  const globalFlag = args.includes('--global');

  // Find the config key (contains a dot, not a flag)
  const path = args.find((a) => !a.startsWith('-') && a.includes('.'));

  if (listFlag) {
    return configList(ctx, cwd, globalFlag);
  }

  if (unsetFlag) {
    return configUnset(ctx, cwd, path, globalFlag);
  }

  if (!path) {
    return {
      stdout: '',
      stderr: 'usage: git config [--global] [--list] [--unset] <key> [<value>]\n',
      exitCode: 1,
    };
  }

  // Find value: the arg after the key that is not a flag
  const pathIdx = args.indexOf(path);
  let value: string | undefined;
  for (let i = pathIdx + 1; i < args.length; i++) {
    if (!args[i].startsWith('-')) {
      value = args[i];
      break;
    }
  }

  if (value !== undefined) {
    return configSet(ctx, cwd, path, value, globalFlag);
  }

  return configGet(ctx, cwd, path, globalFlag);
}

/** Unset a config key. */
async function configUnset(
  ctx: GitCommandContext,
  cwd: string,
  path: string | undefined,
  globalFlag: boolean
): Promise<GitCommandResult> {
  if (!path) {
    return { stdout: '', stderr: 'error: key required for --unset\n', exitCode: 1 };
  }
  if (path === 'credential.token' || path === 'github.token') {
    await ctx.setGithubToken('');
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  if (globalFlag) {
    const globalFs = await ctx.getGlobalFs();
    try {
      const content = await globalFs.readTextFile(GLOBAL_GITCONFIG_PATH);
      const newContent = removeGitConfigKey(content, path);
      await globalFs.writeFile(GLOBAL_GITCONFIG_PATH, newContent);
    } catch {
      /* file may not exist */
    }
  } else {
    try {
      const configPath = `${cwd}/.git/config`;
      const content = await ctx.fs.readTextFile(configPath);
      const newContent = removeGitConfigKey(content, path);
      await ctx.fs.writeFile(configPath, newContent);
    } catch {
      /* ignore */
    }
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

/** Set a config key to a value. */
async function configSet(
  ctx: GitCommandContext,
  cwd: string,
  path: string,
  value: string,
  globalFlag: boolean
): Promise<GitCommandResult> {
  if (path === 'credential.token' || path === 'github.token') {
    await ctx.setGithubToken(value);
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  if (globalFlag) {
    await writeGlobalGitConfigValue(await ctx.getGlobalFs(), path, value);
  } else {
    await git.setConfig({ fs: ctx.lfs, dir: cwd, path, value });
  }
  if (path === 'user.name') ctx.setDefaultAuthorName(value);
  if (path === 'user.email') ctx.setDefaultAuthorEmail(value);
  return { stdout: '', stderr: '', exitCode: 0 };
}

/** Get a config value. */
async function configGet(
  ctx: GitCommandContext,
  cwd: string,
  path: string,
  globalFlag: boolean
): Promise<GitCommandResult> {
  if (path === 'credential.token' || path === 'github.token') {
    const token = ctx.getGithubToken();
    return {
      stdout: token ? `${token}\n` : '',
      stderr: '',
      exitCode: token ? 0 : 1,
    };
  }

  let result: string | undefined;
  if (globalFlag) {
    result = await readGlobalGitConfigValue(await ctx.getGlobalFs(), path);
  } else {
    result = await git.getConfig({ fs: ctx.lfs, dir: cwd, path });
    if (!result) {
      result = await readGlobalGitConfigValue(await ctx.getGlobalFs(), path);
    }
  }

  return {
    stdout: result ? `${result}\n` : '',
    stderr: '',
    exitCode: result ? 0 : 1,
  };
}

/**
 * List all config entries from .git/config (and optionally global config).
 */
async function configList(
  ctx: GitCommandContext,
  cwd: string,
  globalOnly: boolean
): Promise<GitCommandResult> {
  let output = '';

  if (!globalOnly) {
    // Read repo config
    try {
      const configPath = `${cwd}/.git/config`;
      const content = await ctx.fs.readTextFile(configPath);
      output += parseGitConfigToList(content);
    } catch {
      /* no config file */
    }
  }

  // Read global config
  try {
    const globalFs = await ctx.getGlobalFs();
    const content = await globalFs.readTextFile(GLOBAL_GITCONFIG_PATH);
    output += parseGitConfigToList(content);
  } catch {
    /* no global config */
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}

/**
 * Parse a git config INI file and return key=value lines.
 */
function parseGitConfigToList(content: string): string {
  let output = '';
  let section = '';
  let subsection = '';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      subsection = sectionMatch[2] ?? '';
      continue;
    }

    const kvMatch = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (kvMatch && section) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();
      const fullKey = subsection ? `${section}.${subsection}.${key}` : `${section}.${key}`;
      output += `${fullKey}=${value}\n`;
    }
  }

  return output;
}
