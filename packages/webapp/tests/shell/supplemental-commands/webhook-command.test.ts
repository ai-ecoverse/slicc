import { describe, expect, it } from 'vitest';
import { createWebhookCommand } from '../../../src/shell/supplemental-commands/webhook-command.js';

describe('webhook command', () => {
  it('shows help with --help', async () => {
    const result = await createWebhookCommand().execute(['--help'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('webhook <command>');
    expect(result.stdout).toContain('--scoop <name>');
  });

  it('shows help when invoked with no arguments', async () => {
    const result = await createWebhookCommand().execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('webhook <command>');
  });

  it('rejects create without --scoop', async () => {
    const result = await createWebhookCommand().execute(['create', '--name', 'test'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--scoop is required');
  });

  it('rejects create with no arguments (no --scoop)', async () => {
    const result = await createWebhookCommand().execute(['create'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--scoop is required');
  });

  it('rejects unknown subcommands', async () => {
    const result = await createWebhookCommand().execute(['bogus'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command "bogus"');
  });

  it('rejects delete without an ID', async () => {
    const result = await createWebhookCommand().execute(['delete'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('delete requires an ID');
  });
});
