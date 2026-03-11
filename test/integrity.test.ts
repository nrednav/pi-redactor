import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RedactorConfig, Pattern } from "../src/core";
import { saveConfig, loadConfig, CONFIG_PATH, _resetConfigVersionForTesting } from "../src/shell";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "../src");

describe("Cellular Integrity (Purity Check)", () => {
  const coreSource = fs.readFileSync(path.join(srcDir, "core.ts"), "utf-8");
  const shellSource = fs.readFileSync(path.join(srcDir, "shell.ts"), "utf-8");

  describe("core.ts — Functional Core (MUST be pure)", () => {
    it("has no node:fs import", () => {
      expect(coreSource).not.toMatch(/from\s+["']node:fs["']/);
      expect(coreSource).not.toMatch(/require\s*\(\s*["']node:fs["']\s*\)/);
    });

    it("has no node:os import", () => {
      expect(coreSource).not.toMatch(/from\s+["']node:os["']/);
      expect(coreSource).not.toMatch(/require\s*\(\s*["']node:os["']\s*\)/);
    });

    it("has no node:path import", () => {
      expect(coreSource).not.toMatch(/from\s+["']node:path["']/);
      expect(coreSource).not.toMatch(/require\s*\(\s*["']node:path["']\s*\)/);
    });

    it("has no node:child_process import", () => {
      expect(coreSource).not.toMatch(/from\s+["']node:child_process["']/);
    });

    it("has no node:net import", () => {
      expect(coreSource).not.toMatch(/from\s+["']node:net["']/);
    });

    it("has no Pi SDK runtime import", () => {
      expect(coreSource).not.toMatch(/from\s+["']@mariozechner\/pi-coding-agent["']/);
    });

    it("does not access process.env", () => {
      expect(coreSource).not.toMatch(/process\.env/);
    });

    it("does not access process.cwd", () => {
      expect(coreSource).not.toMatch(/process\.cwd/);
    });

    it("does not access process.exit", () => {
      expect(coreSource).not.toMatch(/process\.exit/);
    });

    it("does not access globalThis (outside comments)", () => {
      const codeOnly = coreSource
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      expect(codeOnly).not.toMatch(/globalThis\./);
    });

    it("does not use console.log (no side effects)", () => {
      const codeOnly = coreSource
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      expect(codeOnly).not.toMatch(/console\.(log|error|warn|info)/);
    });

    it("does not use setTimeout/setInterval (no async side effects)", () => {
      const codeOnly = coreSource
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      expect(codeOnly).not.toMatch(/setTimeout\s*\(/);
      expect(codeOnly).not.toMatch(/setInterval\s*\(/);
    });

    it("does not use fetch or XMLHttpRequest (no network)", () => {
      expect(coreSource).not.toMatch(/\bfetch\s*\(/);
      expect(coreSource).not.toMatch(/XMLHttpRequest/);
    });
  });

  describe("shell.ts — Imperative Shell (MUST have I/O)", () => {
    it("DOES have node:fs import (impure shell)", () => {
      expect(shellSource).toMatch(/from\s+["']node:fs(\/promises)?["']/);
    });

    it("DOES have node:os import (for homedir)", () => {
      expect(shellSource).toMatch(/from\s+["']node:os["']/);
    });

    it("DOES have node:path import (for path operations)", () => {
      expect(shellSource).toMatch(/from\s+["']node:path["']/);
    });

    it("imports from core.ts (uses the Functional Core)", () => {
      expect(shellSource).toMatch(/from\s+["']\.\/core["']/);
    });
  });

  describe("Architectural Boundary", () => {
    it("core.ts exports ContractViolation error type", () => {
      expect(coreSource).toMatch(/export\s+class\s+ContractViolation/);
    });

    it("core.ts exports require/ensure/invariant contract functions", () => {
      expect(coreSource).toMatch(/export\s+function\s+require/);
      expect(coreSource).toMatch(/export\s+function\s+ensure/);
      expect(coreSource).toMatch(/export\s+function\s+invariant/);
    });

    it("shell.ts exports SaveFailedError", () => {
      expect(shellSource).toMatch(/export\s+class\s+SaveFailedError/);
    });

    it("shell.ts exports LoadResult type", () => {
      expect(shellSource).toMatch(/export\s+type\s+LoadResult/);
    });

    it("shell.ts exports CONFIG_PATH (required for integration tests)", () => {
      expect(shellSource).toMatch(/export\s+const\s+CONFIG_PATH/);
    });
  });
});

describe("Runtime Integrity — Tampering Detection", () => {
  beforeEach(async () => {
    _resetConfigVersionForTesting();
    try { await fsp.unlink(CONFIG_PATH); } catch { /* file may not exist */ }
  });

  afterEach(async () => {
    try { await fsp.unlink(CONFIG_PATH); } catch { /* best-effort cleanup */ }
  });

  it("detects config tampering via checksum mismatch", async () => {
    await saveConfig(
      RedactorConfig.createDefault().addPattern(Pattern.create("test", "[T]"))
    );

    const raw = await fsp.readFile(CONFIG_PATH, "utf-8");
    const tampered = raw.replace('"test"', '"hacked"');

    await fsp.writeFile(CONFIG_PATH, tampered);

    const result = await loadConfig();

    expect(result.status).toBe("recovered");
    expect(result.warning).toContain("integrity");
  });

  it("loads a valid (untampered) config without warnings", async () => {
    await saveConfig(
      RedactorConfig.createDefault().addPattern(Pattern.create("secret", "[S]"))
    );

    const result = await loadConfig();

    expect(result.status).toBe("ok");
    expect(result.warning).toBeUndefined();
    expect(result.config.patterns.length).toBe(1);
  });

  it("round-trips config data accurately through envelope", async () => {
    const original = RedactorConfig.createDefault()
      .addPattern(Pattern.create("alpha", "[A]"))
      .addPattern(Pattern.create("beta", "[B]"));

    await saveConfig(original);

    const result = await loadConfig();

    expect(result.status).toBe("ok");
    expect(result.config.patterns.length).toBe(2);
    expect(result.config.patterns.toArray()[0].original.raw).toBe("alpha");
    expect(result.config.patterns.toArray()[1].original.raw).toBe("beta");
  });
});
