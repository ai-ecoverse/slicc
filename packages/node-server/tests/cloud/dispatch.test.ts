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
      args: { substrate: 'e2b', name: 'task-1', envFile: '/etc/slicc.env' },
    });
  });

  it('parses --cloud start with --template (isolated test alias)', () => {
    const r = parseCloudArgs(['--cloud', 'start', '--name', 'test-1', '--template', 'slicc-test']);
    expect(r).toEqual({
      subcommand: 'start',
      args: { substrate: 'e2b', name: 'test-1', template: 'slicc-test' },
    });
  });

  it('parses --cloud list', () => {
    const r = parseCloudArgs(['--cloud', 'list']);
    expect(r).toEqual({ subcommand: 'list', args: { substrate: 'e2b' } });
  });

  it('accepts the explicit e2b substrate', () => {
    expect(parseCloudArgs(['--cloud', 'list', '--substrate', 'e2b'])).toEqual({
      subcommand: 'list',
      args: { substrate: 'e2b' },
    });
  });

  it('parses --cloud pause/resume/kill with positional query', () => {
    expect(parseCloudArgs(['--cloud', 'pause', 'task-1'])).toEqual({
      subcommand: 'pause',
      args: { substrate: 'e2b', query: 'task-1' },
    });
    expect(parseCloudArgs(['--cloud', 'resume', 'sb-abc'])).toEqual({
      subcommand: 'resume',
      args: { substrate: 'e2b', query: 'sb-abc' },
    });
    expect(parseCloudArgs(['--cloud', 'kill', 'task-1'])).toEqual({
      subcommand: 'kill',
      args: { substrate: 'e2b', query: 'task-1' },
    });
  });

  it('rejects --cloud and --hosted in the same invocation', () => {
    expect(() => parseCloudArgs(['--cloud', 'list', '--hosted'])).toThrow(/mutually exclusive/i);
    expect(() => parseCloudArgs(['--hosted', '--cloud', 'list'])).toThrow(/mutually exclusive/i);
  });

  it('rejects unknown subcommands', () => {
    expect(() => parseCloudArgs(['--cloud', 'banana'])).toThrow(/unknown subcommand/i);
  });

  it('rejects unsupported substrates, stray flags, and missing queries', () => {
    expect(() => parseCloudArgs(['--cloud', 'list', '--substrate', 'docker'])).toThrow(
      'unsupported substrate'
    );
    expect(() => parseCloudArgs(['--cloud', 'start', '--unknown'])).toThrow('unrecognized arg');
    for (const subcommand of ['pause', 'resume', 'kill']) {
      expect(() => parseCloudArgs(['--cloud', subcommand])).toThrow('requires a query');
    }
  });

  it('returns null when --cloud is absent', () => {
    expect(parseCloudArgs(['--hosted', '--port', '5710'])).toBeNull();
    expect(parseCloudArgs([])).toBeNull();
  });
});
