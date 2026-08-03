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

export const nodeOs: NodeOs = {
  tmpdir: () => '/tmp',
  homedir: () => '/home/user',
  platform: () => 'linux',
  arch: () => 'x64',
  EOL: '\n',
  cpus: () => [{ model: 'virtual', speed: 0 }],
  hostname: () => 'slicc',
  type: () => 'Linux',
  release: () => '0.0.0',
};
