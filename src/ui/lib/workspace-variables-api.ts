import type { VariableValue } from '../../types.js';
import { sendJson } from './api.js';

/** What PUT and DELETE …/variables/:name answer (#621): the workspace's values after the write. */
export interface VariablesAnswer { variables: Record<string, VariableValue> }

const variablePath = (workspace: string, name: string): string => `/workspaces/${encodeURIComponent(workspace)}/variables/${encodeURIComponent(name)}`;

/** One of a workspace's variables saved by the server (#621): PUT with the value, DELETE when it is undefined. Rejects on a refusal. */
export function writeWorkspaceValue(workspace: string, name: string, value: VariableValue | undefined): Promise<VariablesAnswer> {
  return value === undefined ? sendJson<VariablesAnswer>('DELETE', variablePath(workspace, name)) : sendJson<VariablesAnswer>('PUT', variablePath(workspace, name), { value });
}
