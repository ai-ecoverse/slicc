export interface DiscoveredSkill {
  name: string;

  source: 'native' | 'agents' | 'claude' | 'marketplace' | 'plugin';

  sourceRoot: string;

  path: string;

  skillFilePath?: string;

  description: string;

  shadowedPaths?: string[];
}
