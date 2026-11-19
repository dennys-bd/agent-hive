import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect, test } from 'vitest';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// The window header is an Electron drag region (#583) and Electron subtracts every no-drag box from it wherever the box sits in the DOM, so a
// portalled layer needs the rule itself or its clicks over the header drag the window (#908). The selector is read from the stylesheet, so
// the test fails when the rule or one of the primitives' markers goes away.
const css = readFileSync(resolve(process.cwd(), 'src/ui/index.css'), 'utf8');
const rule = /([^{}]+)\{[^{}]*-webkit-app-region:\s*no-drag[^{}]*\}/.exec(css);
const selector = (rule?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

// A layer counts when the element, or an ancestor, is a no-drag box: the ancestor's box covers the element
const noDrag = (el: Element | null): boolean => selector !== '' && el?.closest(selector) != null;

test('index.css has a no-drag rule for floating layers', () => {
  expect(selector).not.toBe('');
});

// First in the file: a menu opened by an earlier test leaves Radix's global layer state such that this one, opened by an event rather than
// a prop, no longer mounts under jsdom.
test('the context menu opens as a no-drag layer', async () => {
  render(
    <ContextMenu><ContextMenuTrigger>area</ContextMenuTrigger>
      <ContextMenuContent><ContextMenuItem>x</ContextMenuItem></ContextMenuContent></ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText('area'));
  expect(noDrag(await screen.findByRole('menuitem', ))).toBe(true);
});

type Case = { name: string; ui: ReactElement; layers: () => HTMLElement[] };
const cases: Case[] = [
  { name: 'select in popper mode', ui: (
    <Select open value="a"><SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent position="popper"><SelectItem value="a">A</SelectItem></SelectContent></Select>
  ), layers: () => [screen.getByRole('listbox')] },
  { name: 'select in item-aligned mode', ui: (
    <Select open value="a"><SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="a">A</SelectItem></SelectContent></Select>
  ), layers: () => [screen.getByRole('listbox')] },
  { name: 'dropdown menu', ui: (
    <DropdownMenu open><DropdownMenuTrigger>t</DropdownMenuTrigger>
      <DropdownMenuContent><DropdownMenuItem>x</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
  ), layers: () => [screen.getByRole('menu')] },
  { name: 'popover', ui: (
    <Popover open><PopoverTrigger>t</PopoverTrigger><PopoverContent>body</PopoverContent></Popover>
  ), layers: () => [screen.getByText('body')] },
  { name: 'command combobox inside a popover', ui: (
    <Popover open><PopoverTrigger>t</PopoverTrigger>
      <PopoverContent><Command><CommandInput /><CommandList><CommandItem>one</CommandItem></CommandList></Command></PopoverContent></Popover>
  ), layers: () => [screen.getByRole('listbox')] },
  { name: 'dialog and its overlay', ui: (
    <Dialog open><DialogContent><DialogTitle>t</DialogTitle><DialogDescription>d</DialogDescription></DialogContent></Dialog>
  ), layers: () => [screen.getByRole('dialog'), document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]') as HTMLElement] },
  { name: 'alert dialog and its overlay', ui: (
    <AlertDialog open><AlertDialogContent><AlertDialogTitle>t</AlertDialogTitle><AlertDialogDescription>d</AlertDialogDescription></AlertDialogContent></AlertDialog>
  ), layers: () => [screen.getByRole('alertdialog'), document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]') as HTMLElement] },
  { name: 'tooltip', ui: (
    <TooltipProvider><Tooltip open><TooltipTrigger>t</TooltipTrigger><TooltipContent>tip</TooltipContent></Tooltip></TooltipProvider>
  ), layers: () => [document.querySelector<HTMLElement>('[data-slot="tooltip-content"]') as HTMLElement] },
];

test.each(cases)('the $name opens as a no-drag layer', ({ ui, layers }) => {
  render(ui);
  for (const layer of layers()) {
    expect(layer).toBeTruthy();
    expect(noDrag(layer)).toBe(true);
  }
});
