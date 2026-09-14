type ShellTelemetrySink = (commandName: string) => void;

let sink: ShellTelemetrySink | null = null;

export function setShellTelemetrySink(fn: ShellTelemetrySink | null): void {
  sink = fn;
}

export function emitShellCommand(commandName: string): void {
  sink?.(commandName);
}
