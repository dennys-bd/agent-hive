import { CheckIcon, ChevronRightIcon, CircleAlertIcon } from 'lucide-react';
import { Fragment, useCallback, useId, useState } from 'react';
import type { CatalogueItem, DiffHunk, DiffLine, UpdateChange, UpdateChoice, UpdateConflict, UpdatePreview } from '../../../types';
import { HeaderSlot } from '@/components/HeaderSlot';
import { UpdateHead } from '@/components/plugins/PluginsHead';
import { ConflictBlock, LOOK } from '@/components/plugins/UpdateConflict';
import { Button } from '@/components/ui/button';
import type { Plugins } from '@/hooks/use-plugins';
import { useUpdate } from '@/hooks/use-update';
import { type MessageKey, t, tPlural } from '@/i18n';
import { HIVE_ORIGIN } from '@/lib/plugins';
import { diffLineNumber, diffRange, type SideLine, sideAgainstBase } from '@/lib/update-diff';

type Change = UpdatePreview['changes'][number];
type Choices = Readonly<Record<string, UpdateChoice>>;
const isConflict = (change: Change): change is UpdateConflict => change.kind === 'conflict';
const CHOICE_LABEL: Record<UpdateChoice, MessageKey> = { mine: 'plugins.update.keepMine', hive: 'plugins.update.useHive' };
// mark, heading, the note or the file and its counts, status (#492's handoff), and a clean row's chevron (#984)
const COLUMNS = 'grid grid-cols-[20px_220px_minmax(0,1fr)_auto_16px] items-center gap-3';
const ROW = 'px-3.5 py-2 text-sm';
const STATUS_TONE: Partial<Record<MessageKey, string>> = { 'plugins.update.status.clean': 'text-working', 'plugins.update.status.choose': 'text-destructive' };
const MARK: Record<DiffLine['kind'], SideLine['mark']> = { context: ' ', add: '+', del: '−' };

// decision 6: each count's sentence, a zero one left out
function summaryOf(changes: readonly Change[]): string {
  const conflicts = changes.filter(isConflict).length;
  const clean = changes.length - conflicts;
  const parts = [clean > 0 ? tPlural('plugins.update.clean', clean, { n: clean }) : '', conflicts > 0 ? tPlural('plugins.update.passages', conflicts, { n: conflicts }) : ''];
  const sentence = parts.filter((part) => part !== '').join('; ');
  return sentence === '' ? '' : `${sentence}.`;
}

// A clean change's own counts; a conflict's are the user's side against base, what they changed there (user's answer)
function countsOf(change: Change): string {
  if (!isConflict(change)) return `+${change.added.length} −${change.removed.length}`;
  const lines = sideAgainstBase(change.base, change.mine ?? []);
  return `+${lines.filter((line) => line.mark === '+').length} −${lines.filter((line) => line.mark === '−').length}`;
}

function statusOf(change: Change, choice?: UpdateChoice): MessageKey {
  if (!isConflict(change)) return 'plugins.update.status.clean';
  return choice === undefined ? 'plugins.update.status.choose' : CHOICE_LABEL[choice];
}

// #984: the open diff's label: the Hive's original between its two versions, bare when either is unknown; a workspace item's own original
function diffTitleOf(item: CatalogueItem, { from, to }: UpdatePreview): string {
  if (item.origin !== HIVE_ORIGIN) return t('plugins.update.diffWorkspace');
  return from !== undefined && to !== undefined ? t('plugins.update.diffHive', { from, to }) : t('plugins.update.diffHiveBare');
}

// #492: the changelog's note says what changed in the plugin's words (English in both languages); without one, the file and its counts.
// Decision 7: the file only when the item has more than one, since otherwise every row would repeat it
function Detail({ change, hasFiles }: { change: Change; hasFiles: boolean }) {
  if (change.note !== undefined) return <span className="truncate text-soft text-xs">{change.note}</span>;
  return <span className="truncate font-mono text-muted-foreground text-xs">{[...(hasFiles ? [change.file] : []), countsOf(change)].join(' · ')}</span>;
}

