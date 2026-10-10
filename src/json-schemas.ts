// The file name → schema associations of vscode-json-language-server (#794): SchemaStore's public catalog, fetched by the daemon. VS Code's
// client feeds them to the server; without them a file gets a schema only from its own $schema. The schemas themselves the server downloads.
export const SCHEMA_CATALOG_URL = 'https://www.schemastore.org/api/json/catalog.json';
export const SCHEMA_CATALOG_TIMEOUT_MS = 10_000;

export interface SchemaAssociation { uri: string; fileMatch: string[] }
export type CatalogLoad = { associations: SchemaAssociation[] } | { failure: string };
export interface SchemaCatalog { load(): Promise<CatalogLoad> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isHttpsUrl = (value: unknown): value is string => typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:';
const isPatterns = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((p: unknown) => typeof p === 'string');
const hasSchemas = (raw: unknown): raw is { schemas: unknown[] } => isRecord(raw) && Array.isArray(raw.schemas);

/** The catalog's entries the server can use (#794): external data, so an entry is dropped unless its url is https and it names files. */
export function parseCatalog(raw: unknown): SchemaAssociation[] {
  if (!hasSchemas(raw)) return [];
  return raw.schemas.flatMap((entry: unknown) => (isRecord(entry) && isHttpsUrl(entry.url) && isPatterns(entry.fileMatch) ? [{ uri: entry.url, fileMatch: [...entry.fileMatch] }] : []));
}

const parseJson = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return undefined; }
};

// What the console run says: the abort of the timeout signal, else the network error's code (undici puts it on the cause)
function failureOf(err: unknown): string {
  if (isRecord(err) && err.name === 'TimeoutError') return 'timeout';
  const cause = err instanceof Error ? err.cause : undefined;
  return isRecord(cause) && typeof cause.code === 'string' ? cause.code : 'network error';
}

async function fetchCatalog(doFetch: typeof fetch): Promise<CatalogLoad> {
  try {
    const res = await doFetch(SCHEMA_CATALOG_URL, { signal: AbortSignal.timeout(SCHEMA_CATALOG_TIMEOUT_MS) });
    if (!res.ok) return { failure: `HTTP ${res.status}` };
    const body = parseJson(await res.text()); // text, not json(): a slow body still ends as the timeout, a bad one as invalid catalog
    return hasSchemas(body) ? { associations: parseCatalog(body) } : { failure: 'invalid catalog' };
  } catch (err) {
    return { failure: failureOf(err) };
  }
}

/** One catalog per boot (#794): a success is kept, concurrent loads share one request, a failure is forgotten so the next start retries. */
export function createSchemaCatalog(doFetch: typeof fetch = globalThis.fetch): SchemaCatalog {
  let loading: Promise<CatalogLoad> | undefined;
  return {
    load() {
      loading ??= fetchCatalog(doFetch).then((loaded) => {
        if ('failure' in loaded) loading = undefined;
        return loaded;
      });
      return loading;
    },
  };
}
