import { createContext } from 'react';
import { NO_BUILT_INS, type RenderWorkspace } from '../../template.js';
import type { LintInputRead } from '../../types.js';

/** What a render in the editor reads beside the text (#621, #742): each workspace's variables and built-ins, as GET /api/lint-input answers them. */
export type WorkspaceRenders = Pick<LintInputRead, 'variables' | 'builtIns'>;

/** The "view as" preview, a chain's reach and a passage's render read it. Empty until the plugins dock provides the read, so a render with
 * none takes the template's entries and defaults, and no workspace's Settings. */
export const WorkspaceValuesContext = createContext<WorkspaceRenders>({ variables: {}, builtIns: {} });

/** The workspace a render is for, with its values and built-ins; none for a name the read does not hold. */
export const renderFor = (values: WorkspaceRenders, name: string): RenderWorkspace => ({
  name,
  variables: Object.hasOwn(values.variables, name) ? values.variables[name] : {},
  builtIns: Object.hasOwn(values.builtIns, name) ? values.builtIns[name] : NO_BUILT_INS,
});
