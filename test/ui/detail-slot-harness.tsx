import { screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DetailSlotProvider, useDetailSlotRef } from '@/components/DetailSlot';

const LABEL = 'painel da página';

// The details panel's side as a page test needs it (#64): a region registered as the slot a page's DetailSlot lands in
function SlotHost() {
  const register = useDetailSlotRef();
  return <section aria-label={LABEL} ref={register} />;
}

/** A page with the panel's slot beside it, as the dock mounts them (#64); usable as Testing Library's `wrapper`. */
export function WithSlot({ children }: { children: ReactNode }) {
  return (
    <DetailSlotProvider>
      {children}
      <SlotHost />
    </DetailSlotProvider>
  );
}

/** Queries inside the slot. */
export const slot = () => within(screen.getByRole('region', { name: LABEL }));
