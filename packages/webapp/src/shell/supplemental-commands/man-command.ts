import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { createProxiedFetch } from '../proxied-fetch.js';

function manHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: man <topic>\n\nFetches documentation for a given topic from sliccy.com.\n',
    stderr: '',
    exitCode: 0,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trimEnd();
}

export function createManCommand(): Command {
  // Route through the same proxied fetch path that `curl` uses so the
  // request bypasses the CORS wall in CLI / kernel-worker mode (the
  // bare `fetch()` previously used here only worked in extension mode
  // where `host_permissions` grants direct cross-origin access). Built
  // once per command so the `SecureFetch` closure is shared across
  // invocations.
  const proxiedFetch = createProxiedFetch();

  return defineCommand('man', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return manHelp();
    }

    if (args.length === 0) {
      return {
        stdout: '',
        stderr: "What manual page do you want?\nFor example, try 'man commands'.\n",
        exitCode: 1,
      };
    }

    const topic = args.join('-');
    const url = `https://www.sliccy.com/man/${topic}.plain.html`;

    try {
      const response = await proxiedFetch(url, { method: 'GET' });

      if (response.status === 404) {
        return {
          stdout: '',
          stderr: `No manual entry for ${topic}\n`,
          exitCode: 1,
        };
      }

      if (response.status < 200 || response.status >= 300) {
        return {
          stdout: '',
          stderr: `man: failed to fetch manual page for ${topic}: ${response.status} ${response.statusText}\n`,
          exitCode: 1,
        };
      }

      const html = new TextDecoder('utf-8').decode(response.body);
      const plainText = stripHtml(html);

      return {
        stdout: plainText + '\n',
        stderr: '',
        exitCode: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: `man: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}
