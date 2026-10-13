import { XIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { toast } from 'sonner';
import { ConventionsEditor } from '@/components/settings/ConventionsEditor';
import { EnvEditor } from '@/components/settings/EnvEditor';
import { MemorySection } from '@/components/settings/MemorySection';
import { WorkspaceColorPicker } from '@/components/settings/WorkspaceColorPicker';
import { WorkspaceFork } from '@/components/settings/WorkspaceFork';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import type { WorkspaceDraft } from '@/lib/settings-form';
import { settingAnchor } from '@/lib/settings-search';
import type { State } from '../../../types';
import { workspaceNameFor } from '../../../tasks';

interface WorkspacesEditorProps { workspaces: WorkspaceDraft[]; savedNames: readonly string[]; state?: State; onChange(workspaces: WorkspaceDraft[]): void; onCapSaved(workspace: string, cap: number): void }
interface FieldsProps { row: WorkspaceDraft; n: number; onChange(patch: Partial<WorkspaceDraft>): void }
interface WorkspaceCardProps extends FieldsProps { canRemove: boolean; saved: boolean; state?: State; onPick(path: string): void; onRemove(): void; onCapSaved(cap: number): void }

const STEPS = ['copy', 'run', 'load', 'del'] as const;

// Inside the viewer only (window.hive): the native folder picker (#202). A cancelled pick changes nothing; a failure is a toast.
function chooseFolder(pick: (path: string) => void): void {
  window.hive?.chooseFolder().then((picked) => { if (picked) pick(picked); }, (err: Error) => toast.error(err.message));
}

interface ScriptFieldsProps {
  script: 'setup' | 'teardown'; n: number; context: string; text: string; timeout: string; placeholder: string; timeoutPlaceholder: string;
  onText(text: string): void; onTimeout(timeout: string): void;
}

// A workspace's worktree script (#299, #654): the setup run once in each new worktree, or the teardown run in it before the Hive removes it;
// beside it each RUN's timeout as a timeout text (#511, empty = no limit); under both, the instructions it takes.
function ScriptFields({ script, n, context, text, timeout, placeholder, timeoutPlaceholder, onText, onTimeout }: ScriptFieldsProps) {
  const id = useId();
  const label = t(`settings.workspaces.${script}`);
  // one visible label for both timeouts (#654); the accessible name adds the script's, so the two inputs never share one
  const timeoutLabel = t('settings.workspaces.stepTimeout');
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_9rem] items-start gap-3">
        <div id={settingAnchor(`settings.workspaces.${script}`, context)} className="flex flex-col gap-2">
          <Label htmlFor={`${id}-text`}>{label}</Label>
          <Textarea
            id={`${id}-text`} aria-label={`${label} ${n}`} rows={4} spellCheck={false} className="font-mono text-xs"
            value={text} placeholder={placeholder} onChange={(e) => onText(e.target.value)}
          />
        </div>
        <div id={settingAnchor('settings.workspaces.stepTimeout', `${context}-${script}`)} className="flex flex-col gap-2">
          <Label htmlFor={`${id}-timeout`}>{timeoutLabel}</Label>
          <Input
            id={`${id}-timeout`} aria-label={`${label}: ${timeoutLabel} ${n}`} className="font-mono" type="text"
            value={timeout} placeholder={timeoutPlaceholder} onChange={(e) => onTimeout(e.target.value)}
          />
          <span className="text-muted-foreground text-xs">{t(`settings.workspaces.${script}TimeoutHint`)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
        {t(`settings.workspaces.${script}Help`)}
        {STEPS.map((step) => <Badge key={step} variant="outline" className="font-mono">{t(`settings.workspaces.step.${step}`)}</Badge>)}
      </div>
    </div>
  );
}

// A titled group of a card (#348, #692, #749): its heading and hint on one baseline, then its editor.
export function CardGroup({ title, hint, anchor, children }: { title: string; hint: string; anchor?: string; children: ReactNode }) {
  return (
    <div id={anchor} className="flex flex-col gap-3 border-t pt-4">
      <div className="flex items-baseline gap-3">
        <h3 className="shrink-0 whitespace-nowrap font-semibold text-sm">{title}</h3>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </div>
      {children}
    </div>
  );
}

