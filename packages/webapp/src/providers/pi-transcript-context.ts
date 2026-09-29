import type { Context, TranscriptContext } from '@earendil-works/pi-ai';
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
} from '@earendil-works/pi-ai/utils/transcript';

/** Pi 0.86+ passes normalized transcripts to providers; direct SLICC calls may still use Context. */
export function toPiTranscriptContext(context: Context | TranscriptContext): TranscriptContext {
  return 'systemPrompt' in context || 'tools' in context
    ? normalizeContext(context as Context)
    : (context as TranscriptContext);
}

/** Adapt a normalized transcript for SLICC providers that build their own wire payloads. */
export function toLegacyPiContext(context: Context | TranscriptContext): Context {
  if ('systemPrompt' in context || 'tools' in context) return context as Context;
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages),
    messages: context.messages.filter((message) => message.role !== 'system'),
  };
}
