import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import { Kbd } from '@/components/Home';
import { type MessageKey, t, tPlural } from '@/i18n';
import { SCOPE_PREFIX, SCOPES, type Scope } from '@/lib/search';
import { isMac } from '@/lib/shortcut-bindings';

const SCOPE_KEY: Record<Scope, MessageKey> = {
  all: 'search.scope.all', activities: 'search.scope.activities', tasks: 'search.scope.tasks', commands: 'search.scope.commands', files: 'search.scope.files',
};

/** The search's 48px field (the handoff): the icon, the text in 15px, and esc on the right. `crumb` names the page a › or → opened. */
export function SearchField({ value, crumb, onChange }: { value: string; crumb?: string; onChange(value: string): void }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b px-3.5">
      <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      {crumb && <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs">{crumb}</span>}
      <CommandPrimitive.Input
        value={value} onValueChange={onChange} aria-label={t('search.title')} placeholder={t('search.placeholder')}
        className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-hidden placeholder:text-muted-foreground"
      />
      <span aria-hidden="true" className="text-muted-foreground text-xs">esc</span>
    </div>
  );
}

/** The scopes (the handoff), the active one on muted, the prefix beside its name. A click keeps the focus in the field; Tab cycles them. */
export function ScopeBar({ scope, onScope }: { scope: Scope; onScope(scope: Scope): void }) {
  return (
    <div className="flex gap-1 border-b px-3.5 py-2 font-medium text-xs">
      {SCOPES.map((s) => (
        <button
          key={s} type="button" tabIndex={-1} aria-pressed={s === scope} onMouseDown={(e) => e.preventDefault()} onClick={() => onScope(s)}
          className={`rounded-sm px-2 py-0.5 ${s === scope ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
        >
          {t(SCOPE_KEY[s])}
          {SCOPE_PREFIX[s] && <span className="font-normal"> {SCOPE_PREFIX[s]}</span>}
        </button>
      ))}
    </div>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return <span className="flex items-center gap-1.5">{keys.map((key) => <Kbd key={key}>{key}</Kbd>)}{label}</span>;
}

/** The footer (the handoff): the keys, ⌘↵ named after the selected row's secondary (none on an operation), → and tab; the count on the right. */
export function SearchFooter({ secondary, count }: { secondary?: string; count: number }) {
  return (
    <div className="flex items-center gap-4 border-t px-3.5 py-2 text-muted-foreground text-xs">
      <Hint keys={['↑', '↓']} label={t('search.key.navigate')} />
      <Hint keys={['↵']} label={t('search.key.open')} />
      {secondary && <Hint keys={[isMac() ? '⌘↵' : 'Ctrl+↵']} label={secondary} />}
      <Hint keys={['→']} label={t('search.key.actions')} />
      <Hint keys={['tab']} label={t('search.key.scope')} />
      <span className="flex-1" />
      <span>{tPlural('search.count', count, { n: count })}</span>
    </div>
  );
}
