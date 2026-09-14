import type { ChatMessage } from '@slicc/shared-ts';

export type {
  ChatCompactionMarker,
  ChatMessage,
  CompactionMarkerState,
  CompactionMarkerTrigger,
  LickState,
  MessageRole,
  ToolCall,
} from '@slicc/shared-ts';

export interface Session {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
