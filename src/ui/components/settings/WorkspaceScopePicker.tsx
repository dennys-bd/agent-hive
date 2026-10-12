import { ChevronDownIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { toggleScope } from '@/lib/settings-languages';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { inScope } from '../../../languages';
import type { WorkspaceScope } from '../../../types';

interface WorkspaceScopePickerProps { label: string; scope: WorkspaceScope; names: readonly string[]; onChange(scope: WorkspaceScope): void }

function Chips({ scope, names }: Pick<WorkspaceScopePickerProps, 'scope' | 'names'>) {
  if (scope === 'all') return <Badge variant="secondary">{t('settings.scope.all')}</Badge>;
  const shown = names.filter((name) => scope.includes(name));
  if (shown.length === 0) return <Badge variant="secondary">{t('settings.scope.none')}</Badge>;
  return <>{shown.map((name) => <Badge key={name} variant="secondary" className="gap-1.5"><WorkspaceSquare name={name} />{name}</Badge>)}</>;
}

/** Which workspaces an editor setting is on in (#780): todos
 os workspaces is 'all', which the
 * workspaces added later join; ticking every one by hand stays a list. The menu stays open while ticking. */
export function WorkspaceScopePicker({ label, scope, names, onChange }: WorkspaceScopePickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={label} className="h-auto min-h-8 w-full flex-wrap justify-start gap-1 px-1.5 py-1">
          <Chips scope={scope} names={names} />
          <ChevronDownIcon aria-hidden className="ml-auto text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuCheckboxItem checked={scope === 'all'} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => onChange(on ? 'all' : [])}>{t('settings.scope.all')}</DropdownMenuCheckboxItem>
        {names.map((name) => (
          <DropdownMenuCheckboxItem key={name} checked={inScope(scope, name)} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => onChange(toggleScope(scope, name, on, names))}>
            <WorkspaceSquare name={name} />{name}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-muted-foreground text-xs">{t('settings.scope.hint')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
