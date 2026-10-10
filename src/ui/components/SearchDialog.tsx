import { PlusIcon } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { ScopeBar, SearchField, SearchFooter } from '@/components/SearchChrome';
import { ROW, SearchRowItem } from '@/components/SearchRows';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { type MessageKey, t } from '@/i18n';
import type { Activity } from '@/lib/activities';
import { itemPage, type Operation, type OperationContext, operationsFor, viewOf } from '@/lib/operations';
import { taskRef } from '@/lib/operations-activity';
import { type GroupId, nextScope, parseQuery, operationRows, type Scope, type SearchGroup, type SearchRow, searchGroups } from '@/lib/search';

// returnTo: what held the focus before the search opened, when a reopen (a key pressed while open) keeps the first one; default, what holds it now
// page: a › page the search opens on (#585), the run-command key's commands of a task
export interface SearchDialogProps { scope: Scope; ctx: OperationContext; activities: Activity[]; returnTo?: Element | null; page?: { title: string; operations: Operation[] }; onClose(): void }

const GROUP_KEY: Record<GroupId, MessageKey> = {
  recent: 'home.recent', pending: 'search.group.pending', activities: 'search.scope.activities', tasks: 'search.scope.tasks', commands: 'search.scope.commands',
};

const itemIdOf = (row: SearchRow): string | undefined => {
  if (row.kind === 'activity') return row.activity.task.item.itemId;
  return row.kind === 'task' ? row.task.item.itemId : undefined;
};
// cmdk's value: unique across the groups, since a recent activity may also need you
const rowValue = (group: GroupId, row: SearchRow): string => `${group}:${row.kind}:${row.kind === 'operation' ? row.view.operation.id : itemIdOf(row)}`;

/** A › page (#584): its name beside the field, the context its operations run in, and the operations. */
interface Page { title: string; ctx: OperationContext; operations: Operation[] }

// ↵ (the handoff): an operation with › opens its page and the search stays; everything else closes it first, then acts. The search closes
// first, so a dialog the operation opens takes the focus
function openRow(row: SearchRow, ctx: OperationContext, onClose: () => void, push: (page: Page) => void): void {
  const children = row.kind === 'operation' ? row.view.operation.children : undefined;
  if (row.kind === 'operation' && children !== undefined) {
    push({ title: row.view.label, ctx, operations: children(ctx) });
    return;
  }
  onClose();
  if (row.kind === 'activity') ctx.nav.openActivity(row.activity.task.item.itemId);
  else if (row.kind === 'task') ctx.nav.startTask({ itemId: row.task.item.itemId });
  else row.view.operation.run?.(ctx);
}

// ⌘↵: an activity's or a task's details in the flow; nothing on an operation
function showRow(row: SearchRow, ctx: OperationContext, onClose: () => void): void {
  const itemId = itemIdOf(row);
  if (itemId === undefined) return;
  onClose();
  ctx.nav.showFlow(itemId);
}

// The field, the scope and the page stack. A prefix typed first switches the scope and leaves the field (the handoff); a page has no scope
function useSearchState(initial: Scope, first?: Page) {
  const [scope, setScope] = useState(initial);
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<Page[]>(first === undefined ? [] : [first]);
  const page = pages.at(-1);
  const type = (text: string): void => {
    if (page !== undefined) {
      setQuery(text);
      return;
    }
    const parsed = parseQuery(text, scope);
    setScope(parsed.scope);
    setQuery(parsed.query);
  };
  const push = (next: Page): void => { setPages([...pages, next]); setQuery(''); };
  const back = (): void => { setPages(pages.slice(0, -1)); setQuery(''); };
  return { scope, setScope, query, setQuery, type, page, push, back };
}
type SearchState = ReturnType<typeof useSearchState>;

// What the list shows: a page's operations, or the search's groups for the scope and the query
function groupsOf(search: SearchState, ctx: OperationContext, activities: Activity[]): SearchGroup[] {
  const { page, scope, query } = search;
  if (page !== undefined) {
    const rows = operationRows(page.operations.filter((op) => op.available(page.ctx)).map((op) => viewOf(op, page.ctx)), query);
    return rows.length === 0 ? [] : [{ id: 'commands', rows }];
  }
  const operations = operationsFor(ctx).map((op) => viewOf(op, ctx));
  return searchGroups({ scope, query, tasks: ctx.state.tasks, workers: ctx.state.workers, liveActivities: ctx.state.activities, activityRecords: ctx.state.activityRecords, activities, operations });
}

// → on an activity or a task row (the spec): a page with that item's operations, e.g. #466 → parar todas
function itemPageOf(row: SearchRow, ctx: OperationContext): Page | undefined {
  if (row.kind === 'operation') return undefined;
  const task = row.kind === 'activity' ? row.activity.task : row.task;
  const page = itemPage(ctx, task, row.kind === 'activity' ? row.activity : undefined);
  return { title: `${taskRef(task)} →`, ...page };
}