// One workspace (#511): its own card, named after it, so each is a surface of the page like the commands card.
function WorkspaceCard({ row, n, canRemove, saved, state, onChange, onPick, onRemove, onCapSaved }: WorkspaceCardProps) {
  const id = useId();
  const name = row.name.trim() || t('settings.workspaces.card', { n }); // not the name field's own label, which it would shadow
  const remove = t('settings.workspaces.remove', { n });
  return (
    <section id={settingAnchor('settings.workspaces', row.id)} aria-label={name} className="flex flex-col gap-5 rounded-xl border bg-card p-5 shadow-sm">
      <div className="grid grid-cols-[auto_12.5rem_minmax(0,1fr)_auto_auto] items-end gap-3">
        <div id={settingAnchor('settings.workspaces.color', row.id)} className="flex flex-col gap-2">
          <Label htmlFor={`${id}-color`}>{t('settings.workspaces.color')}</Label>
          <WorkspaceColorPicker id={`${id}-color`} value={row.color} onChange={(color) => onChange({ color })} />
        </div>
        <div id={settingAnchor('settings.workspaces.name', row.id)} className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>{t('settings.workspaces.name')}</Label>
          <Input id={`${id}-name`} aria-label={`${t('settings.workspaces.name')} ${n}`} value={row.name} onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <div id={settingAnchor('settings.workspaces.path', row.id)} className="flex flex-col gap-2">
          <Label htmlFor={`${id}-path`}>{t('settings.workspaces.path')}</Label>
          <Input id={`${id}-path`} aria-label={`${t('settings.workspaces.path')} ${n}`} className="font-mono" value={row.path} placeholder="/path/to/repo" onChange={(e) => onChange({ path: e.target.value })} />
        </div>
        {window.hive ? <Button type="button" variant="outline" onClick={() => chooseFolder(onPick)}>{t('settings.workspaces.choose')}</Button> : <span />}
        <Button type="button" variant="ghost" size="icon" aria-label={remove} title={remove} disabled={!canRemove} onClick={onRemove}><XIcon /></Button>
      </div>
      {/* #854: where the workers' worktrees start from and where their PRs go */}
      <CardGroup title={t('settings.fork.group')} hint={t('settings.fork.hint')} anchor={settingAnchor('settings.fork.group', row.id)}>
        <WorkspaceFork row={row} saved={saved} state={state} onChange={onChange} />
      </CardGroup>
      <ScriptFields
        script="setup" n={n} context={row.id} text={row.setup} timeout={row.setupTimeout} placeholder={'COPY .env\nRUN pnpm install'} timeoutPlaceholder="5m"
        onText={(setup) => onChange({ setup })} onTimeout={(setupTimeout) => onChange({ setupTimeout })}
      />
      <ScriptFields
        script="teardown" n={n} context={row.id} text={row.teardown} timeout={row.teardownTimeout} placeholder="RUN docker compose down" timeoutPlaceholder="2m"
        onText={(teardown) => onChange({ teardown })} onTimeout={(teardownTimeout) => onChange({ teardownTimeout })}
      />
      {/* #348: exported before every command run in it, under a command's own */}
      <CardGroup title={t('settings.env.group')} hint={t('settings.env.hint')} anchor={settingAnchor('settings.env.group', row.id)}>
        <EnvEditor label={t('settings.workspaceEnv', { workspace: row.name.trim() })} rows={row.env} onChange={(env) => onChange({ env })} />
      </CardGroup>
      {/* #692: how the plugin's new-* skills work here, read through hive_conventions */}
      <CardGroup title={t('settings.conventions.group')} hint={t('settings.conventions.hint')} anchor={settingAnchor('settings.conventions.group', row.id)}>
        <ConventionsEditor label={t('settings.workspaceConventions', { workspace: row.name.trim() })} rows={row.conventions} onChange={(conventions) => onChange({ conventions })} />
      </CardGroup>
      {/* #797: the memory's usage and its dialog, saved at once through its own routes, never the draft: workers write the same file. #115: the
          dialog also saves the total limit, and hands it back for the draft */}
      <CardGroup title={t('settings.memory.group')} hint={t('settings.memory.hint')} anchor={settingAnchor('settings.memory.group', row.id)}>
        <MemorySection workspace={row.name.trim()} saved={saved} onCapSaved={onCapSaved} />
      </CardGroup>
    </section>
  );
}

/** Settings › workspaces (#179, #510, #511): one card per workspace, at least one, each with a colour (#78), a name, a folder, its worktree setup (#299), teardown (#654),
 * its env (#348), its conventions (#692) and its memory (#797), whose total limit the memory dialog saves (#115); `+ workspace` under them. The server checks each folder is a repo's top level and parses each setup. */
export function WorkspacesEditor({ workspaces, savedNames, state, onChange, onCapSaved }: WorkspacesEditorProps) {
  const update = (id: string, patch: Partial<WorkspaceDraft>): void => onChange(workspaces.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  // a picked folder also names a row whose name is still empty, after the folder
  const pick = (row: WorkspaceDraft) => (path: string): void => update(row.id, { path, ...(row.name.trim() === '' ? { name: workspaceNameFor(path) } : {}) });
  return (
    <>
      {workspaces.map((row, i) => (
        <WorkspaceCard
          key={row.id} row={row} n={i + 1} canRemove={workspaces.length > 1} saved={savedNames.includes(row.name.trim())} state={state} onChange={(patch) => update(row.id, patch)} onPick={pick(row)} onCapSaved={(cap) => onCapSaved(row.name.trim(), cap)}
          onRemove={() => onChange(workspaces.filter((p) => p.id !== row.id))}
        />
      ))}
    </>
  );
}
