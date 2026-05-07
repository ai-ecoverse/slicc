import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IFileSystem } from 'just-bash';

vi.mock('../../../src/ui/provider-settings.js', () => ({
  getApiKeyForProvider: vi.fn(),
  getRawApiKeyForProvider: vi.fn(),
  getBaseUrlForProvider: vi.fn(),
  addAccount: vi.fn(),
}));

vi.mock('../../../src/providers/built-in/local-llm.js', () => ({
  verifyConnection: vi.fn(),
  // The command imports `config.id` for the provider ID, so the mock
  // must surface a `config` export with the matching id.
  config: { id: 'local-llm' },
}));

import { createLocalLlmCommand } from '../../../src/shell/supplemental-commands/local-llm-command.js';
import {
  getApiKeyForProvider,
  getRawApiKeyForProvider,
  getBaseUrlForProvider,
  addAccount,
} from '../../../src/ui/provider-settings.js';
import { verifyConnection } from '../../../src/providers/built-in/local-llm.js';

const mockGetApiKey = vi.mocked(getApiKeyForProvider);
const mockGetRawApiKey = vi.mocked(getRawApiKeyForProvider);
const mockGetBaseUrl = vi.mocked(getBaseUrlForProvider);
const mockAddAccount = vi.mocked(addAccount);
const mockVerify = vi.mocked(verifyConnection);

function createMockCtx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };
  return {
    fs: fs as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

describe('local-llm command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct name', () => {
    expect(createLocalLlmCommand().name).toBe('local-llm');
  });

  it('shows help with --help', async () => {
    const result = await createLocalLlmCommand().execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('local-llm');
    expect(result.stdout).toContain('discover');
  });

  it('errors when base URL is not configured', async () => {
    mockGetBaseUrl.mockReturnValue(null);
    const result = await createLocalLlmCommand().execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not configured');
  });

  it('rejects unknown subcommands', async () => {
    mockGetBaseUrl.mockReturnValue('http://localhost:11434/v1');
    const result = await createLocalLlmCommand().execute(['nonsense'], createMockCtx());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown subcommand');
  });

  it('status reports a successful verification', async () => {
    mockGetBaseUrl.mockReturnValue('http://localhost:11434/v1');
    mockGetApiKey.mockReturnValue(null);
    mockVerify.mockResolvedValue({
      ok: true,
      runtime: { kind: 'ollama', version: '0.5.4' },
      models: ['llama3.1:8b', 'qwen2.5-coder:14b'],
    });
    const result = await createLocalLlmCommand().execute(['status'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ollama');
    expect(result.stdout).toContain('llama3.1:8b');
    expect(mockAddAccount).not.toHaveBeenCalled();
  });

  it('status surfaces hint on Ollama CORS error', async () => {
    mockGetBaseUrl.mockReturnValue('http://localhost:11434/v1');
    mockGetApiKey.mockReturnValue(null);
    mockVerify.mockResolvedValue({
      ok: false,
      runtime: { kind: 'ollama' },
      models: [],
      error: { kind: 'cors', message: 'Failed to fetch', hint: 'Set OLLAMA_ORIGINS=*' },
    });
    const result = await createLocalLlmCommand().execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OLLAMA_ORIGINS');
  });

  it('discover writes the model list back to Settings', async () => {
    mockGetBaseUrl.mockReturnValue('http://localhost:1234/v1');
    mockGetApiKey.mockReturnValue('lm-studio');
    mockGetRawApiKey.mockReturnValue('lm-studio');
    mockVerify.mockResolvedValue({
      ok: true,
      runtime: { kind: 'lmstudio' },
      models: ['qwen2.5-coder-14b', 'llama-3.2-3b'],
    });
    const result = await createLocalLlmCommand().execute(['discover'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(mockAddAccount).toHaveBeenCalledWith(
      'local-llm',
      'lm-studio',
      'http://localhost:1234/v1',
      'qwen2.5-coder-14b, llama-3.2-3b'
    );
    expect(result.stdout).toContain('Saved 2 models');
  });

  it('discover does NOT persist the optionalApiKey placeholder back into Settings', async () => {
    // Regression for the P1 review finding: previously the discover path
    // read through getApiKeyForProvider, which returns the literal 'local'
    // when no key is stored. That value got written into account.apiKey,
    // shadowing the placeholder fallback and pre-populating the Settings
    // input field with garbage. Now we must use getRawApiKeyForProvider
    // (which returns null for an empty stored key) so the empty stays empty.
    mockGetBaseUrl.mockReturnValue('http://localhost:11434/v1');
    mockGetApiKey.mockReturnValue('local'); // what the placeholder would produce
    mockGetRawApiKey.mockReturnValue(null); // ground truth: nothing stored
    mockVerify.mockResolvedValue({
      ok: true,
      runtime: { kind: 'ollama' },
      models: ['llama3.1:8b'],
    });

    await createLocalLlmCommand().execute(['discover'], createMockCtx());

    expect(mockAddAccount).toHaveBeenCalledWith(
      'local-llm',
      '', // crucial: empty string, NOT 'local'
      'http://localhost:11434/v1',
      'llama3.1:8b'
    );
  });

  it('discover does not write when verification fails', async () => {
    mockGetBaseUrl.mockReturnValue('http://localhost:11434/v1');
    mockGetApiKey.mockReturnValue(null);
    mockGetRawApiKey.mockReturnValue(null);
    mockVerify.mockResolvedValue({
      ok: false,
      runtime: { kind: 'ollama' },
      models: [],
      error: { kind: 'connection', message: 'connect ECONNREFUSED' },
    });
    const result = await createLocalLlmCommand().execute(['discover'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(mockAddAccount).not.toHaveBeenCalled();
  });
});
