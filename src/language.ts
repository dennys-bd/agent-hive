import type { Language } from './types.js';

export const LANGUAGES: readonly Language[] = ['pt', 'en'];
const PORTUGUESE = /^pt\b/i; // pt, pt-BR, PT-PT; the issue fixes English as the fallback for everything else

/** The UI language for a BCP 47 locale: Portuguese for any `pt*` tag, English for anything else or nothing at all. */
export function languageFrom(locale: string | undefined): Language {
  return locale !== undefined && PORTUGUESE.test(locale) ? 'pt' : 'en';
}

/** What the process runs under: Node resolves it from LANG; Electron passes app.getLocale() instead. */
export function systemLanguage(): Language {
  return languageFrom(Intl.DateTimeFormat().resolvedOptions().locale);
}
