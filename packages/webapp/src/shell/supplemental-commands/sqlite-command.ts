import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { stdinAsText } from '../just-bash-compat.js';
import {
  formatSqlValue,
  getSqlJs,
  type SqlJsDatabase,
  type SqlJsModule,
  type SqlJsResultSet,
} from './shared.js';

type SqliteCommandName = 'sqlite3' | 'sqllite';

interface SqliteArguments {
  database: string;
  sql: string;
}

function sqliteHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: sqlite3 [database] [sql]\n',
    stderr: '',
    exitCode: 0,
  };
}

function parseArguments(args: string[], ctx: CommandContext): SqliteArguments {
  const hasDatabase = args.length > 0 && !args[0].startsWith('-');
  const database = hasDatabase ? args[0] : ':memory:';
  const sqlArguments = hasDatabase ? args.slice(1) : args;
  return {
    database,
    sql: sqlArguments.join(' ').trim() || stdinAsText(ctx.stdin).trim(),
  };
}

function resolveDatabasePath(database: string, ctx: CommandContext): string {
  return database === ':memory:' ? database : ctx.fs.resolvePath(ctx.cwd, database);
}

async function loadDatabase(
  Sql: SqlJsModule,
  databasePath: string,
  ctx: CommandContext
): Promise<SqlJsDatabase> {
  if (databasePath === ':memory:' || !(await ctx.fs.exists(databasePath))) {
    return new Sql.Database();
  }
  return new Sql.Database(await ctx.fs.readFileBuffer(databasePath));
}

async function persistDatabase(
  database: SqlJsDatabase,
  databasePath: string,
  ctx: CommandContext
): Promise<void> {
  if (databasePath !== ':memory:') {
    await ctx.fs.writeFile(databasePath, database.export());
  }
}

function formatResultSets(resultSets: SqlJsResultSet[]): string {
  const lines = resultSets.flatMap((set) =>
    set.values.map((row) => row.map(formatSqlValue).join('|'))
  );
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

async function executeSql(databaseArgument: string, sql: string, ctx: CommandContext) {
  const SQL = await getSqlJs();
  const databasePath = resolveDatabasePath(databaseArgument, ctx);
  const database = await loadDatabase(SQL, databasePath, ctx);
  const resultSets = database.exec(sql);
  await persistDatabase(database, databasePath, ctx);
  database.close();
  return formatResultSets(resultSets);
}

function errorResult(name: SqliteCommandName, error: unknown) {
  return {
    stdout: '',
    stderr: `${name}: ${error instanceof Error ? error.message : String(error)}\n`,
    exitCode: 1,
  };
}

export function createSqliteCommand(name: SqliteCommandName = 'sqlite3'): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return sqliteHelp();

    const { database, sql } = parseArguments(args, ctx);
    if (!sql) {
      return errorResult(
        name,
        'interactive mode is not supported; provide SQL as argument or stdin'
      );
    }

    try {
      return { stdout: await executeSql(database, sql, ctx), stderr: '', exitCode: 0 };
    } catch (error) {
      return errorResult(name, error);
    }
  });
}
