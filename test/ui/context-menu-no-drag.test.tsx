import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { noDrag } from './no-drag-selector.js';

// A file of its own (#908): after a menu or select opened by an earlier test, Radix's module-level layer state keeps this event-opened menu
// from mounting under jsdom, and vitest isolates modules per file.
test('the context menu opens as a no-drag layer', async () => {
  render(
    <ContextMenu><ContextMenuTrigger>area</ContextMenuTrigger>
      <ContextMenuContent><ContextMenuItem>x</ContextMenuItem></ContextMenuContent></ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText('area'));
  expect(noDrag(await screen.findByRole('menuitem'))).toBe(true);
});
