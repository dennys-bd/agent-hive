// The Monaco providers of a language served by LSP (#780): registered once per Monaco language and feature, each looks its model up and asks
// that model's client; a client whose server did not advertise the feature answers nothing.
import type * as Monaco from 'monaco-editor';
import type { CodeAction, Command, CompletionItem, CompletionList, Definition, Hover, LocationLink, ServerCapabilities } from 'vscode-languageserver-protocol';
import type { LspClient } from '@/lib/lsp-client';
import { locationsOf, markerToDiagnostic, type MonacoEnums, quickFixEdits, toCompletionContext, toDocumentation, toLspPosition, toLspRange, toMarkdown, toRange, toSuggestion } from '@/lib/lsp-convert';

export type MonacoApi = typeof Monaco;
/** A model's client (#780, #782): its pane path, the session's key, and whether it is a checker's own server (quick fixes only). */
export interface Route { client: LspClient; path: string; activityId: string; key: string; isChecker: boolean }
/** A model's clients, the language's server first (#782). */
export type RoutesOf = (model: Monaco.editor.ITextModel) => readonly Route[];
export type Feature = 'completion' | 'hover' | 'definition' | 'codeAction';
export const FEATURES: readonly Feature[] = ['completion', 'hover', 'definition', 'codeAction'];

const CAPABILITY: Record<Feature, keyof ServerCapabilities> = { completion: 'completionProvider', hover: 'hoverProvider', definition: 'definitionProvider', codeAction: 'codeActionProvider' };
/** Whether a server advertised a feature (#780): a capability it does not advertise gets no provider. */
export const hasFeature = (capabilities: ServerCapabilities | undefined, feature: Feature): boolean => Boolean(capabilities?.[CAPABILITY[feature]]);

/** Monaco's enum values (#780); its enum objects index by name. */
export const enumsOf = (m: MonacoApi): MonacoEnums => ({
  kinds: m.languages.CompletionItemKind as unknown as Record<string, number>, snippet: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
  severity: { Error: m.MarkerSeverity.Error, Warning: m.MarkerSeverity.Warning, Info: m.MarkerSeverity.Info, Hint: m.MarkerSeverity.Hint },
});

const docOf = (route: Route) => ({ textDocument: { uri: route.client.uriOf(route.path) } });
// The language's own client, when its server has the feature: a checker's client serves quick fixes only (#782); a failed request answers
// nothing, as Monaco expects
const served = (routesOf: RoutesOf, model: Monaco.editor.ITextModel, feature: Feature): Route | undefined =>
  routesOf(model).find((route) => !route.isChecker && hasFeature(route.client.capabilities, feature));

function completion(routesOf: RoutesOf, enums: MonacoEnums, triggerCharacters?: string[]): Monaco.languages.CompletionItemProvider {
  const origins = new WeakMap<object, { item: CompletionItem; route: Route }>();
  return {
    triggerCharacters,
    provideCompletionItems: async (model, position, context, token) => {
      const route = served(routesOf, model, 'completion');
      if (route === undefined) return undefined;
      const result = await route.client.request<CompletionItem[] | CompletionList | null>('textDocument/completion', { ...docOf(route), position: toLspPosition(position), context: toCompletionContext(context) }, token).catch(() => null);
      if (!result) return undefined;
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const items = Array.isArray(result) ? result : result.items;
      const suggestions = items.map((item) => { const s = toSuggestion(item, range, enums); origins.set(s, { item, route }); return s; });
      return { suggestions, incomplete: !Array.isArray(result) && result.isIncomplete };
    },
    resolveCompletionItem: async (suggestion, token) => {
      const origin = origins.get(suggestion);
      const provider = origin?.route.client.capabilities?.completionProvider;
      if (origin === undefined || !provider?.resolveProvider) return suggestion;
      const resolved = await origin.route.client.request<CompletionItem>('completionItem/resolve', origin.item, token).catch(() => origin.item);
      const documentation = toDocumentation(resolved.documentation);
      return { ...suggestion, ...(resolved.detail ? { detail: resolved.detail } : {}), ...(documentation === undefined ? {} : { documentation }) };
    },
  };
}

