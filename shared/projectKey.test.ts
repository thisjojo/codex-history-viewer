import { describe, expect, it } from "vitest";
import {
  canonicalizeProjectPath,
  compareProjectPaths,
  containsFormatChars,
  isPosixStylePath,
  isWindowsStylePath,
  projectKeyFor,
  stripFormatChars,
} from "./projectKey";

// U+200C ZERO WIDTH NON-JOINER is present in one real project directory on the reference
// machine (`D:\AI Coding\simple\u200c-grid`), which is why this module exists.
const ZWNJ = "\u200c";

describe("stripFormatChars", () => {
  it("removes zero-width and bidi format characters but nothing else", () => {
    expect(stripFormatChars(`a${ZWNJ}b`)).toBe("ab");
    expect(stripFormatChars("a\u200db")).toBe("ab");
    expect(stripFormatChars("a\u202eb")).toBe("ab");
    expect(stripFormatChars("a\ufeffb")).toBe("ab");
    expect(stripFormatChars("plain path")).toBe("plain path");
    // Non-format characters that merely look unusual must survive.
    expect(stripFormatChars("emoji 🐾 and 中文")).toBe("emoji 🐾 and 中文");
  });

  it("detects whether a value carries format characters", () => {
    expect(containsFormatChars(`x${ZWNJ}y`)).toBe(true);
    expect(containsFormatChars("x-y")).toBe(false);
  });
});

describe("isWindowsStylePath / isPosixStylePath", () => {
  it("classifies drive-letter and UNC paths as Windows", () => {
    expect(isWindowsStylePath("D:\\proj")).toBe(true);
    expect(isWindowsStylePath("d:/proj")).toBe(true);
    expect(isWindowsStylePath("C:")).toBe(true);
    expect(isWindowsStylePath("\\\\server\\share\\proj")).toBe(true);
    expect(isPosixStylePath("D:\\proj")).toBe(false);
  });

  it("classifies slash-prefixed paths without a drive or UNC prefix as POSIX", () => {
    expect(isPosixStylePath("/home/user/proj")).toBe(true);
    expect(isWindowsStylePath("/home/user/proj")).toBe(false);
    // `//server/share` is UNC, not POSIX, even though it starts with a slash.
    expect(isPosixStylePath("//server/share")).toBe(false);
  });
});

describe("canonicalizeProjectPath", () => {
  it("collapses Windows separator, case and trailing-separator differences", () => {
    const expected = canonicalizeProjectPath("D:\\AI Coding\\proj");
    expect(canonicalizeProjectPath("d:/ai coding/proj")).toBe(expected);
    expect(canonicalizeProjectPath("D:\\AI CODING\\PROJ\\")).toBe(expected);
    expect(canonicalizeProjectPath("D:\\\\AI Coding//proj")).toBe(expected);
    expect(canonicalizeProjectPath("  D:\\AI Coding\\proj  ")).toBe(expected);
  });

  it("keeps format characters so distinct directories stay distinct", () => {
    const plain = canonicalizeProjectPath("D:\\AI Coding\\simple-grid");
    const withZwnj = canonicalizeProjectPath(`D:\\AI Coding\\simple${ZWNJ}-grid`);
    expect(withZwnj).not.toBe(plain);
    expect(withZwnj).toContain(ZWNJ);
  });

  it("resolves `.` and `..` textually without escaping the root", () => {
    expect(canonicalizeProjectPath("D:\\a\\.\\b")).toBe(canonicalizeProjectPath("D:\\a\\b"));
    expect(canonicalizeProjectPath("D:\\a\\b\\..\\c")).toBe(canonicalizeProjectPath("D:\\a\\c"));
    expect(canonicalizeProjectPath("D:\\..\\..")).toBe(canonicalizeProjectPath("D:\\"));
  });

  it("keeps POSIX paths case-sensitive and rooted", () => {
    expect(canonicalizeProjectPath("/home/User/proj")).not.toBe(
      canonicalizeProjectPath("/home/user/proj"),
    );
    expect(canonicalizeProjectPath("/home/user/proj/")).toBe("/home/user/proj");
    expect(canonicalizeProjectPath("/home/user/../other")).toBe("/home/other");
  });

  it("returns an empty key for empty or whitespace input", () => {
    expect(canonicalizeProjectPath("")).toBe("");
    expect(canonicalizeProjectPath("   ")).toBe("");
  });

  it("keeps UNC prefixes", () => {
    expect(canonicalizeProjectPath("\\\\server\\share\\proj")).toBe("\\\\server\\share\\proj");
    expect(canonicalizeProjectPath("//SERVER/Share/Proj")).toBe("\\\\server\\share\\proj");
  });
});

describe("projectKeyFor", () => {
  it("reports exact when nothing had to be stripped", () => {
    const key = projectKeyFor("D:\\AI Coding\\grid-trading");
    expect(key.kind).toBe("exact");
    expect(key.cfStripped).toBe(false);
    expect(key.key).toBe(key.displayKey);
    expect(key.display).toBe("D:\\AI Coding\\grid-trading");
  });

  it("reports cf and exposes a display key for the invisible-character case", () => {
    const key = projectKeyFor(`D:\\AI Coding\\simple${ZWNJ}-grid`);
    expect(key.kind).toBe("cf");
    expect(key.cfStripped).toBe(true);
    expect(key.key).not.toBe(key.displayKey);
    expect(key.displayKey).toBe(canonicalizeProjectPath("D:\\AI Coding\\simple-grid"));
    // The display value keeps the real directory name, invisible character included.
    expect(key.display).toContain(ZWNJ);
  });

  it("reports none for an empty cwd", () => {
    const key = projectKeyFor("");
    expect(key.kind).toBe("none");
    expect(key.key).toBe("");
  });
});

describe("compareProjectPaths", () => {
  it("treats case and separator variants of one directory as the same project", () => {
    expect(compareProjectPaths("D:\\AI Coding\\proj", "d:/ai coding/PROJ/")).toBe("exact");
    expect(compareProjectPaths("D:\\a\\b", "D:\\a\\b\\..\\b")).toBe("exact");
  });

  it("flags two directories that differ only by an invisible character", () => {
    expect(
      compareProjectPaths(`D:\\AI Coding\\simple${ZWNJ}-grid`, "D:\\AI Coding\\simple-grid"),
    ).toBe("cf");
  });

  it("separates different directories, WSL paths and Windows paths", () => {
    expect(compareProjectPaths("D:\\AI Coding\\a", "D:\\AI Coding\\b")).toBe("none");
    expect(compareProjectPaths("/home/me/proj", "D:\\home\\me\\proj")).toBe("none");
    expect(compareProjectPaths("", "D:\\a")).toBe("none");
  });

  it("keeps POSIX case differences distinct", () => {
    expect(compareProjectPaths("/home/Me/p", "/home/me/p")).toBe("none");
  });
});
