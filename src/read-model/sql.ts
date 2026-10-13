import type { SQLOutputValue } from 'node:sqlite';

// What every table's code reads a row with (#178, #186): shared by db.ts and pull-tables.ts

/** A row as node:sqlite answers it. */
export type Row = Record<string, SQLOutputValue>;
export const text = (row: Row, key: string): string => String(row[key]);
export const nullable = (row: Row, key: string): string | null => (row[key] === null ? null : String(row[key]));
export const written = (result: { changes: number | bigint }): boolean => Number(result.changes) > 0;
