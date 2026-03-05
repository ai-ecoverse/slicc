declare const __DEV__: boolean;

declare module 'sql.js/dist/sql-wasm.js' {
  interface SqlJsResultSet {
    columns: string[];
    values: unknown[][];
  }

  interface SqlJsDatabase {
    exec(sql: string): SqlJsResultSet[];
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsModule {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }

  export default function initSqlJs(options?: { locateFile?: (file: string) => string }): Promise<SqlJsModule>;
}
