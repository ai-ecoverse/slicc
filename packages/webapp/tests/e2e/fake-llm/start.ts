import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { startFakeLlmServer } from './server.js';
import type { Fixture } from './types.js';

interface CliArgs {
  fixture?: string;
  port?: number;
  host?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture' && argv[i + 1]) {
      out.fixture = argv[++i];
    } else if (arg === '--port' && argv[i + 1]) {
      out.port = Number(argv[++i]);
    } else if (arg === '--host' && argv[i + 1]) {
      out.host = argv[++i];
    } else if (arg?.startsWith('--fixture=')) {
      out.fixture = arg.slice('--fixture='.length);
    } else if (arg?.startsWith('--port=')) {
      out.port = Number(arg.slice('--port='.length));
    } else if (arg?.startsWith('--host=')) {
      out.host = arg.slice('--host='.length);
    }
  }
  return out;
}

function loadFixture(path: string): Fixture {
  const abs = resolvePath(process.cwd(), path);
  const raw = readFileSync(abs, 'utf8');
  return JSON.parse(raw) as Fixture;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = args.fixture ?? process.env['FAKE_LLM_FIXTURE'];
  if (!fixturePath) {
    process.stderr.write(
      'fake-llm: no fixture supplied. Pass --fixture <path> or set FAKE_LLM_FIXTURE.\n'
    );
    process.exit(2);
  }
  const port = args.port ?? Number(process.env['FAKE_LLM_PORT'] ?? 5781);
  const host = args.host ?? process.env['FAKE_LLM_HOST'] ?? '127.0.0.1';

  const fixture = loadFixture(fixturePath);
  const server = await startFakeLlmServer({ fixture, port, host });
  process.stdout.write(`fake-llm: listening on ${server.url} (model=${fixture.model})\n`);

  const shutdown = async (signal: string) => {
    process.stdout.write(`fake-llm: ${signal} received, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((err) => {
  process.stderr.write(`fake-llm: fatal: ${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