function Cells({ change, choice, hasFiles }: { change: Change; choice?: UpdateChoice; hasFiles: boolean }) {
  const status = statusOf(change, choice);
  const Mark = isConflict(change) ? CircleAlertIcon : CheckIcon;
  return (
    <>
      <Mark aria-hidden="true" className={`size-3.5 ${isConflict(change) ? 'text-destructive' : 'text-working'}`} />
      <span className="truncate font-medium font-mono text-xs">{change.heading}</span>
      <Detail change={change} hasFiles={hasFiles} />
      <span className={`text-xs ${STATUS_TONE[status] ?? 'text-muted-foreground'}`}>{t(status)}</span>
    </>
  );
}

// #984: one line of the Hive's diff: one number (old on a removed line, new otherwise), the sign in its status colour, the text
function DiffRow({ line }: { line: DiffLine }) {
  const mark = MARK[line.kind];
  return (
    <div data-mark={mark} className={`grid grid-cols-[44px_20px_minmax(0,1fr)] ${LOOK[mark].ground}`}>
      <span className="select-none pr-2 text-right text-faint">{diffLineNumber(line)}</span>
      <span className={`select-none text-center ${LOOK[mark].mark}`}>{mark}</span>
      <span className="whitespace-pre">{line.text}</span>
    </div>
  );
}

// A line is unique in its hunk by its kind and numbers; a hunk in its diff by its header's ranges
const lineKey = (line: DiffLine): string => `${line.kind}:${line.old ?? ''}:${line.new ?? ''}`;

function DiffLines({ diff }: { diff: readonly DiffHunk[] }) {
  return (
    <div className="overflow-x-auto py-1 font-mono text-xs">
      {diff.map((hunk, n) => (
        <Fragment key={hunk.header}>
          {n > 0 && <div aria-hidden="true" className="h-4" />}
          {hunk.lines.map((line) => <DiffRow key={lineKey(line)} line={line} />)}
        </Fragment>
      ))}
    </div>
  );
}

// #984: an open row's region: the Hive's original before and after at the row's passage, or one line for a binary file
function ChangeDiff({ id, change, title }: { id: string; change: UpdateChange; title: string }) {
  const label = t('plugins.update.diffLabel', { heading: change.heading });
  if (change.diff.length === 0) {
    return <section id={id} aria-label={label} className="px-3.5 pb-2 text-muted-foreground text-xs">{t('plugins.update.binary')}</section>;
  }
  const range = diffRange(change.diff);
  const place = range === undefined ? change.file : `${change.file} · ${t('plugins.update.lines', range)}`;
  return (
    <section id={id} aria-label={label} className="px-3.5 pb-2">
      <div className="flex items-baseline justify-between gap-3 border-b border-dashed py-1.5 text-xs">
        <span className="font-semibold">{title}</span>
        <span className="font-mono text-muted-foreground">{place}</span>
      </div>
      <DiffLines diff={change.diff} />
    </section>
  );
}

interface ChangeRowProps { change: Change; choice?: UpdateChoice; hasFiles: boolean; diffId: string; diffTitle: string; isOpen: boolean; onToggle(): void }

// #984: a clean row discloses its diff in place; a conflict row stays plain, its sides drawn below the list, an empty fifth cell keeping
// the columns. The region mounts only while open, so a closed row's text is its cells alone
function ChangeRow({ change, choice, hasFiles, diffId, diffTitle, isOpen, onToggle }: ChangeRowProps) {
  const cells = <Cells change={change} choice={choice} hasFiles={hasFiles} />;
  if (isConflict(change)) return <li className={`${COLUMNS} ${ROW} border-b last:border-b-0`}>{cells}<span /></li>;
  return (
    <li className="border-b last:border-b-0">
      <button type="button" aria-expanded={isOpen} aria-controls={diffId} onClick={onToggle} className={`${COLUMNS} ${ROW} w-full text-left ${isOpen ? 'bg-accent/40' : ''}`}>
        {cells}
        <ChevronRightIcon aria-hidden="true" className={`size-3 text-muted-foreground transition-transform motion-reduce:transition-none ${isOpen ? 'rotate-90' : ''}`} />
      </button>
      {isOpen && <ChangeDiff id={diffId} change={change} title={diffTitle} />}
    </li>
  );
}

const toggled = (open: ReadonlySet<string>, key: string): ReadonlySet<string> => (open.has(key) ? new Set([...open].filter((k) => k !== key)) : new Set([...open, key]));

interface BodyProps { item: CatalogueItem; preview: UpdatePreview; choices: Choices; choose(conflictId: string, choice: UpdateChoice): void }

