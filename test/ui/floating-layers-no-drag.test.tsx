import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect, test } from 'vitest';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { noDrag, selector } from './no-drag-selector.js';


test('index.css has a no-drag rule for floating layers', () => {
  expect(selector).not.toBe('');
});

type Case = { name: string; ui: ReactElement; layers: () => (Element | null)[] };
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
  ), layers: () => [screen.getByRole('dialog'), document.querySelector('[data-slot="dialog-overlay"]')] },
  { name: 'alert dialog and its overlay', ui: (
    <AlertDialog open><AlertDialogContent><AlertDialogTitle>t</AlertDialogTitle><AlertDialogDescription>d</AlertDialogDescription></AlertDialogContent></AlertDialog>
  ), layers: () => [screen.getByRole('alertdialog'), document.querySelector('[data-slot="alert-dialog-overlay"]')] },
  { name: 'tooltip', ui: (
    <TooltipProvider><Tooltip open><TooltipTrigger>t</TooltipTrigger><TooltipContent>tip</TooltipContent></Tooltip></TooltipProvider>
  ), layers: () => [document.querySelector('[data-slot="tooltip-content"]')] },
];

test.each(cases)('the $name opens as a no-drag layer', ({ ui, layers }) => {
  render(ui);
  for (const layer of layers()) {
    expect(layer).not.toBeNull();
    expect(noDrag(layer)).toBe(true);
  }
});
