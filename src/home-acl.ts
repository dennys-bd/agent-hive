// The Hive's home holds the daemon secret and every session (#628). On win32 a home others can read is refused at boot: the profile default
// grants only SYSTEM, Administrators and the user, and anything beyond that is an extra allow ACE with read. The check takes the platform and
// its lookup, so node:test covers the parsing and the refusal on every OS.
import { execFileSync } from 'node:child_process';

export interface AclLookups { read(home: string): { sddl: string; userSid: string } }

const READ_MASK = 0x1 | 0x80000000 | 0x10000000; // FILE_READ_DATA (list), GENERIC_READ, GENERIC_ALL
const READ_CODES = ['FA', 'FR', 'GA', 'GR', 'CC']; // SDDL codes that include read; the rest (SD, WD, WO, RC, FW...) do not grant it
const ALWAYS_ALLOWED = ['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544', 'CO', 'S-1-3-0'];
const ICACLS_SID: Record<string, string> = { WD: 'S-1-1-0', BU: 'S-1-5-32-545', AU: 'S-1-5-11' };

function grantsRead(rights: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(rights)) return (Number(rights) & READ_MASK) !== 0;
  if (!/^([A-Z]{2})*$/.test(rights)) throw new Error(`unreadable rights "${rights}"`);
  return (rights.match(/../g) ?? []).some((code) => READ_CODES.includes(code));
}

/** The trustees, as written, that an allow ACE of `sddl`'s DACL lets read and that are neither `userSid` nor SYSTEM, Administrators, Creator Owner.
 *  Deny ACEs never refuse; inherited and inherit-only ACEs count. Throws on SDDL with no DACL or a malformed ACE. */
export function refusedPrincipals(sddl: string, userSid: string): string[] {
  const start = sddl.indexOf('D:');
  if (start < 0) throw new Error('no DACL in the security descriptor');
  const aces = sddl.slice(start).replace(/S:.*$/, '').match(/\([^()]*\)/g) ?? []; // S: opens the SACL; a SID is S-, never S:
  const refused = new Set<string>();
  for (const ace of aces) {
    const fields = ace.slice(1, -1).split(';');
    if (fields.length < 6 || !fields[5]) throw new Error(`malformed ACE ${ace}`);
    const [type, , rights, , , trustee] = fields as [string, string, string, string, string, string];
    if (type === 'A' && grantsRead(rights) && trustee !== userSid && !ALWAYS_ALLOWED.includes(trustee)) refused.add(trustee);
  }
  return [...refused];
}

const fix = (home: string, trustees: string[]): string => {
  const sids = trustees.map((t) => ICACLS_SID[t] ?? (t.startsWith('S-') ? t : undefined)).filter((s) => s !== undefined);
  return sids.length ? ` Remove that access (icacls "${home}" /remove ${sids.map((s) => `*${s}`).join(' ')})` : ' Remove that access.';
};

/** win32 only: throws one line when `home` is readable by anyone but its user, SYSTEM and Administrators, or when its access list cannot be read (fail closed). */
export function checkHomeAcl(platform: NodeJS.Platform, home: string, lookups: AclLookups): void {
  if (platform !== 'win32') return;
  let refused: string[];
  try {
    const { sddl, userSid } = lookups.read(home);
    refused = refusedPrincipals(sddl, userSid);
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
    throw new Error(`Agent Hive cannot read the access list of home ${home}: ${reason}`);
  }
  if (refused.length) throw new Error(`Agent Hive refuses home ${home}: readable by ${refused.join(', ')}.${fix(home, refused)}`);
}

// The path reaches PowerShell through the env only, never interpolated into the script
const SCRIPT = '(Get-Acl -LiteralPath $env:HIVE_ACL_HOME).Sddl; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value';

const REAL_LOOKUPS: AclLookups = {
  read: (home) => {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      env: { ...process.env, HIVE_ACL_HOME: home }, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [sddl, userSid] = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!sddl || !userSid) throw new Error('PowerShell answered no access list');
    return { sddl, userSid };
  },
};

export const checkHome = (home: string): void => checkHomeAcl(process.platform, home, REAL_LOOKUPS);