// → and ← move the caret while it has somewhere to go; at the field's end → opens a page, at its start ← goes back
const caretAt = (target: EventTarget, isEnd: boolean): boolean =>
  target instanceof HTMLInputElement && target.selectionStart === (isEnd ? target.value.length : 0);

// root: the top-level context, which a → page is built from, not a page's own
interface KeyArgs { current?: SearchRow; search: SearchState; ctx: OperationContext; root: OperationContext; onClose(): void }

// Tab cycles the scopes (none on a page), ⌘↵ is the row's secondary, → opens a row's page, ← and Backspace on the empty field go back
function searchKeys({ current, search, ctx, root, onClose }: KeyArgs) {
  return (e: KeyboardEvent<HTMLDivElement>): void => {
    const { page, query } = search;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (page === undefined) search.setScope(nextScope(search.scope, e.shiftKey ? -1 : 1));
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (current) showRow(current, ctx, onClose);
    } else if (e.key === 'ArrowRight' && current !== undefined && caretAt(e.target, true)) {
      const next = itemPageOf(current, root);
      if (next === undefined) return;
      e.preventDefault();
      search.push(next);
    } else if (e.key === 'ArrowLeft' && page !== undefined && caretAt(e.target, false)) {
      e.preventDefault();
      search.back();
    } else if (e.key === 'Backspace' && query === '' && page !== undefined) {
      e.preventDefault();
      search.back();
    }
  };
}

function NoResult({ term, canCreate, onCreate }: { term: string; canCreate: boolean; onCreate(): void }) {
  return (
    <>
      <p className="px-2.5 py-3 text-[13px] text-muted-foreground">{t('search.none', { term })}</p>
      {canCreate && <CommandItem value="create" onSelect={onCreate} className={ROW}><PlusIcon />{t('search.createTask', { term })}</CommandItem>}
    </>
  );
}

/** The search (⌘P; ⌘⇧P on comandos; #584): activities, tasks and the Hive's operations in one box, with scopes. Mounted only while open, so
 * each open starts on an empty field. ↵ opens, ⌘↵ shows in the flow, Tab cycles the scopes, Esc clears the field and then closes. */
export function SearchDialog({ scope: initial, ctx, activities, returnTo, page: first, onClose }: SearchDialogProps) {
  const search = useSearchState(initial, first && { ...first, ctx });
  const { scope, query, page } = search;
  const [selected, setSelected] = useState('');
  const before = useRef(returnTo === undefined ? document.activeElement : returnTo); // Radix gives the focus back to a trigger only, and this dialog has none
  const on = page?.ctx ?? ctx; // the context a row's operation runs in
  const groups = groupsOf(search, ctx, activities);
  const rows = new Map(groups.flatMap((group) => group.rows.map((row) => [rowValue(group.id, row), row] as const)));
  const current = rows.get(selected);
  const term = query.trim();
  const onKeyDown = searchKeys({ current, search, ctx: on, root: ctx, onClose });
  const create = (): void => { onClose(); ctx.nav.startTask({ title: term }); };
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="top-24 translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[640px]" showCloseButton={false} aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          // Only while nothing took the focus meanwhile: a picked operation may have opened a terminal, which focuses itself
          const isFree = document.activeElement === null || document.activeElement === document.body;
          if (isFree && before.current instanceof HTMLElement && before.current.isConnected) before.current.focus();
        }}
        onEscapeKeyDown={(e) => { if (query !== '') { e.preventDefault(); search.setQuery(''); } }}
      >
        <DialogTitle className="sr-only">{t('search.title')}</DialogTitle>
        <Command label={t('search.title')} shouldFilter={false} loop value={selected} onValueChange={setSelected} onKeyDown={onKeyDown} className="rounded-none">
          <SearchField value={query} crumb={page?.title} onChange={search.type} />
          {page === undefined && <ScopeBar scope={scope} onScope={search.setScope} />}
          <CommandList className="max-h-[420px] p-1.5">
            {groups.map((group) => (
              <CommandGroup key={group.id} heading={page?.title ?? t(GROUP_KEY[group.id])}>
                {group.rows.map((row) => {
                  const value = rowValue(group.id, row);
                  return <SearchRowItem key={value} value={value} row={row} state={ctx.state} onSelect={() => openRow(row, on, onClose, search.push)} />;
                })}
              </CommandGroup>
            ))}
            {groups.length === 0 && term !== '' && <NoResult term={term} canCreate={page === undefined && scope === 'tasks'} onCreate={create} />}
          </CommandList>
          <SearchFooter secondary={current && itemIdOf(current) !== undefined ? t('detail.showFlow') : undefined} count={groups.reduce((n, g) => n + g.rows.length, 0)} />
        </Command>
      </DialogContent>
    </Dialog>
  );
}
