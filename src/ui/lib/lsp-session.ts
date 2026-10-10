// The page's language servers (#780) and the checkers' own (#782): one LspClient per (activity, server binary), opened with the first model it
// serves and closed with its last. A model is served by its language's server when the catalog has one and the workspace is in its scope, and by
// each language-server checker of its language that is on there; the daemon checks again. Diagnostics become the model's markers (`lsp` for the
// language's server, `lsp:<server>` for a checker's) and the store's problems; a definition in another file opens it through the pane's opener.
import type { editor } from 'monaco-editor';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { checkerOn, type LspCheckerDef, lspCheckersOf } from '../../checkers';
import { otherExtensions } from '../../formatters';
import { extensionOf, inScope, languageOf, lspLanguageId, serverDef, serverFor } from '../../languages';
import * as store from '@/lib/diagnostics-store';
import type { ServerPhase } from '@/lib/diagnostics-store';
import { onEditorInstall } from '@/lib/editor-install-events';
import { loadMonaco } from '@/lib/editor-models';
import { LspClient, type LspSocket } from '@/lib/lsp-client';
import { toMarker, toProblems } from '@/lib/lsp-convert';
import { enumsOf, type Feature, FEATURES, hasFeature, type MonacoApi, registerFeature, type Route } from '@/lib/lsp-providers';
import type { CheckerId, EditorConfig, LanguageId, ServerId } from '../../types';

export interface AttachInput { activityId: string; workspace: string; path: string; model: editor.ITextModel; editor: EditorConfig }
export type OpenAt = (path: string, at: { line: number; col: number }) => void;
type Attached = { model: editor.ITextModel; language: LanguageId };
interface Target { key: string; activityId: string; server: ServerId; binary: string; checker?: CheckerId; args: readonly string[] } // args: a checker's extra ones, which the daemon's process is keyed by
interface Session extends Target { client: LspClient; docs: Map<string, Attached>; phase: ServerPhase['phase'] }

const CHECKER_FEATURES: readonly Feature[] = ['codeAction']; // a linter's hover or completion would repeat the language's
const sessions = new Map<string, Session>();
const routes = new WeakMap<object, readonly Route[]>(); // a model → its clients and pane path, the language's server first
const openers = new Map<string, OpenAt>();
const registered = new Set<string>(); // `${monaco language}:${feature}`
let makeSocket = (url: string): LspSocket => new WebSocket(url);
let stopInstalls: (() => void) | undefined;
let hasOpener = false;

/** Tests swap the WebSocket for a fake. */
export const setSocketFactory = (factory: (url: string) => LspSocket): void => { makeSocket = factory; };
const socketUrl = (activityId: string, server: ServerId, binary: string): string =>
  `ws://${location.host}/activities/${encodeURIComponent(activityId)}/lsp/${encodeURIComponent(server)}?${new URLSearchParams({ bin: binary })}`;
const routesOf = (model: editor.ITextModel): readonly Route[] => routes.get(model) ?? [];
const ownerOf = (session: Session): string => (session.checker === undefined ? 'lsp' : `lsp:${session.server}`);

// The editor opener (#780): a definition in another file opens it in the activity's editor pane, at its line
function registerOpener(m: MonacoApi): void {
  if (hasOpener) return;
  hasOpener = true;
  m.editor.registerEditorOpener({
    openCodeEditor: (source, resource, selection) => {
      const route = routes.get(source.getModel() ?? {})?.find((r) => !r.isChecker);
      const opener = route && openers.get(route.activityId);
      if (route === undefined || opener === undefined) return false;
      const at = selection === undefined ? { line: 1, col: 1 } : 'startLineNumber' in selection ? { line: selection.startLineNumber, col: selection.startColumn } : { line: selection.lineNumber, col: selection.column };
      opener(route.client.pathOf(resource.toString()), at);
      return true;
    },
  });
}

async function registerFor(session: Session): Promise<void> {
  const { monaco } = await loadMonaco();
  registerOpener(monaco);
  const features = session.checker === undefined ? FEATURES : CHECKER_FEATURES;
  for (const { model } of session.docs.values()) {
    for (const feature of features) {
      const key = `${model.getLanguageId()}:${feature}`;
      if (registered.has(key) || !hasFeature(session.client.capabilities, feature)) continue;
      registered.add(key);
      registerFeature(monaco, model.getLanguageId(), feature, routesOf, session.client.capabilities?.completionProvider?.triggerCharacters);
    }
  }
}

async function diagnosed(session: Session, uri: string, diagnostics: Diagnostic[]): Promise<void> {
  const path = session.client.pathOf(uri);
  store.setDiagnostics(session.key, path, toProblems(path, diagnostics, session.checker ?? session.server));
  const attached = session.docs.get(path);
  if (attached === undefined) return;
  const { monaco } = await loadMonaco();
  monaco.editor.setModelMarkers(attached.model, ownerOf(session), diagnostics.map((d) => toMarker(d, enumsOf(monaco))));
}

// A client that left ready (crash, removal, dispose) must not leave its squiggles: they only mean something while the server is there
function clearMarkers(session: Session): void {
  const models = [...session.docs.values()].map((a) => a.model);
  const owner = ownerOf(session);
  if (models.length > 0) void loadMonaco().then(({ monaco }) => { for (const model of models) monaco.editor.setModelMarkers(model, owner, []); });
}

function connect(target: Target): Session {
  const holder: { session?: Session } = {};
  const client = new LspClient(makeSocket(socketUrl(target.activityId, target.server, target.binary)), {
    phase: (phase, log) => {
      store.setClient(target.key, target.activityId, target.server, phase, log, target.checker);
      const current = holder.session;
      if (current === undefined) return; // the constructor's first phase, before the session exists
      current.phase = phase.phase;
      if (phase.phase === 'ready') void registerFor(current);
      else clearMarkers(current);
    },
    diagnostics: (uri, list) => { if (holder.session) void diagnosed(holder.session, uri, list); },
  });
  holder.session = { ...target, client, docs: new Map(), phase: 'starting' };
  sessions.set(target.key, holder.session);
  return holder.session;
}

