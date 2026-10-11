import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { DetailSlot, DetailSlotProvider, SlotTitle } from '@/components/DetailSlot';
import { FlowShownContext } from '@/components/MainDock';
import { slot, WithSlot } from './detail-slot-harness';

test('a page\'s block lands in the slot the panel registered (#64)', () => {
  render(<WithSlot><DetailSlot><SlotTitle>Pager breaks</SlotTitle><p>BLOCK</p></DetailSlot></WithSlot>);
  expect(slot().getByRole('heading', { name: 'Pager breaks' })).toHaveClass('font-semibold', 'text-[15px]');
  expect(slot().getByText('BLOCK')).toBeInTheDocument();
});

test('with no slot registered, or no provider at all, the block renders nowhere (#64)', () => {
  const { unmount } = render(<DetailSlotProvider><DetailSlot><p>BLOCK</p></DetailSlot></DetailSlotProvider>);
  expect(screen.queryByText('BLOCK')).not.toBeInTheDocument();
  unmount();
  render(<DetailSlot><p>BLOCK</p></DetailSlot>);
  expect(screen.queryByText('BLOCK')).not.toBeInTheDocument();
});

test('while the flow is hidden under Atividades the block renders nowhere, and lands again once the flow shows (#64, #596)', () => {
  const page = (isShown: boolean) => (
    <WithSlot><FlowShownContext.Provider value={isShown}><DetailSlot><p>BLOCK</p></DetailSlot></FlowShownContext.Provider></WithSlot>
  );
  const { rerender } = render(page(false));
  expect(screen.queryByText('BLOCK')).not.toBeInTheDocument();
  rerender(page(true));
  expect(slot().getByText('BLOCK')).toBeInTheDocument();
});
