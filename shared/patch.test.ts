import { describe, expect, it } from "vitest";
import { parseApplyPatch, parseUnifiedDiff } from "./patch";

describe("parseApplyPatch", () => {
  it("returns null for non-patch text", () => {
    expect(parseApplyPatch("just some output text")).toBeNull();
    expect(parseApplyPatch("")).toBeNull();
  });

  it("parses an update with context, removed and added lines", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/main.rs",
      "@@",
      " fn main() {",
      '-    println!("old");',
      '+    println!("new");',
      " }",
      "*** End Patch",
    ].join("\n");

    const files = parseApplyPatch(patch);
    expect(files).not.toBeNull();
    expect(files).toHaveLength(1);
    const file = files![0];
    expect(file.op).toBe("update");
    expect(file.path).toBe("src/main.rs");
    expect(file.movePath).toBeNull();
    expect(file.hunks).toHaveLength(1);

    const lines = file.hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(["context", "removed", "added", "context"]);
    expect(lines[0].segments.map((s) => s.text).join("")).toBe("fn main() {");
    // Removed/added share most tokens, so the changed word is highlighted.
    expect(lines[1].segments.some((s) => s.changed)).toBe(true);
    expect(lines[2].segments.some((s) => s.changed)).toBe(true);
    expect(lines[1].segments.map((s) => s.text).join("")).toBe('    println!("old");');
    expect(lines[2].segments.map((s) => s.text).join("")).toBe('    println!("new");');
  });

  it("parses an added file with all-added lines", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: docs/README.md",
      "+# Title",
      "+",
      "+body",
      "*** End Patch",
    ].join("\n");

    const files = parseApplyPatch(patch)!;
    expect(files[0].op).toBe("add");
    expect(files[0].path).toBe("docs/README.md");
    const lines = files[0].hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(["added", "added", "added"]);
    expect(lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual([
      "# Title",
      "",
      "body",
    ]);
  });

  it("parses a deleted file header with no body", () => {
    const patch = ["*** Begin Patch", "*** Delete File: old/file.txt", "*** End Patch"].join("\n");
    const files = parseApplyPatch(patch)!;
    expect(files[0].op).toBe("delete");
    expect(files[0].path).toBe("old/file.txt");
    expect(files[0].hunks).toHaveLength(0);
  });

  it("captures a move/rename target", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a/old.ts",
      "*** Move to: a/new.ts",
      "@@",
      "-const x = 1;",
      "+const x = 2;",
      "*** End Patch",
    ].join("\n");
    const files = parseApplyPatch(patch)!;
    expect(files[0].movePath).toBe("a/new.ts");
  });

  it("splits multiple files and multiple hunks", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@ first hunk",
      "-a",
      "+b",
      "@@ second hunk",
      " keep",
      "+added",
      "*** Update File: b.ts",
      "@@",
      "-gone",
      "*** End Patch",
    ].join("\n");
    const files = parseApplyPatch(patch)!;
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("a.ts");
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[0].header).toBe("first hunk");
    expect(files[0].hunks[1].header).toBe("second hunk");
    expect(files[1].path).toBe("b.ts");
    expect(files[1].hunks[0].lines.map((l) => l.kind)).toEqual(["removed"]);
  });

  it("does not emit a spurious blank line from a trailing newline", () => {
    const patch = ["*** Begin Patch", "*** Add File: f.txt", "+hi", "*** End Patch", ""].join("\n");
    const files = parseApplyPatch(patch)!;
    expect(files[0].hunks[0].lines.map((l) => l.kind)).toEqual(["added"]);
  });
});

describe("parseUnifiedDiff", () => {
  it("returns null when the text has no hunk markers", () => {
    expect(parseUnifiedDiff("just text", "a.ts")).toBeNull();
    expect(parseUnifiedDiff("", "a.ts")).toBeNull();
  });

  it("parses a single-file unified diff with context, removed and added lines", () => {
    const diff = [
      "--- a/src/main.rs",
      "+++ b/src/main.rs",
      "@@ -1,4 +1,4 @@",
      " fn main() {",
      '-    println!("old");',
      '+    println!("new");',
      " }",
    ].join("\n");

    const files = parseUnifiedDiff(diff, "fallback.rs")!;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("b/src/main.rs");
    expect(files[0].movePath).toBeNull();
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0].header).toBe("@@ -1,4 +1,4 @@");
    expect(files[0].hunks[0].lines.map((l) => l.kind)).toEqual([
      "context",
      "removed",
      "added",
      "context",
    ]);
    // Word-level highlighting reuses the same pipeline as apply_patch text.
    expect(files[0].hunks[0].lines[1].segments.some((s) => s.changed)).toBe(true);
  });

  it("uses the caller's path, op and move_path when the diff has no +++ header", () => {
    // Codex Desktop FileChange records carry the path in the change map key, not in the
    // diff text, so the caller's metadata must win when the header is absent.
    const diff = ["@@ -52,2 +52,3 @@", " | a |", "+| b |"].join("\n");
    const files = parseUnifiedDiff(diff, "D:\\proj\\docs\\x.md", "update", null)!;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("D:\\proj\\docs\\x.md");
    expect(files[0].op).toBe("update");
    expect(files[0].hunks[0].lines.map((l) => l.kind)).toEqual(["context", "added"]);
  });

  it("keeps the caller's op for an added file and honours move_path", () => {
    const diff = ["@@ -0,0 +1 @@", "+brand new"].join("\n");
    const files = parseUnifiedDiff(diff, "new.txt", "add", "moved/new.txt")!;
    expect(files[0].op).toBe("add");
    expect(files[0].movePath).toBe("moved/new.txt");
  });

  it("handles multiple hunks and blank context lines", () => {
    const diff = ["@@ -1,2 +1,2 @@", "-a", "+b", "@@ -10,2 +10,3 @@", " c", "", "+d"].join("\n");
    const files = parseUnifiedDiff(diff, "f.txt")!;
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[1].lines.map((l) => l.kind)).toEqual(["context", "context", "added"]);
  });

  it("tolerates CRLF line endings", () => {
    const diff = "@@ -1 +1 @@\r\n-old\r\n+new";
    const files = parseUnifiedDiff(diff, "f.txt")!;
    expect(files[0].hunks[0].lines.map((l) => l.kind)).toEqual(["removed", "added"]);
    expect(files[0].hunks[0].lines[0].segments.map((s) => s.text).join("")).toBe("old");
  });
});
