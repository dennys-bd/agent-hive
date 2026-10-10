import type { ComponentType, ReactNode } from 'react';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu';

interface ItemProps { className?: string; disabled?: boolean; role?: string; 'aria-checked'?: boolean; onSelect?(event: Event): void; children?: ReactNode }

/** The menu primitives a list of items renders with (#536): a right-click's or a dropdown's. Radix gives both the same props, so one list
 * serves an activity's right-click and the bar's ⋯, and the two never drift. */
export interface MenuKit {
  Item: ComponentType<ItemProps>;
  Separator: ComponentType;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; disabled?: boolean; children?: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children?: ReactNode }>;
}

export const CONTEXT_KIT: MenuKit = { Item: ContextMenuItem, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent };
export const DROPDOWN_KIT: MenuKit = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent };
