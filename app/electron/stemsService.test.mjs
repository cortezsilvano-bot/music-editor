/**
 * Stem server root resolution (packaged vs checkout).
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const stems = require("./stemsService.cjs");

describe("resolveServerRoot", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "me-stems-root-"));
    stems.setUserDataPathForTests(dir);
    stems.setServerRoot(null);
  });

  afterEach(() => {
    stems.setServerRoot(null);
    stems.setUserDataPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers an explicit override over env and packaged paths", () => {
    const override = path.join(dir, "chosen");
    mkdirSync(override);
    writeFileSync(path.join(override, "app.py"), "# stub\n");
    const resolved = stems.resolveServerRoot({
      override,
      env: { MUSIC_EDITOR_SERVER_ROOT: path.join(dir, "env-server") },
      isPackaged: true,
      resourcesPath: path.join(dir, "resources"),
      electronDir: path.join(dir, "app", "electron"),
    });
    expect(resolved).toBe(path.resolve(override));
  });

  it("uses MUSIC_EDITOR_SERVER_ROOT when no override is set", () => {
    const envRoot = path.join(dir, "env-server");
    const resolved = stems.resolveServerRoot({
      override: null,
      env: { MUSIC_EDITOR_SERVER_ROOT: envRoot },
      isPackaged: true,
      resourcesPath: path.join(dir, "resources"),
      electronDir: path.join(dir, "app", "electron"),
    });
    expect(resolved).toBe(path.resolve(envRoot));
  });

  it("uses resources/server when packaged and no override/env", () => {
    const resources = path.join(dir, "resources");
    const resolved = stems.resolveServerRoot({
      override: null,
      env: {},
      isPackaged: true,
      resourcesPath: resources,
      electronDir: path.join(dir, "app", "electron"),
    });
    expect(resolved).toBe(path.join(resources, "server"));
  });

  it("falls back to repo ../server when unpackaged", () => {
    const electronDir = path.join(dir, "Music_editor", "app", "electron");
    mkdirSync(electronDir, { recursive: true });
    const resolved = stems.resolveServerRoot({
      override: null,
      env: {},
      isPackaged: false,
      resourcesPath: path.join(dir, "resources"),
      electronDir,
    });
    expect(resolved).toBe(path.resolve(electronDir, "..", "..", "server"));
  });

  it("persists a chosen server folder that contains app.py", () => {
    const chosen = path.join(dir, "picked-server");
    mkdirSync(chosen);
    writeFileSync(path.join(chosen, "app.py"), "# stub\n");
    const result = stems.setServerRoot(chosen);
    expect(result.ok).toBe(true);
    expect(result.serverRoot).toBe(path.resolve(chosen));
    expect(stems.resolveServerRoot({ env: {}, isPackaged: false, electronDir: path.join(dir, "x") }))
      .toBe(path.resolve(chosen));
  });

  it("rejects a folder without app.py", () => {
    const empty = path.join(dir, "empty");
    mkdirSync(empty);
    const result = stems.setServerRoot(empty);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/app\.py/i);
  });
});
