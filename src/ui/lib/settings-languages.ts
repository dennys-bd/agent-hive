// Settings › editor's languages as data (#780): which ones the list shows, what each row's summary and status say, the workspace chips'
// semantics and the formatters' detection. Pure, so node:test checks it; the components only render it.
import { formattersOf } from '../../formatters.js';
import { inScope, LANGUAGES, type LanguageDef } from '../../languages.js';
import type { EditorInstallEvent, EditorInstalls, FormatterState, InstallState, LanguageId, WorkspaceScope } from '../../types.js';

/** A list row's status word (#780). */
export type LanguageStatus = { kind: 'installing' } | { kind: 'failed' } | { kind: 'requires'; tool: string } | { kind: 'update' };
export type LanguageShow = 'all' | 'installed' | 'attention';
const RANK: Record<LanguageStatus['kind'], number> = { installing: 0, failed: 1, requires: 2, update: 3 };

/** An installed item whose latest differs: atualização disponível (#780). */
export const isUpdate = (state: InstallState): state is { state: 'installed'; version: string; latest: string } =>
  state.state === 'installed' && state.latest !== undefined && state.latest !== state.version;

export function statusOfState(state: InstallState | undefined): LanguageStatus | undefined {
  if (state === undefined) return undefined;
  if (state.state === 'installing' || state.state === 'failed') return { kind: state.state };
  if (state.state === 'requires') return { kind: 'requires', tool: state.tool };
  return isUpdate(state) ? { kind: 'update' } : undefined;
}

const itemsOf = (def: LanguageDef, installs?: EditorInstalls): (InstallState | undefined)[] => [
  def.syntax !== undefined && def.syntax !== 'builtin' ? installs?.syntaxes[def.syntax] : undefined,
  def.server !== undefined ? installs?.servers[def.server] : undefined,
];

/** The language's most urgent status over its syntax and its server (#780): installing › failed › requires › update. */
export const languageStatus = (def: LanguageDef, installs?: EditorInstalls): LanguageStatus | undefined =>
  itemsOf(def, installs).map(statusOfState).filter((s): s is LanguageStatus => s !== undefined).sort((a, b) => RANK[a.kind] - RANK[b.kind])[0];

/** instaladas (#780): a builtin syntax, or a syntax or server installed (an update included). */
export const isInstalledLanguage = (def: LanguageDef, installs?: EditorInstalls): boolean =>
  def.syntax === 'builtin' || itemsOf(def, installs).some((s) => s?.state === 'installed');

/** A row's summary (#780): the installed server, then the formatters found in some workspace; empty reads nada instalado. */
export function summaryOf(def: LanguageDef, installs?: EditorInstalls, states?: FormatterState[]): string[] {
  const server = def.server !== undefined && installs?.servers[def.server]?.state === 'installed' ? [def.server] : [];
  return [...server, ...formattersOf(def.id).filter((id) => (states?.find((s) => s.id === id)?.found.length ?? 0) > 0)];
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Whether the filter matches a language (#780): its name, extensions, server, syntax package or formatters, accents and case aside. */
export function matchesLanguage(def: LanguageDef, name: string, query: string): boolean {
  const q = fold(query.trim());
  return q === '' || [name, ...def.extensions, def.server ?? '', def.syntax ?? '', ...formattersOf(def.id)].some((text) => fold(text).includes(q));
}

/** The languages the list shows (#780), in the catalog's order. */
export function shownLanguages(query: string, show: LanguageShow, installs: EditorInstalls | undefined, nameOf: (id: LanguageId) => string): LanguageDef[] {
  return LANGUAGES.filter((def) => matchesLanguage(def, nameOf(def.id), query)).filter((def) => {
    if (show === 'installed') return isInstalledLanguage(def, installs);
    return show === 'all' || languageStatus(def, installs) !== undefined;
  });
}

/** atenção · {n} (#780). */
export const attentionCount = (installs?: EditorInstalls): number => LANGUAGES.filter((def) => languageStatus(def, installs) !== undefined).length;

/** A workspace ticked or unticked in the chips (#780): from all, the explicit list without it; a list keeps the workspaces' order. Ticking every
 * one is still a list: only all takes the workspaces added later. */
export function toggleScope(scope: WorkspaceScope, name: string, on: boolean, names: readonly string[]): WorkspaceScope {
  const current = scope === 'all' ? names : scope;
  const next = on ? [...current, name] : current.filter((n) => n !== name);
  return names.filter((n) => next.includes(n));
}

/** A supported formatter's detection in its scope (#780). */
export type Detection = { kind: 'found'; workspaces: string[] } | { kind: 'notFound' } | { kind: 'off' } | { kind: 'unknown' };
export function detectionOf(state: FormatterState | undefined, scope: WorkspaceScope): Detection {
  if (scope !== 'all' && scope.length === 0) return { kind: 'off' };
  if (state === undefined) return { kind: 'unknown' };
  const workspaces = state.found.filter((name) => inScope(scope, name));
  return workspaces.length > 0 ? { kind: 'found', workspaces } : { kind: 'notFound' };
}

/** Names as one phrase (#780): a, b and c. */
export const listOf = (names: readonly string[], and: string): string =>
  (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)}`);

/** The listing with one item's new state (#780). */
export function withInstallEvent(installs: EditorInstalls, event: EditorInstallEvent): EditorInstalls {
  return event.kind === 'server'
    ? { ...installs, servers: { ...installs.servers, [event.id]: event.state } }
    : { ...installs, syntaxes: { ...installs.syntaxes, [event.id]: event.state } };
}
