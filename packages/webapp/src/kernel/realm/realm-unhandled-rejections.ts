import { NodeExitError } from './realm-node-shims.js';

type RejectionTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface UnhandledRejectionWatch {
  readonly fatal: Promise<void>;
  dispose(): void;
}

export interface UnhandledRejectionOptions {
  writeStderr: (value: unknown) => void;

  didExit: () => boolean;

  recordExit: (code: number) => void;
}

export function formatUnhandledRejection(reason: unknown): string {
  if (reason instanceof Error) return `${reason.stack ?? `${reason.name}: ${reason.message}`}\n`;
  return `Uncaught ${typeof reason === 'string' ? `'${reason}'` : String(reason)}\n`;
}

export function watchUnhandledRejections(
  target: Partial<RejectionTarget>,
  options: UnhandledRejectionOptions
): UnhandledRejectionWatch {
  let resolveFatal: () => void = () => undefined;
  const fatal = new Promise<void>((resolve) => {
    resolveFatal = resolve;
  });
  if (typeof target.addEventListener !== 'function') {
    return { fatal, dispose: () => undefined };
  }
  const listener = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason;

    event.preventDefault();

    if (reason instanceof NodeExitError || options.didExit()) return;
    options.writeStderr(formatUnhandledRejection(reason));
    options.recordExit(1);
    resolveFatal();
  };
  target.addEventListener('unhandledrejection', listener);
  return {
    fatal,
    dispose: () => target.removeEventListener?.('unhandledrejection', listener),
  };
}
