import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { canWriteWorkspace, chooseWorkspaceRoot, isSystemFolder, Workspace } from "../src/workspace/workspace.js";

const dir = mkdtempSync(join(tmpdir(), "framelens-root-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const winEnv = { SystemRoot: "C:\\WINDOWS", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" };

describe("system folders", () => {
  it("knows the Windows folder, System32, the Program Files trees and drive roots", () => {
    for (const p of ["C:\\WINDOWS\\system32", "c:\\windows", "C:\\Program Files\\Claude", "C:\\Program Files (x86)\\x", "C:\\", "D:\\", "\\\\server\\share"]) {
      expect(isSystemFolder(p, winEnv, "win32"), p).toBe(true);
    }
    for (const p of ["C:\\Users\\me\\project", "D:\\work\\Windows-tools", "C:\\Program Files Mine\\x"]) expect(isSystemFolder(p, winEnv, "win32"), p).toBe(false);
  });

  it("knows / and the system trees on macOS and Linux", () => {
    for (const p of ["/", "//", "/usr", "/usr/", "/usr/local/bin", "/System/Volumes", "/bin", "/etc/x", "/Library/Application Support"]) expect(isSystemFolder(p, {}, "linux"), p).toBe(true);
    for (const p of ["/home/me/project", "/Users/me/Library", "/usr-projects", "/opt/app"]) expect(isSystemFolder(p, {}, "darwin"), p).toBe(false);
    // macOS ignores case: /system is /System. Linux does not.
    expect(isSystemFolder("/system/Volumes", {}, "darwin")).toBe(true);
    expect(isSystemFolder("/system/x", {}, "linux")).toBe(false);
  });

  it("sees System32 through device paths, long-path prefixes and administrative shares", () => {
    for (const p of ["\\\\?\\C:\\Windows\\System32", "\\\\.\\C:\\Windows\\System32", "\\\\localhost\\C$\\Windows\\System32", "\\\\host\\c$", "\\\\?\\UNC\\server\\share", "C:/Windows/SysWOW64"]) {
      expect(isSystemFolder(p, winEnv, "win32"), p).toBe(true);
    }
    expect(isSystemFolder("\\\\server\\share\\project", winEnv, "win32")).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("sees System32 behind a junction and under its 8.3 short name", () => {
    const junction = join(dir, "looks-like-a-project");
    symlinkSync(process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32", junction, "junction");
    try {
      expect(isSystemFolder(junction)).toBe(true);
      const choice = chooseWorkspaceRoot({ FRAMELENS_HOME: join(dir, "jhome") }, junction);
      expect(choice.from).toBe("home");
      expect(existsSync(join(junction, ".framelens"))).toBe(false);
    } finally {
      rmSync(junction, { force: true, recursive: false });
    }
    // PROGRA~1 is Program Files when short names are on (the default on the system drive).
    if (existsSync("C:\\PROGRA~1")) expect(isSystemFolder("C:\\PROGRA~1\\nodejs")).toBe(true);
  });
});

describe("choosing the workspace folder", () => {
  it("uses FRAMELENS_WORKSPACE over everything, a relative one taken from the home folder, not the working folder", () => {
    const choice = chooseWorkspaceRoot({ FRAMELENS_WORKSPACE: "ws" }, "C:\\Windows\\System32", { platform: "win32", userHome: join(dir, "user"), canWrite: () => false });
    expect(choice).toMatchObject({ from: "env", root: resolve(dir, "user", "ws") });
    expect(chooseWorkspaceRoot({ FRAMELENS_WORKSPACE: join(dir, "abs") }, "/usr", { platform: "linux" }).root).toBe(resolve(dir, "abs"));
  });

  it("uses <cwd>/.framelens when the folder is an ordinary writable one", () => {
    expect(chooseWorkspaceRoot({}, dir)).toMatchObject({ from: "cwd", root: join(dir, ".framelens") });
    // Checking left nothing behind.
    expect(existsSync(join(dir, ".framelens"))).toBe(false);
  });

  it("moves to the home folder from System32, as Claude Desktop starts the server there", () => {
    const home = join(dir, "home");
    const choice = chooseWorkspaceRoot({ ...winEnv, FRAMELENS_HOME: home }, "C:\\WINDOWS\\system32", { platform: "win32" });
    expect(choice.from).toBe("home");
    expect(choice.root).toBe(resolve(home));
    expect(choice.reason).toMatch(/system folder \(.*system32\); using the home folder/i);
  });

  it("moves to the home folder when the working folder cannot be written, and to the temp folder when neither can", () => {
    const unwritable = (root: string) => !root.startsWith(resolve(dir, "project"));
    const choice = chooseWorkspaceRoot({ FRAMELENS_HOME: join(dir, "home2") }, join(dir, "project"), { canWrite: unwritable });
    expect(choice).toMatchObject({ from: "home", root: resolve(dir, "home2") });
    expect(choice.reason).toMatch(/cannot be written to/);
    expect(chooseWorkspaceRoot({}, join(dir, "project"), { canWrite: () => false }).from).toBe("temp");
  });

  it("finds a folder that cannot be written to", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    expect(canWriteWorkspace(join(file, ".framelens"))).toBe(false);
    expect(canWriteWorkspace(join(dir, "fresh", ".framelens"))).toBe(true);
    expect(readdirSync(dir)).not.toContain(".framelens");
  });
});

describe("absolute paths in tool output", () => {
  it("shows workspace files by their absolute path", () => {
    const ws = new Workspace(join(dir, ".framelens"), "yt-abc");
    expect(ws.display(ws.path("sheets", "a.jpg"))).toBe(resolve(dir, ".framelens", "yt-abc", "sheets", "a.jpg"));
    expect(ws.display(ws.dir)).toBe(resolve(dir, ".framelens", "yt-abc"));
  });

  it("doctor says which workspace folder a server started here would use, and why", async () => {
    const lines: string[] = [];
    const downloads = join(dir, "doctor-downloads");
    await runDoctor({ env: { PATH: "", FRAMELENS_HOME: join(dir, "doctor-home"), FRAMELENS_DOWNLOADS: downloads, ...winEnv }, cwd: process.platform === "win32" ? "C:\\WINDOWS\\system32" : "/", write: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(text).toMatch(/Workspace folder: .*doctor-home \(the server was started in a system folder/);
    expect(text).toMatch(/Automatic setup \(FRAMELENS_AUTO_INSTALL\): on/);
    expect(text).toContain("Self-hosted cobalt (FRAMELENS_COBALT_URL): not set");
    // Both places `inbox` looks, not just "not set".
    expect(text).toContain(`Inbox (source "inbox", newest file): FRAMELENS_INBOX not set; ${join(downloads, "FrameLens")} (not created yet), where the browser extension saves`);
    lines.length = 0;
    await runDoctor({ env: { PATH: "", FRAMELENS_HOME: join(dir, "doctor-home"), FRAMELENS_DOWNLOADS: downloads, FRAMELENS_INBOX: dir }, write: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain(`Inbox (source "inbox", newest file): ${dir} and ${join(downloads, "FrameLens")}`);
  });
});
