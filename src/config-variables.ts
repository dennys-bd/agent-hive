import { isVariableName } from './template.js';
import type { VariableValue } from './types.js';

// A workspace's variables (#621), out of config.ts, which is past 400 lines. Required, {} for none: the boot migration writes the key into a
// file from before it (plugin-variables-migrate.ts). A name is one a template may declare; the value is checked against the templates that
// read it by the lint, not here (decision 6)
const FILE = 'hive.config.json';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isValue = (value: unknown): value is VariableValue => value === null || typeof value === 'string' || typeof value === 'boolean';

export function parseWorkspaceVariables(raw: unknown, field: string): Record<string, VariableValue> {
  const at = `${field}.variables`;
  if (!isRecord(raw)) throw new Error(`${FILE}: "${at}" must be an object of variable values, {} for none (#621)`);
  // fromEntries, never an assignment by key: a name like __proto__ stays an own entry
  return Object.fromEntries(Object.entries(raw).map(([name, value]): [string, VariableValue] => {
    if (!isVariableName(name)) throw new Error(`${FILE}: "${at}.${name}" is not a variable name: a letter or _ followed by letters, digits or _, and never workspace`);
    if (!isValue(value)) throw new Error(`${FILE}: "${at}.${name}" must be a string, true, false or null`);
    return [name, value];
  }));
}
