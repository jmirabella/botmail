import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  COMMIT_MESSAGE_PATH,
  DEFAULT_AUTHOR_EMAIL,
  DEFAULT_AUTHOR_NAME,
  applySnapshot,
  exportSnapshot,
  formatLeak,
  gitPushArgs,
  isExcluded,
  leakLines,
  parseDenylist,
  parseExcludeList,
  replaceHistoryRequested,
  scanCommitMessage,
  scanSnapshot,
  syncAuthor,
} from "../scripts/public-sync.mjs";

const root = path.resolve(import.meta.dirname, "..");
const marker = "Leak-Marker";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

describe("public sync leak scan", () => {
  it("reports a case-insensitive hit as a path and line", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-leak-"));
    try {
      writeFileSync(path.join(directory, "note.txt"), `clean\nsee ${marker} here\n`);
      const hits = scanSnapshot(directory, ["leak-marker"]);
      expect(hits).toEqual([{ path: "note.txt", line: 2 }]);
      expect(formatLeak(hits[0])).toBe("leak: note.txt:2");
      expect(JSON.stringify(hits).toLowerCase()).not.toContain(marker.toLowerCase());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores clean input", () => {
    expect(leakLines("hello\nworld\n", [marker])).toEqual([]);
    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-clean-"));
    try {
      writeFileSync(path.join(directory, "readme.txt"), "public text\n");
      expect(scanSnapshot(directory, [marker])).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails when the denylist is empty", () => {
    expect(() => parseDenylist("")).toThrow(/PUBLIC_SYNC_DENYLIST is empty/);
    expect(() => parseDenylist(" \n\t")).toThrow(/PUBLIC_SYNC_DENYLIST is empty/);
  });

  it("omits excluded paths from the export", () => {
    const patterns = parseExcludeList(readFileSync(path.join(root, ".public-sync-exclude"), "utf8"));
    expect(isExcluded(".github/workflows/public-sync.yml", patterns)).toBe(true);
    expect(isExcluded("README.md", patterns)).toBe(false);

    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-export-"));
    try {
      git(directory, ["init", "-b", "main"]);
      git(directory, ["config", "user.email", "sync-test@example.com"]);
      git(directory, ["config", "user.name", "Sync Test"]);
      writeFileSync(path.join(directory, "keep.txt"), "public text\n");
      writeFileSync(path.join(directory, "secret.txt"), `${marker}\n`);
      mkdirSync(path.join(directory, "private"));
      writeFileSync(path.join(directory, "private", "note.txt"), `${marker}\n`);
      writeFileSync(path.join(directory, ".public-sync-exclude"), "secret.txt\nprivate\n");
      git(directory, ["add", "."]);
      git(directory, ["commit", "-m", "snapshot"]);
      const dest = path.join(directory, "out");
      exportSnapshot({
        repo: directory,
        dest,
        patterns: parseExcludeList("secret.txt\nprivate\n"),
      });
      expect(readFileSync(path.join(dest, "keep.txt"), "utf8")).toBe("public text\n");
      expect(() => readFileSync(path.join(dest, "secret.txt"))).toThrow();
      expect(() => readFileSync(path.join(dest, "private", "note.txt"))).toThrow();
      expect(scanSnapshot(dest, [marker])).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("flags the commit message", () => {
    const hits = scanCommitMessage(`subject\n\nbody has ${marker}`, ["leak-marker"]);
    expect(hits).toEqual([{ path: COMMIT_MESSAGE_PATH, line: 3 }]);
    expect(formatLeak(hits[0])).toBe(`leak: ${COMMIT_MESSAGE_PATH}:3`);
    expect(JSON.stringify(hits).toLowerCase()).not.toContain(marker.toLowerCase());
  });

  it("defaults the public author to the owner noreply identity", () => {
    expect(syncAuthor({})).toEqual({ name: DEFAULT_AUTHOR_NAME, email: DEFAULT_AUTHOR_EMAIL });
    expect(DEFAULT_AUTHOR_NAME).toBe("Joshua Mirabella");
    expect(DEFAULT_AUTHOR_EMAIL).toBe("29336554+jmirabella@users.noreply.github.com");
    expect(syncAuthor({ PUBLIC_SYNC_AUTHOR_NAME: "Mirror Bot", PUBLIC_SYNC_AUTHOR_EMAIL: "mirror@example.com" })).toEqual({
      name: "Mirror Bot",
      email: "mirror@example.com",
    });
  });

  it("replace mode builds a parentless commit", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-root-"));
    const source = mkdtempSync(path.join(tmpdir(), "bot-mail-root-src-"));
    try {
      git(directory, ["init", "-b", "main"]);
      git(directory, ["config", "user.email", "sync-test@example.com"]);
      git(directory, ["config", "user.name", "Sync Test"]);
      writeFileSync(path.join(directory, "keep.txt"), "old\n");
      git(directory, ["add", "."]);
      git(directory, ["commit", "-m", "old history"]);
      writeFileSync(path.join(source, "keep.txt"), "new\n");
      const author = syncAuthor({});
      expect(applySnapshot({ checkout: directory, sourceDir: source, message: "synced\n", replace: true, author })).toBe(true);
      expect(() => git(directory, ["rev-parse", "--verify", "HEAD^"])).toThrow();
      expect(git(directory, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
      expect(git(directory, ["log", "-1", "--format=%an"]).trim()).toBe("Joshua Mirabella");
      expect(git(directory, ["log", "-1", "--format=%ae"]).trim()).toBe(author.email);
      expect(git(directory, ["log", "-1", "--format=%cn"]).trim()).toBe(author.name);
      expect(git(directory, ["log", "-1", "--format=%ce"]).trim()).toBe(author.email);
      expect(readFileSync(path.join(directory, "keep.txt"), "utf8")).toBe("new\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  it("push mode never force-pushes", () => {
    expect(replaceHistoryRequested({ GITHUB_EVENT_NAME: "push", PUBLIC_SYNC_REPLACE_HISTORY: "true" })).toBe(false);
    expect(replaceHistoryRequested({ GITHUB_EVENT_NAME: "workflow_dispatch", PUBLIC_SYNC_REPLACE_HISTORY: "false" })).toBe(false);
    expect(replaceHistoryRequested({ GITHUB_EVENT_NAME: "workflow_dispatch", PUBLIC_SYNC_REPLACE_HISTORY: "true" })).toBe(true);
    expect(gitPushArgs(false)).toEqual(["push", "origin", "HEAD:main"]);
    expect(gitPushArgs(true)).toEqual(["push", "--force", "origin", "HEAD:main"]);

    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-push-"));
    const source = mkdtempSync(path.join(tmpdir(), "bot-mail-push-src-"));
    try {
      git(directory, ["init", "-b", "main"]);
      git(directory, ["config", "user.email", "sync-test@example.com"]);
      git(directory, ["config", "user.name", "Sync Test"]);
      writeFileSync(path.join(directory, "keep.txt"), "old\n");
      git(directory, ["add", "."]);
      git(directory, ["commit", "-m", "kept parent"]);
      const parent = git(directory, ["rev-parse", "HEAD"]).trim();
      writeFileSync(path.join(source, "keep.txt"), "new\n");
      expect(
        applySnapshot({
          checkout: directory,
          sourceDir: source,
          message: "synced\n",
          replace: replaceHistoryRequested({ GITHUB_EVENT_NAME: "push", PUBLIC_SYNC_REPLACE_HISTORY: "true" }),
          author: syncAuthor({}),
        }),
      ).toBe(true);
      expect(git(directory, ["rev-parse", "HEAD^"]).trim()).toBe(parent);
      expect(gitPushArgs(false).includes("--force")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });
});
