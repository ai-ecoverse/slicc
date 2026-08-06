import type { Express } from 'express';

export const AGENT_ACTIVITY_WINDOW_MS = 60_000;

export class AgentActivityTracker {
  private lastActivityAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  recordActivity(): void {
    this.lastActivityAt = this.now();
  }

  isActiveInLastMinute(): boolean {
    return (
      this.lastActivityAt !== undefined &&
      this.now() - this.lastActivityAt <= AGENT_ACTIVITY_WINDOW_MS
    );
  }
}

export function registerAgentActivityRoute(app: Express, tracker: AgentActivityTracker): void {
  app.get('/api/agent-activity', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ activeInLastMinute: tracker.isActiveInLastMinute() });
  });
}
