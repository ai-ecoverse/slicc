let instanceId: string | null = null;

export function bindMcpServeInstance(id: string | null | undefined): void {
  instanceId = id ?? null;
}

export function mcpServeInstanceId(): string | null {
  return instanceId;
}
