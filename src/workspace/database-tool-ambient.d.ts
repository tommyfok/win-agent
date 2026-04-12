/**
 * Ambient types so `database-tool.template.ts` typechecks in this repo without Bun's own typings.
 * The deployed tool runs under Bun or Node (better-sqlite3).
 */
declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all: (...args: unknown[]) => unknown[];
      get: (...args: unknown[]) => unknown;
      run: (...args: unknown[]) => { lastInsertRowid: bigint | number; changes: number };
    };
  }
}
