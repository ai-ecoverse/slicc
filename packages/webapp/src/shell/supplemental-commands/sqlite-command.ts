import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { formatSqlValue, getSqlJs } from './shared.js';

function sqliteHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: sqlite3 [database] [sql]\n',
    stderr: '',
    exitCode: 0,
  };
}

export function createSqliteCommand(name: 'sqlite3' | 'sqllite' = 'sqlite3'): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return sqliteHelp();

    let dbArg = ':memory:';
    let sqlArgv = args;
    if (args.length > 0 && !args[0].startsWith('-')) {
      dbArg = args[0];
      sqlArgv = args.slice(1);
    }

    const sql = sqlArgv.join(' ').trim() || ctx.stdin.trim();
    if (!sql) {
      return {
        stdout: '',
        stderr: `${name}: interactive mode is not supported; provide SQL as argument or stdin\n`,
        exitCode: 1,
      };
    }

    try {
      const SQL = await getSqlJs();
      const isMemory = dbArg === ':memory:';
      const dbPath = isMemory ? ':memory:' : ctx.fs.resolvePath(ctx.cwd, dbArg);

      let dbBytes: Uint8Array | undefined;
      if (!isMemory && (await ctx.fs.exists(dbPath))) {
        dbBytes = await ctx.fs.readFileBuffer(dbPath);
      }

      const db = dbBytes ? new SQL.Database(dbBytes) : new SQL.Database();
      const resultSets = db.exec(sql);

      if (!isMemory) {
        await ctx.fs.writeFile(dbPath, db.export());
      }
      db.close();

      const lines: string[] = [];
      for (const set of resultSets) {
        for (const row of set.values) {
          lines.push(row.map(formatSqlValue).join('|'));
        }
      }

      return {
        stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
        stderr: '',
        exitCode: 0,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
