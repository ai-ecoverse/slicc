declare const __DEV__: boolean;
declare const __SLICC_VERSION__: string;
declare const __SLICC_RELEASED_AT__: string | null;

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

  export default function initSqlJs(options?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsModule>;
}
