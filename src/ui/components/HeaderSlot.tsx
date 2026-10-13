import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIsFlowShown } from '@/components/MainDock';

// The window header's center slot (#295, shaped as DetailSlot #64): the element the header draws while no activity bar holds the column
interface SlotHolder { element: HTMLElement | null; register(element: HTMLElement | null): void }

// undefined outside a provider: a bar rendered alone (the flow's, a page's, in their own tests) stays in place, as FlowShownContext's default
// reads a flow outside a dock as shown
const SlotContext = createContext<SlotHolder | undefined>(undefined);

/** Around the header and the dock (#295): holds the element the header's center column registers, which the flow's bar portals into. */
export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [element, register] = useState<HTMLElement | null>(null);
  const holder = useMemo(() => ({ element, register }), [element]);
  return <SlotContext.Provider value={holder}>{children}</SlotContext.Provider>;
}

/** The header's side (#295): the callback ref for the slot element, null again when it unmounts; undefined outside a provider. */
export const useHeaderSlotRef = (): ((element: HTMLElement | null) => void) | undefined => useContext(SlotContext)?.register;

/** The flow's bar in the window header (#295), portalled so it keeps its owner's state (the search, ↺ loops, ⑂ tree) with nothing lifted.
 * Nothing while no slot is registered (an activity's bar holds the column) or while the flow is hidden under Atividades (#596); in place
 * outside a provider. */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const holder = useContext(SlotContext);
  const isShown = useIsFlowShown();
  if (holder === undefined) return <>{children}</>;
  return holder.element !== null && isShown ? createPortal(children, holder.element) : null;
}
