import { describe, expect, it } from 'vitest';
import { parseCloudArgs } from '../../src/cloud/dispatch.js';

describe('parseCloudArgs', () => {
  it('parses --cloud start with name and env-file', () => {
    const r = parseCloudArgs([
      '--cloud',
      'start',
      '--name',
      'task-1',
      '--env-file',
      '/etc/slicc.env',
    ]);
    expect(r).toEqual({
      subcommand: 'start',
      args: { name: 'task-1', envFile: '/etc/slicc.env', substrate: 'e2b' },
    });
  });

  it('parses --cloud list', () => {
    const r = parseCloudArgs(['--cloud', 'list']);
    expect(r).toEqual({ subcommand: 'list', args: { substrate: 'e2b' } });
  });

  it('parses --cloud pause/resume/kill with positional query', () => {
    expect(parseCloudArgs(['--cloud', 'pause', 'task-1'])).toEqual({
      subcommand: 'pause',
      args: { query: 'task-1', substrate: 'e2b' },
    });
    expect(parseCloudArgs(['--cloud', 'resume', 'sb-abc'])).toEqual({
      subcommand: 'resume',
      args: { query: 'sb-abc', substrate: 'e2b' },
    });
    expect(parseCloudArgs(['--cloud', 'kill', 'task-1'])).toEqual({
      subcommand: 'kill',
      args: { query: 'task-1', substrate: 'e2b' },
    });
  });

  it('rejects --cloud and --hosted in the same invocation', () => {
    expect(() => parseCloudArgs(['--cloud', 'list', '--hosted'])).toThrow(/mutually exclusive/i);
    expect(() => parseCloudArgs(['--hosted', '--cloud', 'list'])).toThrow(/mutually exclusive/i);
  });

  it('rejects unknown subcommands', () => {
    expect(() => parseCloudArgs(['--cloud', 'banana'])).toThrow(/unknown subcommand/i);
  });

  it('returns null when --cloud is absent', () => {
    expect(parseCloudArgs(['--hosted', '--port', '5710'])).toBeNull();
    expect(parseCloudArgs([])).toBeNull();
  });
});
