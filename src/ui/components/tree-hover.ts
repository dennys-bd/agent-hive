import { createContext } from 'react';

/** The task whose row the details' tree section has under the pointer (#36), and how the section sets it: the flow's card of that task lights
 * up. Outside a Dashboard (a test, a lone panel or card) no task is hovered and the setter does nothing. */
export interface TreeHover { hoveredId?: string; setHoveredId(id: string | undefined): void }

export const TreeHoverContext = createContext<TreeHover>({ setHoveredId: () => {} });
