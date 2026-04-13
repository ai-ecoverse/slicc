import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

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
      const response = await fetch(url);

      if (response.status === 404) {
        return {
          stdout: '',
          stderr: `No manual entry for ${topic}\n`,
          exitCode: 1,
        };
      }

      if (!response.ok) {
        return {
          stdout: '',
          stderr: `man: failed to fetch manual page for ${topic}: ${response.status} ${response.statusText}\n`,
          exitCode: 1,
        };
      }

      const html = await response.text();
      const plainText = stripHtml(html);

      return {
        stdout: plainText + '\n',
        stderr: '',
        exitCode: 0,
      };
    } catch (err: any) {
      return {
        stdout: '',
        stderr: `man: ${err.message || String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