function Body({ item, preview, choices, choose }: BodyProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set()); // #984: no row starts open; the set lives as long as the screen
  const ids = useId();
  const editedAt = item.versions.find((v) => v.name === preview.version)?.editedAt;
  const versions = preview.from !== undefined && preview.to !== undefined ? `: ${preview.from} → ${preview.to}` : '';
  const diffTitle = diffTitleOf(item, preview);
  return (
    <>
      <div className="flex max-w-[760px] flex-col gap-1.5">
        <h2 className="font-semibold text-base">{`${t('plugins.update.title', { name: item.name })}${versions}`}</h2>
        <p className="text-muted-foreground text-sm">{`${t('plugins.update.summary')} ${summaryOf(preview.changes)}`.trim()}</p>
      </div>
      <ul aria-label={t('plugins.update.changes')} className="flex flex-col rounded-lg border">
        {preview.changes.map((change, index) => {
          const key = isConflict(change) ? change.id : `${change.file}#clean${index}`;
          return (
            <ChangeRow
              key={key} change={change} choice={isConflict(change) ? choices[change.id] : undefined} hasFiles={item.files.length > 1}
              diffId={`${ids}-diff-${index}`} diffTitle={diffTitle} isOpen={open.has(key)} onToggle={() => setOpen((was) => toggled(was, key))}
            />
          );
        })}
      </ul>
      {preview.changes.filter(isConflict).map((conflict) => (
        <ConflictBlock
          key={conflict.id} conflict={conflict} to={preview.to} editedAt={editedAt} choice={choices[conflict.id]} onChoose={(choice) => choose(conflict.id, choice)}
        />
      ))}
    </>
  );
}

interface FooterProps { left: number; isApplying: boolean; onApply(): void; onLater(): void }

// decision 11: until every conflict has a choice the render keeps the version's current text, and the footer says so. #492: apply stays
// focusable while a conflict waits (aria-disabled), so the reason next to it is reached with it; a run in flight disables it outright
function Footer({ left, isApplying, onApply, onLater }: FooterProps) {
  const isWaiting = left > 0;
  return (
    <footer className="flex items-center gap-2 px-6 py-3">
      <Button type="button" size="lg" disabled={isApplying} aria-disabled={isWaiting || undefined} onClick={() => { if (!isWaiting) onApply(); }}>{t('plugins.update.apply')}</Button>
      <Button type="button" variant="outline" size="lg" onClick={onLater}>{t('plugins.update.later')}</Button>
      {isWaiting && <span className="text-muted-foreground text-xs">{tPlural('plugins.update.left', left, { n: left })}</span>}
    </footer>
  );
}

/** Screen 11d (#325): one version's update, read from #324's preview: the title and summary, the changes, each clean one opening the Hive's
 * own diff in place (#984), each conflict side by side, and the footer. "later" asks nothing and opens the item (decision 16); an apply,
 * and an update gone meanwhile, read the catalogue again first. */
export function UpdateScreen({ plugins, id, version }: { plugins: Plugins; id: string; version: string }) {
  const { reload, open } = plugins;
  const leave = useCallback(async (): Promise<void> => {
    await reload();
    open({ kind: 'item', id });
  }, [reload, open, id]);
  const update = useUpdate(id, version, leave);
  const item = plugins.items?.find((i) => i.id === id);
  if (item === undefined) return null;
  const { preview, notice } = update;
  const left = (preview?.changes.filter(isConflict) ?? []).filter((conflict) => update.choices[conflict.id] === undefined).length;
  return (
    <section aria-label={t('plugins.update.screen')} className="flex min-h-0 flex-1 flex-col">
      <HeaderSlot>
        <UpdateHead item={item} version={version} preview={preview} onVersion={(next) => open({ kind: 'update', id, version: next })} onRevert={() => void update.revert()} />
      </HeaderSlot>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {notice && <p role="alert" className={`text-xs ${notice === 'plugins.update.stale' ? 'text-muted-foreground' : 'text-destructive'}`}>{t(notice)}</p>}
        {preview && <Body item={item} preview={preview} choices={update.choices} choose={update.choose} />}
      </div>
      {preview && <Footer left={left} isApplying={update.isApplying} onApply={() => void update.apply()} onLater={() => open({ kind: 'item', id })} />}
    </section>
  );
}
