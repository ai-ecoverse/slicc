import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { resolve } from 'path';
import type { Writable, Readable } from 'stream';

/**
 * Encode a CDP command into a null-byte delimited JSON buffer.
 * Chrome's --remote-debugging-pipe expects messages in this format.
 *
 * @param id - Message ID (typically 1 for synchronous commands)
 * @param method - CDP method name (e.g., "Extensions.loadUnpacked")
 * @param params - Method parameters as an object
 * @returns Buffer containing JSON message followed by null byte
 */
export function encodeCDPMessage(
  id: number,
  method: string,
  params: Record<string, unknown>,
): Buffer {
  const message = {
    id,
    method,
    params,
  };
  const json = JSON.stringify(message);
  return Buffer.from(`${json}\0`, 'utf-8');
}

/**
 * Parse a CDP response from a null-byte delimited JSON buffer.
 * Removes the trailing null byte and attempts to parse as JSON.
 *
 * @param buffer - Raw response buffer from Chrome
 * @returns Parsed response object, or null if parsing fails
 */
export function parseCDPResponse(buffer: Buffer): Record<string, unknown> | null {
  try {
    const text = buffer.toString('utf-8').replace(/\0+$/, '');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read a complete CDP message from a stream with null-byte framing.
 * Buffers data until a null byte is found, then returns the complete message.
 *
 * @param stream - Readable stream to read from
 * @param timeoutMs - Timeout in milliseconds
 * @returns Promise resolving to the complete message buffer (including null byte)
 */
async function readCDPMessage(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        stream.removeListener('data', onData);
        reject(new Error(`Timeout waiting for CDP response (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      if (settled) return;

      chunks.push(chunk);
      const full = Buffer.concat(chunks);
      const nullIndex = full.indexOf(0);

      if (nullIndex !== -1) {
        settled = true;
        clearTimeout(timer);
        stream.removeListener('data', onData);
        resolve(full.subarray(0, nullIndex + 1));
      }
    };

    stream.on('data', onData);

    stream.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    stream.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Stream ended without receiving complete CDP message'));
      }
    });
  });
}

/**
 * Install the SLICC Chrome extension into a Chrome profile via the
 * Chrome DevTools Protocol pipe transport.
 *
 * Uses Chrome's --remote-debugging-pipe flag to communicate via FD 3 (write)
 * and FD 4 (read). Spawns Chrome with the Extensions.loadUnpacked method
 * to load the extension.
 *
 * @param options Configuration for the installation
 * @returns Promise resolving to the installed extension ID, or rejecting on error
 */
export async function installExtension(options: {
  chromePath: string;
  extensionPath: string;
  initializeWaitMs?: number;
  responseTimeoutMs?: number;
}): Promise<string> {
  const chromePath = resolve(options.chromePath);
  const extensionPath = resolve(options.extensionPath);
  const initializeWaitMs = options.initializeWaitMs ?? 3000;
  const responseTimeoutMs = options.responseTimeoutMs ?? 10000;

  // Validate paths exist
  if (!existsSync(chromePath)) {
    throw new Error(`Chrome executable not found: ${chromePath}`);
  }
  if (!existsSync(extensionPath)) {
    throw new Error(`Extension directory not found: ${extensionPath}`);
  }

  // Spawn Chrome with pipe transport and unsafe extension debugging
  const child = spawn(chromePath, [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });

  try {
    // Wait for Chrome to initialize
    await new Promise((resolve) => setTimeout(resolve, initializeWaitMs));

    // Get stdio streams for CDP pipe communication
    // Index 3 is write stream (Chrome reads from FD 3)
    // Index 4 is read stream (Chrome writes to FD 4)
    const writeStream = child.stdio[3] as Writable | null;
    const readStream = child.stdio[4] as Readable | null;

    if (!writeStream || !readStream) {
      throw new Error('Chrome process stdio pipes not available');
    }

    // Send Extensions.loadUnpacked command
    const command = encodeCDPMessage(1, 'Extensions.loadUnpacked', {
      path: extensionPath,
    });

    writeStream.write(command);

    // Read and parse response
    const responseBuffer = await readCDPMessage(readStream as NodeJS.ReadableStream, responseTimeoutMs);
    const response = parseCDPResponse(responseBuffer);

    if (!response) {
      throw new Error('Failed to parse CDP response');
    }

    // Check for error response
    if (response.error) {
      const error = response.error as Record<string, unknown>;
      throw new Error(
        `CDP error: ${error.message ?? 'unknown error'} (code: ${error.code ?? 'unknown'})`,
      );
    }

    // Extract extension ID from result
    const result = response.result as Record<string, unknown> | undefined;
    const extensionId = result?.id;

    if (typeof extensionId !== 'string') {
      throw new Error('CDP response did not include extension ID');
    }

    return extensionId;
  } finally {
    // Kill Chrome process
    child.kill();
  }
}

/**
 * Main entry point for the CLI.
 * Parses command-line arguments and installs the extension.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let chromePath: string | null = null;
  let extensionPath: string | null = null;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--chrome-path' && i + 1 < args.length) {
      chromePath = args[++i]!;
    } else if (arg === '--extension-path' && i + 1 < args.length) {
      extensionPath = args[++i]!;
    } else if (arg.startsWith('--chrome-path=')) {
      chromePath = arg.slice('--chrome-path='.length);
    } else if (arg.startsWith('--extension-path=')) {
      extensionPath = arg.slice('--extension-path='.length);
    }
  }

  if (!chromePath) {
    console.error('Error: --chrome-path is required');
    process.exit(1);
  }

  if (!extensionPath) {
    console.error('Error: --extension-path is required');
    process.exit(1);
  }

  try {
    const extensionId = await installExtension({
      chromePath,
      extensionPath,
    });
    console.log(`Extension installed successfully. ID: ${extensionId}`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

// Run main if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
