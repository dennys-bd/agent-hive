import { useState } from 'react';
import { type Described, describeInstall, installActions, StateLine } from '@/components/settings/InstallRow';
import { WorkspaceScopePicker } from '@/components/settings/WorkspaceScopePicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { t } from '@/i18n';
import { splitArgs } from '@/lib/new-session';
import { type CheckerDraft, DEFAULT_FORMATTER_DRAFT, type LanguageDraft } from '@/lib/settings-format';
import { listOf } from '@/lib/settings-languages';
import { type CheckerDef, checkersOf, shownCommand } from '../../../checkers';
import { inScope, type LanguageDef, serverDef } from '../../../languages';
import type { CheckerId, CheckerState, EditorInstalls, InstallAction, InstallState, InstallTarget } from '../../../types';

interface CheckersSectionProps {
  language: LanguageDef; draft: LanguageDraft; names: readonly string[]; installs?: EditorInstalls; states?: CheckerState[];
  onAct(target: InstallTarget, action: InstallAction): void; onChange(draft: LanguageDraft): void;
}
interface RowProps { def: CheckerDef; setting?: CheckerDraft; state?: CheckerState; install?: InstallState; names: readonly string[]; onAct(action: InstallAction): void; onChange(setting: CheckerDraft): void }
interface ButtonsProps { install?: InstallState; isLogShown: boolean; onLog(): void; onAct(action: InstallAction): void }

const and = (): string => t('settings.formatters.and');
// Off by its own setting: switched off, or in no workspace
const isOff = (setting: CheckerDraft | undefined): boolean => setting !== undefined && (!setting.enabled || (setting.workspaces !== 'all' && setting.workspaces.length === 0));

// The switch with no setting saved (#782, the handoff's default): on when found in a selected workspace, or installed by the Hive
const isShownOn = (def: CheckerDef, setting: CheckerDraft | undefined, found: string[], install?: InstallState): boolean =>
  setting?.enabled ?? (found.length > 0 || (def.kind === 'lsp' && install?.state === 'installed'));

// A command-line row's state (#782): where it was found, nowhere, or off
function cliState(found: string[], setting: CheckerDraft | undefined): Described {
  if (isOff(setting)) return { text: t('settings.install.off') };
  return found.length > 0 ? { text: t('settings.checkers.foundIn', { workspaces: listOf(found, and()) }), tone: 'working' } : { text: t('settings.checkers.notFound') };
}

// A language-server row's origin note (#782): the project's copy wins where it is; elsewhere the Hive's, when it has one
function origin(found: string[], selected: string[], install?: InstallState): string {
  const isHive = install?.state === 'installed';
  if (found.length === 0) return t(isHive ? 'settings.checkers.usesHive' : 'settings.checkers.installOrAdd');
  const elsewhere = isHive && selected.some((name) => !found.includes(name)) ? t('settings.checkers.elsewhereHive') : '';
  return `${t('settings.checkers.projectWins', { workspaces: listOf(found, and()) })}${elsewhere}`;
}

// A language-server row's actions, as the language's server row has them: they act at once, outside the Settings footer
function InstallButtons({ install, isLogShown, onLog, onAct }: ButtonsProps) {
  return (
    <div className="flex items-center gap-1">
      {install?.state === 'failed' && <Button type="button" variant="link" size="xs" className="h-auto p-0 text-review" onClick={onLog}>{t(isLogShown ? 'settings.install.hideLog' : 'settings.install.showLog')}</Button>}
      {installActions(install).map(({ action, label, variant }) => <Button key={action} type="button" size="sm" variant={variant} onClick={() => onAct(action)}>{t(label)}</Button>)}
    </div>
  );
}

/** One checker of the language (#782): name and kind, its install actions (a language-server one), its switch; its state, origin and command
 * beside its chips; its extra arguments. The switch, chips and args wait for the footer. */
function CheckerRow({ def, setting, state, install, names, onAct, onChange }: RowProps) {
  const [isLogShown, setLogShown] = useState(false);
  const base = setting ?? DEFAULT_FORMATTER_DRAFT; // a change from no setting starts from the config's default: on, no args, everywhere
  const selected = names.filter((name) => inScope(base.workspaces, name));
  const found = (state?.found ?? []).filter((name) => selected.includes(name));
  const isLsp = def.kind === 'lsp';
  const via = isLsp ? t('settings.checkers.lsp', { via: t(`settings.server.via.${serverDef(def.server).install}`) }) : t('settings.checkers.cli');
  const command = shownCommand(def, splitArgs(base.args));
  return (
    <fieldset aria-label={def.id} className="flex min-w-0 flex-col gap-2 border-b px-3 py-2.5 last:border-b-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3">
        <div className="flex min-w-0 items-baseline gap-2"><span className="font-mono text-sm">{def.id}</span><span className="truncate text-muted-foreground text-xs">{via}</span></div>
        {isLsp ? <InstallButtons install={install} isLogShown={isLogShown} onLog={() => setLogShown(!isLogShown)} onAct={onAct} /> : <span />}
        <Switch aria-label={t('settings.checkers.use', { name: def.id })} checked={isShownOn(def, setting, found, install)} onCheckedChange={(enabled) => onChange({ ...base, enabled })} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)] items-center gap-3">
        <div className="flex min-w-0 flex-col gap-0.5 text-xs">
          <StateLine described={isLsp ? describeInstall(install, isOff(setting), '') : cliState(found, setting)} isPlain={isLsp && install?.state === 'installed' && !isOff(setting)} />
          <span className="text-muted-foreground">{isLsp ? origin(found, selected, install) : t('settings.checkers.detected')}</span>
          <span title={command} className="truncate font-mono text-muted-foreground">{command}</span>
        </div>
        <WorkspaceScopePicker label={t('settings.scope.of', { item: def.id })} scope={base.workspaces} names={names} onChange={(workspaces) => onChange({ ...base, workspaces })} />
      </div>
      {install?.state === 'installing' && <Progress value={install.percent} aria-label={t('settings.install.progress', { name: def.id })} className="h-1.5 bg-accent" indicatorClassName="bg-foreground" />}
      {install?.state === 'failed' && isLogShown && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-background px-2.5 py-2 font-mono text-muted-foreground text-xs">{install.log}</pre>}
      <Input aria-label={t('settings.checkers.argsOf', { name: def.id })} spellCheck={false} className="font-mono text-xs" placeholder={t('settings.checkers.args')} value={base.args} onChange={(e) => onChange({ ...base, args: e.target.value })} />
    </fieldset>
  );
}

/** A language's checkers (#782), in the catalog's order: its language-server ones, then its command-line ones. */
export function CheckersSection({ language, draft, names, installs, states, onAct, onChange }: CheckersSectionProps) {
  const defs = checkersOf(language.id);
  const setChecker = (id: CheckerId) => (setting: CheckerDraft): void => onChange({ ...draft, checkers: { ...draft.checkers, [id]: setting } });
  return (
    <div className="flex flex-col rounded-md border">
      {defs.map((def) => (
        <CheckerRow
          key={def.id} def={def} setting={draft.checkers[def.id]} state={states?.find((s) => s.id === def.id)} names={names} onChange={setChecker(def.id)}
          install={def.kind === 'lsp' ? installs?.servers[def.server] : undefined}
          onAct={(action) => { if (def.kind === 'lsp') onAct({ kind: 'server', id: def.server }, action); }}
        />
      ))}
      {defs.length === 0 && <p className="p-3 text-muted-foreground text-xs">{t('settings.checkers.none')}</p>}
    </div>
  );
}
