import type { ReactNode } from 'react';
import { AppSection, searchEntries as appEntries } from '@/components/settings/AppSection';
import { EditorSection, searchEntries as editorEntries } from '@/components/settings/EditorSection';
import { ExecutionSection, searchEntries as executionEntries } from '@/components/settings/ExecutionSection';
import { FlowSection, type FlowProps, searchEntries as flowEntries } from '@/components/settings/FlowSection';
import { RulesTab, searchEntries as rulesEntries } from '@/components/settings/RulesTab';
import { ShortcutsTab, searchEntries as shortcutsEntries } from '@/components/settings/ShortcutsTab';
import { WorkspacesSection, searchEntries as workspacesEntries } from '@/components/settings/WorkspacesSection';
import { WorktreesTab, searchEntries as maintenanceEntries } from '@/components/settings/WorktreesTab';
import { Button } from '@/components/ui/button';
import { LOCALE, t } from '@/i18n';
import type { SettingEntry } from '@/lib/settings-search';
import type { SettingsSection } from '@/lib/settings-sections';
import { type SourceDraft, emptyWorkspace, type SettingsDraft } from '@/lib/settings-form';
import type { LanguageId, SettingsInfo, State } from '../../../types';

interface SectionContentProps {
  section: SettingsSection; draft: SettingsDraft; info: SettingsInfo; state?: State; error?: string; source?: SourceDraft;
  flow: FlowProps; language?: LanguageId; onLanguage(language: LanguageId): void; onChange(patch: Partial<SettingsDraft>): void; onCapSaved(workspace: string, cap: number): void;
}

// The breadcrumb over a source's detail page (#514), or today's heading + description on any list page, with the section's action on its right.
function SectionHeading({ section, source, action, onBack }: { section: SettingsSection; source?: SourceDraft; action?: ReactNode; onBack(): void }) {
  if (!source) {
    return (
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-lg leading-none">{t(`settings.section.${section}`)}</h1>
          <p className="text-muted-foreground text-xs">{t(`settings.section.${section}.description`)}</p>
        </div>
        {action}
      </header>
    );
  }
  const name = source.name.trim() || t('settings.source.unnamed');
  return (
    <div className="flex flex-col gap-1">
      <nav aria-label={t('settings.source.crumb')} className="flex items-center gap-1 text-muted-foreground text-xs">
        <button type="button" className="hover:underline" onClick={onBack}>{t(`settings.section.${section}`)}</button>
        <span aria-hidden>/</span>
        <button type="button" className="hover:underline" onClick={onBack}>{t('settings.sources')}</button>
        <span aria-hidden>/</span>
        <span>{name}</span>
      </nav>
      <h1 className="font-semibold text-lg leading-none">{name}</h1>
    </div>
  );
}

export function SectionContent({ section, error, source, ...props }: SectionContentProps) {
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <SectionHeading section={section} source={source} action={headingAction(section, props)} onBack={() => props.flow.onOpenSource(undefined)} />
      {error && <p role="alert" className="whitespace-pre-wrap text-destructive text-sm">{error}</p>}
      {body(section, source, props)}
    </div>
  );
}

// + workspace lives on the heading row, as in the design, not under the last card.
function headingAction(section: SettingsSection, { draft, onChange }: Pick<SectionContentProps, 'draft' | 'onChange'>): ReactNode {
  if (section !== 'workspaces') return undefined;
  return <Button type="button" variant="outline" size="sm" onClick={() => onChange({ workspaces: [...draft.workspaces, emptyWorkspace(draft.workspaces)] })}>{t('settings.workspaces.add')}</Button>;
}

// One component per section (#510); #511–#516 swap these one by one. flow carries what only the flow section needs (#514).
function body(section: SettingsSection, source: SourceDraft | undefined, { draft, info, state, flow, language, onLanguage, onChange, onCapSaved }: Omit<SectionContentProps, 'section' | 'error' | 'source'>): ReactNode {
  switch (section) {
    case 'workspaces': return <WorkspacesSection draft={draft} state={state} savedNames={(info.config?.comb.workspaces ?? []).map((w) => w.name)} onChange={onChange} onCapSaved={onCapSaved} />;
    case 'flow': return <FlowSection draft={draft} source={source} flow={flow} agents={info.agents} onChange={onChange} />;
    case 'execution': return <ExecutionSection draft={draft} agents={info.agents} onChange={onChange} onOpenFlow={() => flow.onOpenSource(undefined)} />;
    case 'rules': return <RulesTab draft={draft} state={state} locale={LOCALE[info.language]} onChange={onChange} />;
    case 'app': return <AppSection draft={draft} onChange={onChange} />;
    case 'editor': return <EditorSection draft={draft} language={language} onLanguage={onLanguage} onChange={onChange} />;
    case 'shortcuts': return <ShortcutsTab shortcuts={draft.shortcuts} onChange={(shortcuts) => onChange({ shortcuts })} />;
    case 'maintenance': return <WorktreesTab state={state} />;
  }
}

/** Every entry of the Settings search (#689), in nav order: each section's module declares its own; a Record, so a new section fails tsc until it does. */
export function settingsEntries(draft: SettingsDraft, offered: readonly SettingsSection[]): SettingEntry[] {
  const bySection: Record<SettingsSection, () => SettingEntry[]> = {
    workspaces: () => workspacesEntries(draft), flow: () => flowEntries(draft), execution: executionEntries, rules: rulesEntries,
    app: appEntries, editor: editorEntries, shortcuts: shortcutsEntries, maintenance: maintenanceEntries,
  };
  return offered.flatMap((section) => bySection[section]());
}