const hover = (routesOf: RoutesOf): Monaco.languages.HoverProvider => ({
  provideHover: async (model, position, token) => {
    const route = served(routesOf, model, 'hover');
    const result = route && (await route.client.request<Hover | null>('textDocument/hover', { ...docOf(route), position: toLspPosition(position) }, token).catch(() => null));
    return result ? { contents: toMarkdown(result.contents), ...(result.range ? { range: toRange(result.range) } : {}) } : undefined;
  },
});

// A location in this file is the model's own, so Monaco moves the cursor; another file's URI goes to the editor opener lsp-session registers
const definition = (routesOf: RoutesOf, m: MonacoApi): Monaco.languages.DefinitionProvider => ({
  provideDefinition: async (model, position, token) => {
    const route = served(routesOf, model, 'definition');
    if (route === undefined) return undefined;
    const result = await route.client.request<Definition | LocationLink[] | null>('textDocument/definition', { ...docOf(route), position: toLspPosition(position) }, token).catch(() => null);
    return locationsOf(result).map((l) => ({ uri: route.client.pathOf(l.uri) === route.path ? model.uri : m.Uri.parse(l.uri), range: toRange(l.range) }));
  },
});

// One client's quick fixes (#780): an action editing this file alone becomes Monaco's edit on the model, which turns dirty as typing does
async function fixesOf(route: Route, model: Monaco.editor.ITextModel, range: Monaco.Range, context: Monaco.languages.CodeActionContext, token: Monaco.CancellationToken, enums: MonacoEnums): Promise<Monaco.languages.CodeAction[]> {
  const uri = route.client.uriOf(route.path);
  const params = { ...docOf(route), range: toLspRange(range), context: { diagnostics: context.markers.map((m) => markerToDiagnostic(m, enums)), only: ['quickfix'] } };
  const result = await route.client.request<(Command | CodeAction)[] | null>('textDocument/codeAction', params, token).catch(() => null);
  return (result ?? []).flatMap((action) => {
    const edits = quickFixEdits(action, uri);
    return edits === undefined ? [] : [{
      title: action.title, kind: 'quickfix', diagnostics: context.markers,
      edit: { edits: edits.map((e) => ({ resource: model.uri, textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined })) },
    }];
  });
}

// Quick fixes only (#780), from every client of the model whose server offers them: the language's and its checkers' (#782)
const codeAction = (routesOf: RoutesOf, enums: MonacoEnums): Monaco.languages.CodeActionProvider => ({
  provideCodeActions: async (model, range, context, token) => {
    const routes = routesOf(model).filter((route) => hasFeature(route.client.capabilities, 'codeAction'));
    if (routes.length === 0) return undefined;
    const lists = await Promise.all(routes.map((route) => fixesOf(route, model, range, context, token, enums)));
    return { actions: lists.flat(), dispose: () => undefined };
  },
});

/** Registers one feature's provider for a Monaco language (#780), a completion's with the server's trigger characters; the caller registers each (language, feature) once. */
export function registerFeature(m: MonacoApi, language: string, feature: Feature, routesOf: RoutesOf, triggerCharacters?: string[]): void {
  const enums = enumsOf(m);
  if (feature === 'completion') m.languages.registerCompletionItemProvider(language, completion(routesOf, enums, triggerCharacters));
  else if (feature === 'hover') m.languages.registerHoverProvider(language, hover(routesOf));
  else if (feature === 'definition') m.languages.registerDefinitionProvider(language, definition(routesOf, m));
  else m.languages.registerCodeActionProvider(language, codeAction(routesOf, enums), { providedCodeActionKinds: ['quickfix'] });
}
