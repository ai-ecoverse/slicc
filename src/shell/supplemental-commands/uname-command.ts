import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function unameHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: uname\n',
    stderr: '',
    exitCode: 0,
  };
}

export function createUnameCommand(): Command {
  return defineCommand('uname', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return unameHelp();
    }

    if (args.length > 0) {
      return {
        stdout: '',
        stderr: 'uname: unsupported arguments\n',
        exitCode: 1,
      };
    }

    const userAgent = globalThis.navigator?.userAgent;
    if (typeof userAgent !== 'string' || userAgent.length === 0) {
      return {
        stdout: '',
        stderr: 'uname: navigator.userAgent is unavailable\n',
        exitCode: 1,
      };
    }

    return {
      stdout: `${userAgent}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}