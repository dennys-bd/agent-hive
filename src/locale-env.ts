import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// A Hive opened from the Finder or the Dock inherits launchd's environment, which has neither LANG nor LC_CTYPE, so every pty ran under
// US-ASCII and accented text came out garbled (#667). The daemon fills what is missing once, at boot; every pty inherits it.

/** What the boot adds to the environment: never a value already set. */
export type LocaleAdditions = Partial<Record<'LANG' | 'LC_CTYPE', string>>;

const UTF8 = /utf-?8/i;
// The UTF-8 character type each system ships: macOS has no C.UTF-8, glibc and musl have no bare UTF-8
const ctypeFor = (platform: NodeJS.Platform): string => (platform === 'darwin' ? 'UTF-8' : 'C.UTF-8');

/**
 * LANG from the system locale when unset; then LC_CTYPE when the encoding in effect is still not UTF-8. An LC_ALL is the user's own
 * choice and outranks both, so with one set nothing is added; an LC_CTYPE already set is kept too, UTF-8 or not. The Hive's interface
 * language (#242) does not drive LANG: the pty's locale belongs to the user's tools, not to the Hive's copy.
 */
export function localeEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, systemLang: string | undefined): LocaleAdditions {
  if (env.LC_ALL) return {};
  const langAddition: LocaleAdditions = !env.LANG && systemLang ? { LANG: systemLang } : {};
  if (env.LC_CTYPE) return langAddition;
  return UTF8.test(env.LANG || systemLang || '') ? langAddition : { ...langAddition, LC_CTYPE: ctypeFor(platform) };
}

/** The system reads readSystemLang makes; each answers undefined on any failure. Tests hand fakes. */
export interface SystemReads {
  appleLocale(): string | undefined; // `defaults read -g AppleLocale`, e.g. pt_BR or en_BR@rg=brzzzz
  readFile(path: string): string | undefined;
  exists(path: string): boolean;
}

const DEFAULTS_TIMEOUT_MS = 2000; // a hung `defaults` must not stall the boot; no answer is no locale
const MAC_LOCALES = '/usr/share/locale';
const LINUX_LOCALE_FILES = ['/etc/locale.conf', '/etc/default/locale']; // systemd's, then Debian's
const LANG_LINE = /^LANG=["']?([^"'\s]+)["']?\s*$/m;
// What a locale name looks like (ll_CC.codeset@modifier): anything else, a path or shell text, is not taken as LANG
const LOCALE_SHAPE = /^[A-Za-z]{1,8}([_-][A-Za-z0-9_]+)?(\.[A-Za-z0-9-]+)?(@[A-Za-z0-9]+)?$/;
const shaped = (lang: string | undefined): string | undefined => (lang && LOCALE_SHAPE.test(lang) ? lang : undefined);

/** The system's locale as a LANG value, or undefined: macOS's AppleLocale when it is installed, else Linux's configured LANG. */
export function readSystemLang(platform: NodeJS.Platform, reads: SystemReads): string | undefined {
  if (platform === 'darwin') {
    const locale = reads.appleLocale()?.trim().split('@')[0];
    const lang = shaped(locale ? `${locale}.UTF-8` : undefined);
    return lang && reads.exists(`${MAC_LOCALES}/${lang}`) ? lang : undefined;
  }
  for (const file of LINUX_LOCALE_FILES) {
    const lang = shaped(LANG_LINE.exec(reads.readFile(file) ?? '')?.[1]);
    if (lang) return lang;
  }
  return undefined;
}

const orUndefined = (read: () => string): string | undefined => {
  try {
    return read();
  } catch {
    return undefined; // no locale to read is the same as no locale: the UTF-8 LC_CTYPE still applies
  }
};

export const SYSTEM_READS: SystemReads = {
  appleLocale: () => orUndefined(() => execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: DEFAULTS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })),
  readFile: (path) => orUndefined(() => readFileSync(path, 'utf8')),
  exists: existsSync,
};
