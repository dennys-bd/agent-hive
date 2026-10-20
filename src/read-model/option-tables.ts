import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ReadModel } from './db.js';
import { inTransaction, text } from './sql.js';

// A repository's options for the field editors (#282), and its owner's issue types: each replaced whole by its conditional REST scope and
// compared first, as labels are, so an unchanged 200 writes nothing and the round names no kind
type OptionTables = Pick<ReadModel, 'setAssignees' | 'assignees' | 'setMilestones' | 'milestones' | 'setIssueTypes' | 'issueTypes'>;
interface NamesTable { set(source: string, key: string, names: string[]): boolean; list(source: string, key: string): string[] }

// One table of names under (source, key). Ordered: kept in the given order (an owner's issue types); else read by name as labels is.
// The table and column names are this module's constants, never input
function namesTable(db: DatabaseSync, table: string, key: string, column: string, isOrdered: boolean): NamesTable {
  const list = db.prepare(`SELECT ${column} FROM ${table} WHERE source = ? AND ${key} = ? ORDER BY ${isOrdered ? 'position' : `${column} COLLATE NOCASE`}`);
  const drop = db.prepare(`DELETE FROM ${table} WHERE source = ? AND ${key} = ?`);
  const add = db.prepare(isOrdered ? `INSERT INTO ${table} (source, ${key}, ${column}, position) VALUES (?, ?, ?, ?)` : `INSERT INTO ${table} (source, ${key}, ${column}) VALUES (?, ?, ?)`);
  const read = (source: string, k: string): string[] => list.all(source, k).map((row) => text(row, column));
  const comparable = (names: string[]): string[] => (isOrdered ? names : [...names].sort());
  return {
    list: read,
    set: (source, k, wanted) => {
      const next = [...new Set(wanted)];
      if (isDeepStrictEqual(comparable(next), comparable(read(source, k)))) return false;
      inTransaction(db, () => {
        drop.run(source, k);
        for (const [position, name] of next.entries()) {
          if (isOrdered) add.run(source, k, name, position);
          else add.run(source, k, name);
        }
      });
      return true;
    },
  };
}

export function optionTablesOf(db: DatabaseSync): OptionTables {
  const assignees = namesTable(db, 'repo_assignees', 'repository', 'login', false);
  const milestones = namesTable(db, 'repo_milestones', 'repository', 'title', false);
  const issueTypes = namesTable(db, 'owner_issue_types', 'owner', 'name', true);
  return {
    setAssignees: assignees.set, assignees: assignees.list, setMilestones: milestones.set, milestones: milestones.list,
    setIssueTypes: issueTypes.set, issueTypes: issueTypes.list,
  };
}
