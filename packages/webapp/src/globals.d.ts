declare const __DEV__: boolean;
declare const __SLICC_EXT_DEV__: boolean;
declare const __SLICC_VERSION__: string;
declare const __SLICC_RELEASED_AT__: string | null;
// Wasm dependency versions baked from packages/webapp/package.json at build
// time (Vite `define` / vitest `define`). See the wasm-wrapping commands that
// derive their `ipk add <pkg>@<version>` guidance from these.
declare const __MAGICK_WASM_VERSION__: string;
declare const __BIOME_WASM_WEB_VERSION__: string;
declare const __BIOME_JS_API_VERSION__: string;
declare const __FFMPEG_CORE_VERSION__: string;

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
