import { ArrowLeftIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/Confirm';
import { SectionContent } from '@/components/settings/SectionContent';
import type { TransitionFocus } from '@/components/settings/StageEditor';
import { SettingsFooter } from '@/components/settings/SettingsFooter';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { getJson, postJson } from '@/lib/api';
import type { NewSource } from '@/lib/flow-sources';
import { WorkspaceColorsContext } from '@/lib/workspace-color';
import { withMemoryCap } from '@/lib/memory-cap';
import { SETTINGS_SECTIONS, type SettingsView, unsavedKeys } from '@/lib/settings-sections';
import { type SourceDraft, sourceColumnsUrl, draftFrom, filterOptionsUrl, projectsUrl, toSettingsBody, validateSettings, type SettingsDraft } from '@/lib/settings-form';
import { deletionMessage, deletionMoves, type StageMove } from '@/lib/settings-stages';
import { isRecording } from '@/lib/shortcut-bindings';
import { WINDOW_CHROME } from '@/lib/window-chrome';
import type { FilterOptions, GithubAuthStatus, ProjectSummary, SettingsInfo, SettingsResult, State } from '../../../types';

interface SettingsProps { info: SettingsInfo; state?: State; newSource?: NewSource; view?: SettingsView; onSaved(result: SettingsResult): Promise<void>; onCancel?(): void }

const AUTH_POLL_MS = 2000; // the login runs on the server; the page asks while a flow is pending (the settings screen has no SSE)

export function Settings({ info, state, newSource, view: opening, onSaved, onCancel }: SettingsProps) {
  // saved vs draft (#510): saved is what a Cancel reverts to and a Save compares against; a later `info` prop resyncs both.
  const [saved, setSaved] = useState(() => draftFrom(info));
  // newSource (#514): a source added from the header's dialog before Settings ever opened; the page starts on it, unsaved.
  const [draft, setDraft] = useState(() => (newSource ? { ...saved, sources: [...saved.sources, newSource.source] } : saved));
  // opening names a source by its saved name (a source's configurar, redesign 09); the view holds its row id
  const [view, setView] = useState<SettingsView>(() => {
    if (newSource) return { section: 'flow', source: newSource.source.id };
    const source = opening?.source === undefined ? undefined : saved.sources.find((b) => b.savedName === opening.source)?.id;
    return { section: opening?.section ?? 'workspaces', source, ...(opening?.language ? { language: opening.language } : {}) };
  });
  const [saveError, setSaveError] = useState<string | undefined>(); // #739: shown in the footer, which stays in view; `error` is for the section's own actions
  const [focus, setFocus] = useState<TransitionFocus | undefined>(); // #918: the transition a refused save selects on the chart
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | undefined>(info.configured ? undefined : info.error);
  const [githubProjects, setGithubProjects] = useState<Record<string, ProjectSummary[]>>(() => (newSource ? { [newSource.source.id]: newSource.projects } : {})); // per source row (#180)
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [filterOptions, setFilterOptions] = useState<Record<string, FilterOptions>>({}); // per github row (#245), loaded with its columns
  const [saving, setSaving] = useState(false);
  const [github, setGithub] = useState<GithubAuthStatus>();
  const [confirm, setConfirm] = useState<'revert' | 'leave' | undefined>();
  const [moves, setMoves] = useState<StageMove[] | undefined>(); // #861: where a save's deleted stages send their tasks, asked before the save
  const hasGithub = draft.sources.some((b) => b.type === 'github');
  const source = view.section === 'flow' ? draft.sources.find((b) => b.id === view.source) : undefined; // a removed or reverted row reads as the list
  const pageRef = useRef<HTMLDivElement>(null);

  function applyEdit(patch: Partial<SettingsDraft>): void {
    setDraft((d) => ({ ...d, ...patch }));
    setSaveError(undefined); // the message was about the draft before this edit
    setFocus(undefined);
  }

  // #115: the memory dialog wrote a workspace's total limit to hive.config.json at once. The baseline takes it with the draft, so the footer
  // reports no change and a later save sends it instead of undoing it
  function capSaved(workspace: string, cap: number): void {
    setSaved((s) => withMemoryCap(s, workspace, cap));
    setDraft((d) => withMemoryCap(d, workspace, cap));
  }

  const changed = unsavedKeys(saved, draft);
  const offered = info.configured ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.filter((s) => s !== 'maintenance'); // worktrees only once configured (#181)

  // Esc, ← back and Cancel all route here: no change leaves (or reverts) at once, a change asks first.
  function requestLeave(): void {
    if (!onCancel) return;
    if (changed.length > 0) { setConfirm('leave'); return; }
    onCancel();
  }

  function discard(): void {
    if (confirm === 'leave') onCancel?.();
    else { setDraft(saved); setRevision((r) => r + 1); } // remounts the uncontrolled fields with the saved values
    setConfirm(undefined);
    setSaveError(undefined);
    setFocus(undefined);
  }

  // The lazy useState initializers above already drafted this `info`; resyncing here too would hand every source and stage row a
  // second, different generated id before the mount effect below reads them (#180) — resync only on a later `info` prop change.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) { const next = draftFrom(info); setSaved(next); setDraft(next); }
    mounted.current = true;
  }, [info]);

  // #245: a failure shows its message like a columns failure and leaves the rules as they are: the picker still takes typed values.
  const loadFilterOptions = useCallback(async (current: SettingsDraft, row: SourceDraft) => {
    const url = filterOptionsUrl(current, row);
    if (!url) return;
    try {
      const listed = await getJson<FilterOptions>(url);
      setFilterOptions((o) => ({ ...o, [row.id]: listed }));
    } catch (err) { setError((err as Error).message); }
  }, []);

  const loadColumns = useCallback(async (current: SettingsDraft, row: SourceDraft) => {
    void loadFilterOptions(current, row); // in parallel, and sent first: a row's options come with its columns (#245)
    const url = sourceColumnsUrl(current, row);
    if (!url) return;
    try {
      const listed = await getJson<string[]>(url);
      setOptions((o) => ({ ...o, [row.id]: listed }));
    } catch (err) { setError((err as Error).message); }
  }, [loadFilterOptions]);

  const loadProjects = useCallback(async (row: SourceDraft) => {
    const url = projectsUrl(draft.auth, row);
    if (!url) { setError(t('settings.error.owner')); return; }
    const owner = row.owner.trim();
    setError(undefined);
    try {
      const list = await getJson<ProjectSummary[]>(url);
      setGithubProjects((p) => ({ ...p, [row.id]: list }));
      if (list.length === 0) { setError(t('settings.error.noProjects', { owner })); return; }
      const number = list.some((p) => String(p.number) === row.number) ? row.number : String(list[0].number);
      setDraft((d) => ({ ...d, sources: d.sources.map((b) => (b.id === row.id ? { ...b, number } : b)) }));
      await loadColumns(draft, { ...row, number });
    } catch (err) { setError((err as Error).message); }
  }, [draft, loadColumns]);

  // A source just added through sources › + source (#514): its projects rode along with the dialog, so only its columns are missing.
  function addSource({ source: row, projects }: NewSource): void {
    setDraft((d) => ({ ...d, sources: [...d.sources, row] }));
    setGithubProjects((p) => ({ ...p, [row.id]: projects }));
    setView({ section: 'flow', source: row.id });
    void loadColumns(draft, row);
  }

  const refreshGithub = useCallback(async () => {
    try { setGithub(await getJson<GithubAuthStatus>('/settings/github/auth')); }
    catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => {
    if (hasGithub && draft.auth === 'api') void refreshGithub();
  }, [hasGithub, draft.auth, refreshGithub]);

  useEffect(() => {
    if (!github?.pending) return;
    const id = setInterval(() => void refreshGithub(), AUTH_POLL_MS);
    return () => clearInterval(id);
  }, [github?.pending, refreshGithub]);

  async function connect(): Promise<void> {
    setError(undefined);
    try { await postJson('/settings/github/login'); await refreshGithub(); }
    catch (err) { setError((err as Error).message); }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount only, like the imperative openSetup() did
  useEffect(() => {
    if (draft.auth === 'cli') for (const row of draft.sources) if (row.type === 'github') void loadProjects(row); // api without a token lists nothing: the user connects first
  }, []);

  async function save(confirmed = false): Promise<void> {
    const problem = validateSettings(draft);
    if (problem) {
      setView({ section: problem.section });
      setSaveError(problem.message);
      const { transition } = problem;
      if (transition !== undefined) setFocus((f) => ({ transition, n: (f?.n ?? 0) + 1 })); // a new n re-selects it after the user moved away
      return;
    }
    const body = toSettingsBody(draft);
    // #861: a deleted stage holding tasks asks first, naming how many go where; Cancel keeps the form as it is
    const pending = confirmed ? [] : deletionMoves(draft.stages, info.config?.comb.stages ?? [], body.stages ?? [], state?.tasks ?? []);
    if (pending.length > 0) { setMoves(pending); return; }
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await postJson<SettingsResult>('/settings', body);
      // the viewer re-reads the menu bar settings now (#198); the save already went through, so a failure here is only a toast
      void window.hive?.settingsChanged().catch((err: Error) => toast.error(err.message));
      await onSaved(result);
    }
    catch (err) { setSaveError((err as Error).message); }
    finally { setSaving(false); }
  }

  // Esc leaves like ← back (#294). A recording key field takes it to cancel the recording (#449, #481), and an open select or the confirm owns its own
  // Escape: their focus is in a portal outside the page. No dependency list on purpose: it re-binds each render, so requestLeave always
  // sees the current `changed`.
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || isRecording(e.target)) return;
      const target = e.target as Node;
      if (target !== document.body && !pageRef.current?.contains(target)) return;
      requestLeave();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // The squares Settings draws (bases, stage commands, scope pickers, memory dialog) show the draft's colour, a row not saved yet included;
  // Settings also renders before any dashboard on a first run.
  // An unnamed or duplicate name maps to one key, harmlessly: the save refuses both, and an unnamed row draws no square by name
  const colors = useMemo(() => Object.fromEntries(draft.workspaces.map((w) => [w.name.trim(), w.color])), [draft.workspaces]);
  // data-settings-page: the page holds the window as a dialog does, so the shortcut map's key leaves it alone (#639)
  return (
    <WorkspaceColorsContext.Provider value={colors}>
    <div ref={pageRef} data-settings-page="" className="fixed inset-0 z-40 flex flex-col bg-background text-foreground">
      <header className={`flex shrink-0 items-center gap-3 border-b pr-6 ${WINDOW_CHROME}`}>
        {onCancel && <Button type="button" variant="ghost" size="sm" className="[-webkit-app-region:no-drag]" disabled={saving} onClick={requestLeave}><ArrowLeftIcon />{t('settings.back')}</Button>}
        <span className="font-semibold text-lg leading-none">{t('settings.title')}</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <SettingsNav offered={offered} current={view.section} onPick={(section) => setView({ section })} onPickLanguage={(language) => setView({ section: 'editor', language })} />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-12 py-8">
            <SectionContent
              key={revision} section={view.section} language={view.language} onLanguage={(language) => setView({ section: 'editor', language })} draft={draft} info={info} state={state} error={error} source={source} onChange={applyEdit} onCapSaved={capSaved}
              flow={{
                options, githubProjects, github, filterOptions, focus,
                onConnectGithub: () => void connect(), onLoadProjects: (row) => void loadProjects(row), onLoadColumns: (row) => void loadColumns(draft, row),
                onOpenSource: (id) => setView({ section: 'flow', source: id }), onAddSource: addSource, onOpenRules: () => setView({ section: 'rules' }),
              }}
            />
          </div>
          {view.section !== 'maintenance' && <SettingsFooter changed={changed} saving={saving} savableUnchanged={!info.configured} saveError={saveError} onRevert={() => setConfirm('revert')} onSave={() => void save()} />}
        </main>
      </div>
      <Confirm open={confirm !== undefined} onOpenChange={(open) => { if (!open) setConfirm(undefined); }} message={t('settings.discard.message')} confirmLabel={t('settings.discard.confirm')} onConfirm={discard} />
      <Confirm open={moves !== undefined} onOpenChange={(open) => { if (!open) setMoves(undefined); }} message={deletionMessage(moves ?? [])} confirmLabel={t('settings.stages.deleteMoves.confirm')} onConfirm={() => void save(true)} />
    </div>
    </WorkspaceColorsContext.Provider>
  );
}
