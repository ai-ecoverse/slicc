import type { Context, TranscriptContext } from '@earendil-works/pi-ai';
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
} from '@earendil-works/pi-ai/utils/transcript';

export function toPiTranscriptContext(context: Context | TranscriptContext): TranscriptContext {
  return 'systemPrompt' in context || 'tools' in context
    ? normalizeContext(context as Context)
    : (context as TranscriptContext);
}

export function toLegacyPiContext(context: Context | TranscriptContext): Context {
  if ('systemPrompt' in context || 'tools' in context) return context as Context;
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages),
    messages: context.messages.filter((message) => message.role !== 'system'),
  };
}
