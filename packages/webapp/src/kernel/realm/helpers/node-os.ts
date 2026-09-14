import { scratchDir } from '../../../shell/tmpdir-env.js';

export interface NodeOs {
  tmpdir(): string;
  homedir(): string;
  platform(): string;
  arch(): string;
  EOL: string;
  cpus(): { model: string; speed: number }[];
  hostname(): string;
  type(): string;
  release(): string;
}

export const DEFAULT_HOME = '/home/user';

const STATIC_OS = {
  platform: () => 'linux',
  arch: () => 'x64',
  EOL: '\n',
  cpus: () => [{ model: 'virtual', speed: 0 }],
  hostname: () => 'slicc',
  type: () => 'Linux',
  release: () => '0.0.0',
} as const;

export function createNodeOs(env?: Record<string, string>): NodeOs {
  return {
    ...STATIC_OS,
    tmpdir: () => scratchDir(env),

    homedir: () => (env?.['HOME']?.trim() ? env['HOME'] : DEFAULT_HOME),
  };
}

export const nodeOs: NodeOs = createNodeOs();