function open(session: Session, path: string, attached: Attached): void {
  session.docs.set(path, attached);
  const route: Route = { client: session.client, path, activityId: session.activityId, key: session.key, isChecker: session.checker !== undefined };
  routes.set(attached.model, [...routesOf(attached.model).filter((r) => r.key !== session.key), route]);
  store.bindFile(session.activityId, path, session.key, attached.language);
  session.client.open(path, lspLanguageId(path), attached.model);
}

// The same files on a new client: the old one is disposed, its markers cleared
function reconnect(session: Session): Session {
  clearMarkers(session);
  session.client.dispose();
  const { key, activityId, server, binary, checker, args } = session;
  const fresh = connect({ key, activityId, server, binary, args, ...(checker === undefined ? {} : { checker }) });
  for (const [path, attached] of session.docs) open(fresh, path, attached);
  return fresh;
}

// A server installed in Settings (#780): its clients that found it absent start again with the same files
function restartAbsent(server: ServerId): void {
  for (const session of [...sessions.values()]) if (session.server === server && session.phase === 'absent') reconnect(session);
}

function detach(key: string, path: string, model: editor.ITextModel): void {
  const session = sessions.get(key);
  if (session === undefined) return;
  session.client.close(path);
  session.docs.delete(path);
  routes.set(model, routesOf(model).filter((r) => r.key !== key));
  store.unbindFile(session.activityId, path, key);
  const owner = ownerOf(session);
  void loadMonaco().then(({ monaco }) => monaco.editor.setModelMarkers(model, owner, []));
  if (session.docs.size > 0) return;
  session.client.dispose();
  sessions.delete(key);
  store.dropClient(key);
}

// A checker's extra args as the daemon reads them: one process serves all its languages, the first that sets some gives them (src/lsp-host.ts)
const extraArgs = (config: EditorConfig, def: LspCheckerDef): readonly string[] =>
  def.languages.map((l) => config.languages[l]?.checkers?.[def.id]?.args).find((args) => args !== undefined && args.length > 0) ?? [];

// The clients that serve a file in a workspace (#780, #782): its language's server when in scope, then its language-server checkers that are on
function targetsFor(activityId: string, path: string, workspace: string, config: EditorConfig): { language: LanguageId; targets: Target[] } | undefined {
  const language = languageOf(path, otherExtensions(config));
  if (language === undefined) return undefined;
  const served = serverFor(language, extensionOf(path));
  const own = served !== undefined && inScope(config.languages[language]?.server?.workspaces ?? 'all', workspace) ? [{ server: served.server.id, binary: served.binary, args: [] as readonly string[] }] : [];
  const checkers = lspCheckersOf(language).filter((def) => checkerOn(config, language, def.id, workspace))
    .map((def) => ({ server: def.server, binary: serverDef(def.server).binaries[0], checker: def.id, args: extraArgs(config, def) }));
  return { language, targets: [...own, ...checkers].map((t) => ({ ...t, activityId, key: `${activityId}\0${t.binary}${t.args.length > 0 ? `\0${JSON.stringify(t.args)}` : ''}` })) };
}

/** The binaries that would serve a file (#780, #782) with their checkers' extra args, joined; undefined for none: what the pane keys its attach
 * on, so a Settings save that changes nothing for this file does not reconnect it, and new args do. */
export function attachKey(path: string, workspace: string, config: EditorConfig): string | undefined {
  const parts = targetsFor('', path, workspace, config)?.targets.map((t) => (t.args.length > 0 ? `${t.binary}${JSON.stringify(t.args)}` : t.binary)) ?? [];
  return parts.length === 0 ? undefined : parts.join(' ');
}

// The session of a target: a new one, the running one, or a new one in place of one that ended
function sessionFor(target: Target): Session {
  const existing = sessions.get(target.key);
  if (existing === undefined) return connect(target);
  // a client that failed, was removed or is out of scope is never ready again by itself: this file starts it anew
  return existing.phase === 'starting' || existing.phase === 'ready' ? existing : reconnect(existing);
}

/** Serves `model` with its language's server and its language-server checkers (#780, #782), each in the config's scope; returns the detach. */
export function attach({ activityId, workspace, path, model, editor: config }: AttachInput): () => void {
  stopInstalls ??= onEditorInstall((event) => { if (event.kind === 'server' && event.state.state === 'installed') restartAbsent(event.id); });
  const found = targetsFor(activityId, path, workspace, config);
  if (found === undefined) return () => undefined;
  for (const target of found.targets) open(sessionFor(target), path, { model, language: found.language });
  return () => { for (const target of found.targets) detach(target.key, path, model); };
}

/** A save went through (#780): didSave to the file's servers. */
export function notifySaved(activityId: string, path: string): void {
  for (const session of sessions.values()) if (session.activityId === activityId && session.docs.has(path)) session.client.saved(path);
}

/** How a definition in another file of `activityId` opens (#780): the pane's useOpenFile. Returns the remove, which leaves a newer one. */
export function setOpener(activityId: string, opener: OpenAt): () => void {
  openers.set(activityId, opener);
  return () => { if (openers.get(activityId) === opener) openers.delete(activityId); };
}

/** Forgets every session (a test's reset). */
export function resetSessions(): void {
  for (const session of sessions.values()) session.client.dispose();
  sessions.clear();
  openers.clear();
  registered.clear();
  stopInstalls?.();
  stopInstalls = undefined;
  hasOpener = false;
}
