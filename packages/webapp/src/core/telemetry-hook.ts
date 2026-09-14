export type AgentErrorSource = 'llm' | 'tool';

export type AgentErrorTelemetrySink = (source: AgentErrorSource, details: unknown) => void;

let sink: AgentErrorTelemetrySink | null = null;

export function setAgentErrorTelemetrySink(fn: AgentErrorTelemetrySink | null): void {
  sink = fn;
}

export function emitAgentError(source: AgentErrorSource, details: unknown): void {
  sink?.(source, details);
}
