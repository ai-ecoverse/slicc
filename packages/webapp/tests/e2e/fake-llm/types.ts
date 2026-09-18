export interface ToolCallFixture {
  id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export type UserMessageMatcher = string | RegExp | { pattern: string; flags?: string };

export interface AssistantTurn {
  content?: string;
  tool_calls?: ToolCallFixture[];

  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {});

  whenUserMessageMatches?: UserMessageMatcher;

  contentChunkSize?: number;

  toolArgumentsChunkSize?: number;

  holdAfterContentChunks?: number;
}

export interface Fixture {
  model: string;

  models?: string[];
  turns: AssistantTurn[];

  onOverflow?: 'error' | 'repeat-last';
}
