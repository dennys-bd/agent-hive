import { EllipsisIcon } from 'lucide-react';
import { differsFromSource } from '../../tasks';
import type { State } from '../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';

interface StageMenuProps { stage: string; state: State; filtered: boolean; onFilter(): void; onClearFilter(): void }

// The stage's actions behind a kebab, on every stage so the menu has a fixed place; reset is disabled while the stage already
// follows the flow (#141). Filtrar… asks the flow to open the view filter's dialog (#374), which it renders beside every menu: an item's
// onSelect closes the menu and would unmount a dialog inside it. Limpar filtro shows only while the stage has a rule.
export function StageMenu({ stage, state, filtered, onFilter, onClearFilter }: StageMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t('stage.actions')}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={!differsFromSource(state.tasks, stage, state.sourceOrder, state)}
          onSelect={() => act(`/stages/${encodeURIComponent(stage)}/reset-order`)}
        >
          {t('stage.resetSourceOrder')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onFilter}>{t('stage.filter')}</DropdownMenuItem>
        {filtered && <DropdownMenuItem onSelect={onClearFilter}>{t('stage.clearFilter')}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
