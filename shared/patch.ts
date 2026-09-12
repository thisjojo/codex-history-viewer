// Parse a Codex `apply_patch` body into per-file, per-hunk structured diffs.
//
// The patch text Codex logs in a custom_tool_call `input` looks like:
//
//   *** Begin Patch
//   *** Update File: path/to/file
//   @@ optional context heading
//    unchanged line   (leading space)
//   -removed line
//   +added line
//   *** End Patch
//
// We honour the patch's own +/-/context classification (rather than re-diffing)
// and reuse `groupRuns` + `segmentize` from diff.ts to add word-level
// highlighting on each paired removed/added run — the same look as the Edit
// diff in claude-code-trace.

import { type DiffLine, groupRuns, type LineOp, segmentize } from "./diff";

export type PatchFileOp = "add" | "update" | "delete";

export interface PatchHunk {
  /** Text after the `@@` marker, if any (empty for the implicit first hunk). */
  header: string;
  lines: DiffLine[];
}

export interface PatchFile {
  path: string;
  op: PatchFileOp;
  /** Destination path when the patch renames/moves the file (`*** Move to:`). */
  movePath: string | null;
  hunks: PatchHunk[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";

function looksLikePatch(patch: string): boolean {
  return (
    patch.includes(BEGIN) || patch.includes(ADD) || patch.includes(UPDATE) || patch.includes(DELETE)
  );
}

// Parse a Codex apply_patch body. Returns null when the text isn't a recognised
// patch (callers then fall back to rendering it as raw text).
export function parseApplyPatch(patch: string): PatchFile[] | null {
  if (!looksLikePatch(patch)) return null;

  const lines = patch.split("\n");
  // Drop a single trailing empty element from a terminal newline so it doesn't
  // surface as a spurious blank context line on the last file.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunkOps: LineOp[] = [];
  let hunkHeader = "";

  const endHunk = () => {
    if (file && hunkOps.length > 0) {
      file.hunks.push({ header: hunkHeader, lines: segmentize(groupRuns(hunkOps)) });
    }
    hunkOps = [];
    hunkHeader = "";
  };

  const endFile = () => {
    endHunk();
    file = null;
  };

  for (const raw of lines) {
    if (raw.startsWith(BEGIN) || raw.startsWith(END)) continue;

    if (raw.startsWith(ADD) || raw.startsWith(UPDATE) || raw.startsWith(DELETE)) {
      endFile();
      const op: PatchFileOp = raw.startsWith(ADD)
        ? "add"
        : raw.startsWith(UPDATE)
          ? "update"
          : "delete";
      const prefix = op === "add" ? ADD : op === "update" ? UPDATE : DELETE;
      file = { path: raw.slice(prefix.length).trim(), op, movePath: null, hunks: [] };
      files.push(file);
      continue;
    }

    if (raw.startsWith(MOVE)) {
      if (file) file.movePath = raw.slice(MOVE.length).trim();
      continue;
    }

    if (raw.startsWith("@@")) {
      endHunk();
      hunkHeader = raw.slice(2).trim();
      continue;
    }

    if (!file) continue; // stray line outside any file section

    if (raw.startsWith("+")) hunkOps.push({ kind: "added", text: raw.slice(1) });
    else if (raw.startsWith("-")) hunkOps.push({ kind: "removed", text: raw.slice(1) });
    else if (raw.startsWith(" ")) hunkOps.push({ kind: "context", text: raw.slice(1) });
    else hunkOps.push({ kind: "context", text: raw }); // blank/untagged context line
  }
  endFile();

  return files.length > 0 ? files : null;
}

// Parse a standard unified diff (`@@ -a,b +c,d @@` with +/-/context lines) into the
// same per-file, per-hunk structure as `parseApplyPatch`.
//
// This is the shape Codex Desktop v0.153+ records in
// `event_msg.item_completed` → `FileChange` → `changes[path].unified_diff`. The
// response_item side of a Desktop session holds the JavaScript the model ran, not a
// patch body, so the runtime's own record is the only reliable diff source there.
export function parseUnifiedDiff(
  diff: string,
  fallbackPath: string,
  fallbackOp: PatchFileOp = "update",
  movePath: string | null = null,
): PatchFile[] | null {
  if (!diff.includes("@@")) return null;

  const lines = diff.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const files: PatchFile[] = [];
  let path = "";
  let op: PatchFileOp = fallbackOp;
  let sawHeader = false;
  let hunkOps: LineOp[] = [];
  let hunkHeader = "";

  const endHunk = () => {
    if (hunkOps.length > 0) {
      if (!path) path = fallbackPath;
      let file = files[files.length - 1];
      if (!file || file.path !== path || sawHeader) {
        // A `+++` header starts a new file section; otherwise a new hunk in the
        // current file continues appending to it.
        if (!file || file.path !== path) {
          file = { path, op, movePath, hunks: [] };
          files.push(file);
        }
      }
      file.hunks.push({ header: hunkHeader, lines: segmentize(groupRuns(hunkOps)) });
      sawHeader = false;
    }
    hunkOps = [];
    hunkHeader = "";
  };

  for (const raw of lines) {
    if (raw.startsWith("--- ") || raw === "---") continue; // old-file header carries no useful path
    if (raw.startsWith("+++ ")) {
      endHunk();
      const newPath = raw.slice(4).trim();
      path = newPath === "/dev/null" ? "" : newPath;
      op = fallbackOp;
      sawHeader = true;
      continue;
    }
    if (raw.startsWith("@@")) {
      endHunk();
      hunkHeader = raw.trim();
      continue;
    }
    if (raw.startsWith("+")) hunkOps.push({ kind: "added", text: raw.slice(1) });
    else if (raw.startsWith("-")) hunkOps.push({ kind: "removed", text: raw.slice(1) });
    else if (raw.startsWith(" ")) hunkOps.push({ kind: "context", text: raw.slice(1) });
    else if (raw === "") hunkOps.push({ kind: "context", text: "" }); // blank context line
    // Anything else (e.g. `\ No newline at end of file`) is metadata, not content.
  }
  endHunk();

  return files.length > 0 ? files : null;
}
