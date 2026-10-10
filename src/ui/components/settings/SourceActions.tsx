import type { StageSource } from '@/components/settings/StageEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { actionLabel, addableActions, withAction, withoutAction } from '@/lib/settings-stages';
import type { SourceAction } from '../../../types';

// One source's ordered action list (#515, #134): chips with ×, then + ação offering only what keeps the list valid (addableActions), so the
// parser never refuses what the form sends. A stage's onStart and a transition's sources share it.

interface SourceActionsProps { list: SourceAction[]; source: StageSource; onStart: boolean; when: string; onChange(next: SourceAction[]): void }

export function SourceActions({ list, source, onStart, when, onChange }: SourceActionsProps) {
  const offer = addableActions(list, source.type, source.options, onStart);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {list.length === 0 && <span className="text-muted-foreground text-xs">{t('settings.stages.exit.none')}</span>}
      {list.map((a, i) => {
        const label = actionLabel(a);
        return (
          <Badge key={a.type} variant="secondary" className="gap-1">
            {label}
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={t('settings.stages.exit.removeAction', { action: label })} onClick={() => onChange(withoutAction(list, i))}>×</button>
          </Badge>
        );
      })}
      {offer.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" aria-label={t('settings.stages.exit.addTo', { source: source.name, when })}>{t('settings.stages.exit.add')}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {offer.map((a) => <DropdownMenuItem key={actionLabel(a)} onSelect={() => onChange(withAction(list, a))}>{actionLabel(a)}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
