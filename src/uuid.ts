// The uuid shape of the Hive's own ids (randomUUID): a run's, a terminal's, and a session id the Hive generated (#647). Boot hands a run id
// to `pkill -f`, which matches a pattern anywhere in a command line: stricter than SESSION_ID on purpose, since a plain id that passes that
// one can still be a substring shared by processes this worker does not own. Its own module (#347): shim.ts reads it, and the reducer reaches
// shim.ts through spawn.ts.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `value` has the uuid shape: a restored run can be managed by it, so boot's kill pattern is only ever that, and a session id the
 * Hive keeps is checked the same way (#647). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
