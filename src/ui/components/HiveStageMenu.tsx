import { CheckIcon } from 'lucide-react';
import { Fragment } from 'react';
import type { Flow, Task } from '../../types';
import { act } from '@/components/actions';
import { FieldCell } from '@/components/FieldCell';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';

export interface HiveStageMenuProps { task: Task; flows: readonly Flow[] }

// An entry with ✓ on muted when it is the task's place, as the status and group menus mark theirs
function Entry({ label, isCurrent, onSelect }: { label: string; isCurrent: boolean; onSelect(): void }) {
  return (
    <DropdownMenuItem role="menuitemradio" aria-checked={isCurrent} onSelect={onSelect} className={isCurrent ? 'bg-muted' : undefined}>
      <CheckIcon aria-hidden="true" className={`size-3.5 ${isCurrent ? '' : 'invisible'}`} />
      <span className="flex-1 truncate">{label}</span>
    </DropdownMenuItem>
  );
}

/** The hive table's status cell (#583 decision 4): every stage, grouped under its flow in the config's order, then sem fluxo. A stage posts
 * move-to, sem fluxo leave-flow: the card menu's two routes, so their rules (a running stage, an epic) stay theirs, and a refusal is act's
 * toast. The current entry does nothing. A stageless task reads —, as an unset Status does; the next state event redraws the row. */
export function HiveStageMenu({ task, flows }: HiveStageMenuProps) {
  const path = (route: string): string => `/tasks/${encodeURIComponent(task.item.itemId)}/${route}`;
  const choose = (stage: string | undefined): void => {
    if (stage === task.stage) return;
    void (stage === undefined ? act(path('leave-flow')) : act(path('move-to'), { stage }));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FieldCell><span className="truncate">{task.stage ?? '—'}</span></FieldCell>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        {flows.map((flow) => (
          <Fragment key={flow.name}>
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">{flow.name}</DropdownMenuLabel>
            {flow.stages.map((s) => <Entry key={s.name} label={s.name} isCurrent={s.name === task.stage} onSelect={() => choose(s.name)} />)}
          </Fragment>
        ))}
        <DropdownMenuSeparator />
        <Entry label={t('project.noFlow')} isCurrent={task.stage === undefined} onSelect={() => choose(undefined)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
