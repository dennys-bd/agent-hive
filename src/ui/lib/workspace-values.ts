import { createContext } from 'react';
import type { RenderWorkspace } from '../../template.js';
import type { WorkspaceVariables } from '../../types.js';

/** Each workspace's variables (#621), as GET /api/lint-input answers them: the "view as" preview, a chain's reach and a passage's render read
 * them. {} until the plugins dock provides the read, so a render with none takes the template's entries and defaults. */
export const WorkspaceValuesContext = createContext<WorkspaceVariables>({});

/** The workspace a render is for, with its values; none for a name the read does not hold. */
export const renderFor = (values: WorkspaceVariables, name: string): RenderWorkspace =>
  ({ name, variables: Object.hasOwn(values, name) ? values[name] : {} });
