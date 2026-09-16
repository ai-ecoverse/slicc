import { Bash, defineCommand } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { sayStdioPlugin } from '../../../src/shell/supplemental-commands/say-stdio-rewrite.js';

function rewriteSayStdio(command: string): string {
  const bash = new Bash();
  bash.registerTransformPlugin(sayStdioPlugin);
  try {
    return bash.transform(command).script;
  } catch {
    return command;
  }
}

describe('sayStdioPlugin', () => {
  it('leaves a TTY say invocation alone', () => {
    expect(rewriteSayStdio('say -l en-US hello')).toBe('say -l en-US hello');
  });

  it('injects -o - when say is piped', () => {
    expect(rewriteSayStdio('say -l en-US hello | hear')).toBe('say -o - -l en-US hello | hear');
  });

  it('injects -o - when say stdout is redirected', () => {
    expect(rewriteSayStdio('say -l en-US hello > out.wav')).toBe(
      'say -o - -l en-US hello > out.wav'
    );
  });

  it('does not inject when say is the last pipeline stage', () => {
    expect(rewriteSayStdio('echo x | say -l en-US hello')).toBe('echo x | say -l en-US hello');
  });

  it('does not inject a second -o when one is already present', () => {
    expect(rewriteSayStdio('say -o speech.wav -l en-US hello | xxd')).toBe(
      'say -o speech.wav -l en-US hello | xxd'
    );
  });

  it('injects inside command substitution', () => {
    expect(rewriteSayStdio('x=$(say -l en-US hello)')).toContain('say -o -');
  });

  it('returns the original script when parse fails', () => {
    expect(rewriteSayStdio("say 'unterminated")).toBe("say 'unterminated");
  });

  it('exec applies the plugin so a piped say sees -o -', async () => {
    const seen: string[][] = [];
    const say = defineCommand('say', async (args) => {
      seen.push([...args]);
      return { stdout: 'RIFF', stderr: '', exitCode: 0 };
    });
    const bash = new Bash({ customCommands: [say] });
    bash.registerTransformPlugin(sayStdioPlugin);
    await bash.exec('say -l en-US hi | cat');
    expect(seen[0]).toEqual(['-o', '-', '-l', 'en-US', 'hi']);
  });

  it('exec leaves a last-stage say without -o -', async () => {
    const seen: string[][] = [];
    const say = defineCommand('say', async (args) => {
      seen.push([...args]);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const bash = new Bash({ customCommands: [say] });
    bash.registerTransformPlugin(sayStdioPlugin);
    await bash.exec('say -l en-US hi');
    expect(seen[0]).toEqual(['-l', 'en-US', 'hi']);
  });
});
