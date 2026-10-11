import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIsFlowShown } from '@/components/MainDock';

// The details panel's slot (#64, contract ui.detail-page): the element the panel draws for a page's block, and how the panel registers it
interface SlotHolder { element: HTMLElement | null; register(element: HTMLElement | null): void }

const SlotContext = createContext<SlotHolder>({ element: null, register: () => {} });

/** Around the dock (#64): holds the element the details panel registers, which a page's DetailSlot portals into. */
export function DetailSlotProvider({ children }: { children: ReactNode }) {
  const [element, register] = useState<HTMLElement | null>(null);
  const holder = useMemo(() => ({ element, register }), [element]);
  return <SlotContext.Provider value={holder}>{children}</SlotContext.Provider>;
}

/** The panel's side (#64): the callback ref for the element a page's block lands in; null again when that element unmounts. */
export const useDetailSlotRef = (): ((element: HTMLElement | null) => void) => useContext(SlotContext).register;

/** A page's block in the details panel (#64), portalled so it keeps the page's own read and reload: one read, and a write on either side
 * reloads both. Nothing while no slot is mounted, or while the flow is hidden under Atividades (#596), where the panel shows the selection. */
export function DetailSlot({ children }: { children: ReactNode }) {
  const { element } = useContext(SlotContext);
  const isShown = useIsFlowShown();
  return element !== null && isShown ? createPortal(children, element) : null;
}

/** A block's title at the panel's 15px/600 (#64): the task's in the panel, or the page's own when the page has no task. */
export function SlotTitle({ children }: { children: ReactNode }) {
  return <h2 className="break-words font-semibold text-[15px] text-foreground leading-5">{children}</h2>;
}
