import { CheckersSection } from '@/components/settings/CheckersSection';
import { FormattersEditor } from '@/components/settings/FormattersEditor';
import { InstallRow } from '@/components/settings/InstallRow';
import { WorkspaceScopePicker } from '@/components/settings/WorkspaceScopePicker';
import { CardGroup } from '@/components/settings/WorkspacesEditor';
import { t } from '@/i18n';
import type { LanguageDraft } from '@/lib/settings-format';
import { settingAnchor } from '@/lib/settings-search';
import { type LanguageDef, serverDef } from '../../../languages';
import type { CheckerState, EditorInstalls, FormatterState, InstallAction, InstallTarget } from '../../../types';

interface LanguageDetailProps {
  language: LanguageDef; draft: LanguageDraft; names: readonly string[]; installs?: EditorInstalls; states?: FormatterState[]; checkerStates?: CheckerState[];
  onAct(target: InstallTarget, action: InstallAction): void; onChange(draft: LanguageDraft): void;
}

const VIA_TOOL = { npm: 'npm', toolchain: 'go install', github: '', system: '' } as const; // requer's hint: what the install runs

function SyntaxRow({ language, installs, onAct }: Pick<LanguageDetailProps, 'language' | 'installs' | 'onAct'>) {
  const { syntax } = language;
  if (syntax === 'builtin') return <InstallRow name={t('settings.syntax.monaco')} via={t('settings.syntax.builtinSource')} state={{ state: 'builtin' }} onAct={() => undefined} />;
  if (syntax === undefined) return null;
  return <InstallRow name={syntax} via={t('settings.syntax.source')} state={installs?.syntaxes[syntax]} onAct={(action) => onAct({ kind: 'syntax', id: syntax }, action)} />;
}

function ServerRow({ language, draft, names, installs, onAct, onChange }: Omit<LanguageDetailProps, 'states' | 'checkerStates'>) {
  if (language.server === undefined) return <p className="text-muted-foreground text-xs">{t('settings.server.none')}</p>;
  const server = serverDef(language.server);
  const { id } = server;
  const state = installs?.servers[id];
  const tool = state?.state === 'requires' ? state.tool : '';
  return (
    <InstallRow
      name={id} via={t(`settings.server.via.${server.install}`)} state={state} isOff={draft.server !== 'all' && draft.server.length === 0}
      requiresHint={t('settings.install.requiresHint', { server: id, via: VIA_TOOL[server.install], tool })}
      scope={<WorkspaceScopePicker label={t('settings.scope.of', { item: id })} scope={draft.server} names={names} onChange={(scope) => onChange({ ...draft, server: scope })} />}
      onAct={(action) => onAct({ kind: 'server', id }, action)}
    />
  );
}

/** The selected language (#780): its syntax, its language server with its chips, its formatters and its checkers (#782); other has formatters only. */
export function LanguageDetail(props: LanguageDetailProps) {
  const { language, draft, names, states, onChange } = props;
  const name = t(`editor.language.${language.id}`);
  return (
    <section id={settingAnchor('settings.languages', language.id)} aria-label={name} className="flex min-w-0 flex-col gap-4 p-5">
      <header className="flex items-baseline gap-3">
        <h3 className="font-semibold text-lg leading-none">{name}</h3>
        <span className="font-mono text-muted-foreground text-xs">{language.extensions.join(' ')}</span>
      </header>
      {language.syntax !== undefined && <CardGroup title={t('settings.syntax')} hint={t('settings.syntax.hint')} anchor={settingAnchor('settings.syntax', language.id)}><SyntaxRow {...props} /></CardGroup>}
      {language.id !== 'other' && <CardGroup title={t('settings.server')} hint={t('settings.server.hint')} anchor={settingAnchor('settings.server', language.id)}><ServerRow {...props} /></CardGroup>}
      <CardGroup title={t('settings.formatters')} hint={t('settings.formatters.hint')} anchor={settingAnchor('settings.formatters', language.id)}>
        <FormattersEditor language={language} draft={draft} names={names} states={states} onChange={onChange} />
      </CardGroup>
      <CardGroup title={t('settings.checkers')} hint={t('settings.checkers.hint')} anchor={settingAnchor('settings.checkers', language.id)}>
        <CheckersSection language={language} draft={draft} names={names} installs={props.installs} states={props.checkerStates} onAct={props.onAct} onChange={onChange} />
      </CardGroup>
    </section>
  );
}
