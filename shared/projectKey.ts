// Project identity derived from a session's `cwd`.
//
// Why this is not just `cwd.toLowerCase()`: P0 measured the real session set and found two
// shapes a naive key gets wrong.
//
//   1. Windows path spelling is inconsistent between sessions — `\` vs `/`, upper- vs
//      lower-case drive letters, a trailing separator. Those must collapse to one key.
//   2. One real directory name contains U+200C ZERO WIDTH NON-JOINER
//      (`D:\AI Coding\simple\u200c-grid`). Windows treats that as a different directory, so the
//      key must keep the character or two genuinely different projects would be merged.
//
// The character is invisible, though: a user who also has `simple-grid` gets two project rows
// that look identical. Paths are therefore classified in two stages and the result reports which
// one applied, so a caller can surface the ambiguity instead of silently guessing:
//
//   exact   — same spelling
//   cf      — equal only once Unicode format characters (Cf) are removed
//   none    — different projects
//
// Implemented with plain string operations (no `node:path`) because this runs in the renderer.

export type ProjectKeyKind = "exact" | "cf" | "none";

export interface ProjectKey {
  /**
   * Stable identity: separators normalized, trailing separator dropped, lower-cased for
   * Windows-style paths (case-insensitive filesystem). Cf characters are preserved so distinct
   * directories stay distinct.
   */
  key: string;
  /**
   * Identity to group by when the goal is "one row per directory the user can see".
   * Equals `key` unless the path contained Cf characters, in which case those are removed.
   */
  displayKey: string;
  kind: ProjectKeyKind;
  /** True when `key !== displayKey`, i.e. the path contains invisible characters. */
  cfStripped: boolean;
  /** Path as written in the session metadata (trimmed, trailing separator dropped). */
  display: string;
}

const DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const DRIVE_ONLY_RE = /^[a-zA-Z]:$/;
const UNC_RE = /^[\\/]{2}[^\\/]/;
const POSIX_RE = /^\//;

/** A session cwd is Windows-shaped when it has a drive letter or a UNC prefix. */
export function isWindowsStylePath(raw: string): boolean {
  return DRIVE_RE.test(raw) || DRIVE_ONLY_RE.test(raw) || UNC_RE.test(raw);
}

export function isPosixStylePath(raw: string): boolean {
  return POSIX_RE.test(raw) && !UNC_RE.test(raw) && !DRIVE_RE.test(raw);
}

/**
 * Remove Unicode format characters (category Cf): zero-width joiners/non-joiners, bidi marks,
 * BOM, soft hyphen. They render as nothing, so paths differing only by them look identical.
 */
export function stripFormatChars(value: string): string {
  let out = "";
  for (const ch of value) {
    if (/\p{Cf}/u.test(ch)) continue;
    out += ch;
  }
  return out;
}

export function containsFormatChars(value: string): boolean {
  return stripFormatChars(value) !== value;
}

/**
 * Canonical comparable form.
 *
 * Windows-shaped paths: separators to `\`, drop trailing separators, drop `.` segments, resolve
 * `..` textually, collapse repeated separators, lower-case. `..` is resolved textually because
 * there is no filesystem access in the renderer; an already-normalized `cwd` (what sessions
 * record) is unaffected.
 *
 * POSIX-shaped paths: keep case, keep a single leading `/`.
 */
export function canonicalizeProjectPath(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return "";

  if (isPosixStylePath(trimmed)) {
    const parts = resolveSegments(
      trimmed.split("/").filter((part) => part.length > 0),
      false,
    );
    return `/${parts.join("/")}`;
  }

  const unc = UNC_RE.test(trimmed);
  const driveMatch = trimmed.match(/^([a-zA-Z]):/);
  const drive = driveMatch ? `${driveMatch[1].toLowerCase()}:` : "";
  const rest = drive ? trimmed.slice(2) : unc ? trimmed.slice(2) : trimmed;
  const parts = resolveSegments(
    rest.split(/[\\/]+/).filter((part) => part.length > 0),
    !!drive,
  );
  const joined = parts.join("\\");
  const prefix = unc ? "\\\\" : drive;
  const result = `${prefix}${drive && joined ? "\\" : ""}${joined}`;
  return result.toLowerCase();
}

/** Drop `.`, resolve `..` textually, and refuse to escape the root. */
function resolveSegments(parts: string[], rooted: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  // A Windows drive/UNC path is always rooted, so a single leading `..` cannot escape.
  if (rooted && out.length === 0) return [];
  return out;
}

export function projectKeyFor(cwd: string): ProjectKey {
  const raw = (cwd ?? "").trim();
  const display = raw.replace(/[\\/]+$/, "") || raw;
  const key = canonicalizeProjectPath(raw);
  const displayKey = canonicalizeProjectPath(stripFormatChars(raw));
  const cfStripped = key !== displayKey;
  const kind: ProjectKeyKind = raw.length === 0 ? "none" : cfStripped ? "cf" : "exact";
  return { key, displayKey, kind, cfStripped, display };
}

/**
 * Compare two `cwd` values and report the strongest relationship that holds.
 * `exact` when the keys match, `cf` when they match only after stripping Cf characters,
 * `none` otherwise (including empty input).
 */
export function compareProjectPaths(a: string, b: string): ProjectKeyKind {
  const left = projectKeyFor(a);
  const right = projectKeyFor(b);
  if (left.key.length === 0 || right.key.length === 0) return "none";
  if (left.key === right.key) return "exact";
  return left.displayKey === right.displayKey ? "cf" : "none";
}
