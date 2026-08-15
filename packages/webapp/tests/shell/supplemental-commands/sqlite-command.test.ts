import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteCommand } from '../../../src/shell/supplemental-commands/sqlite-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const { database, Database } = vi.hoisted(() => {
  const databaseMock = {
    exec: vi.fn(),
    export: vi.fn(),
    close: vi.fn(),
  };
  return {
    database: databaseMock,
    Database: vi.fn(function Database() {
      return databaseMock;
    }),
  };
});

vi.mock('../../../src/shell/supplemental-commands/shared.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/shell/supplemental-commands/shared.js')>();
  return {
    ...original,
    getSqlJs: vi.fn().mockResolvedValue({ Database }),
  };
});

function context(options: { stdin?: string; exists?: boolean; databaseBytes?: Uint8Array } = {}) {
  return mockCommandContext({
    cwd: '/work',
    stdin: options.stdin,
    fs: {
      exists: vi.fn().mockResolvedValue(options.exists ?? false),
      readFileBuffer: vi.fn().mockResolvedValue(options.databaseBytes ?? new Uint8Array()),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  });
}

describe('sqlite command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.exec.mockReturnValue([]);
    database.export.mockReturnValue(new Uint8Array([9, 8, 7]));
  });

  it.each(['sqlite3', 'sqllite'] as const)('shows help for %s', async (name) => {
    const result = await createSqliteCommand(name).execute(['--help'], context());

    expect(result).toEqual({
      stdout: 'usage: sqlite3 [database] [sql]\n',
      stderr: '',
      exitCode: 0,
    });
  });

  it('executes SQL supplied in arguments and formats result rows', async () => {
    database.exec.mockReturnValue([
      { columns: ['value', 'empty', 'blob'], values: [[42, null, new Uint8Array([10, 255])]] },
    ]);

    const result = await createSqliteCommand().execute([':memory:', 'select', '42'], context());

    expect(database.exec).toHaveBeenCalledWith('select 42');
    expect(result).toEqual({ stdout: "42||x'0aff'\n", stderr: '', exitCode: 0 });
  });

  it('executes SQL supplied on stdin', async () => {
    const result = await createSqliteCommand().execute([], context({ stdin: ' select 1; \n' }));

    expect(database.exec).toHaveBeenCalledWith('select 1;');
    expect(result.exitCode).toBe(0);
  });

  it('rejects empty SQL because interactive mode is unsupported', async () => {
    const result = await createSqliteCommand('sqllite').execute([], context({ stdin: '  ' }));

    expect(result).toEqual({
      stdout: '',
      stderr: 'sqllite: interactive mode is not supported; provide SQL as argument or stdin\n',
      exitCode: 1,
    });
    expect(Database).not.toHaveBeenCalled();
  });

  it('keeps in-memory databases out of the filesystem', async () => {
    const ctx = context();

    await createSqliteCommand().execute([':memory:', 'select 1'], ctx);

    expect(ctx.fs.exists).not.toHaveBeenCalled();
    expect(ctx.fs.writeFile).not.toHaveBeenCalled();
    expect(Database).toHaveBeenCalledWith();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('loads and persists file-backed databases', async () => {
    const existingBytes = new Uint8Array([1, 2, 3]);
    const exportedBytes = new Uint8Array([9, 8, 7]);
    database.export.mockReturnValue(exportedBytes);
    const ctx = context({ exists: true, databaseBytes: existingBytes });

    await createSqliteCommand().execute(['data.sqlite', 'select 1'], ctx);

    expect(ctx.fs.readFileBuffer).toHaveBeenCalledWith('/work/data.sqlite');
    expect(Database).toHaveBeenCalledWith(existingBytes);
    expect(ctx.fs.writeFile).toHaveBeenCalledWith('/work/data.sqlite', exportedBytes);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('returns an error when database execution throws', async () => {
    database.exec.mockImplementation(() => {
      throw new Error('bad SQL');
    });

    const result = await createSqliteCommand().execute([':memory:', 'broken'], context());

    expect(result).toEqual({ stdout: '', stderr: 'sqlite3: bad SQL\n', exitCode: 1 });
  });
});
