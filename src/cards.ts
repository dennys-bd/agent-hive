import type { Column } from './types.js';

/** A board column the config mentions and the Hive column + field that cites it, for error messages. */
export interface Citation {
  column: string;
  by: string;
}

/** Every board column the config cites, once each, first citation wins: what the adapters validate and list. */
export function citedColumns(columns: Column[]): Citation[] {
  const seen = new Set<string>();
  return columns.flatMap((c) => {
    const mentions: [string, string | undefined][] = [...c.from.map((f): [string, string] => ['from', f]), ['onStart', c.onStart], ['onFinish', c.onFinish]];
    return mentions.flatMap(([field, column]) => {
      if (column === undefined || seen.has(column)) return [];
      seen.add(column);
      return [{ column, by: `${c.name}.${field}` }];
    });
  });
}
