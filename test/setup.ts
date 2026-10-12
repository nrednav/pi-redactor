import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// Redirect the redactor state directory to an ephemeral temp dir BEFORE
// src/shell.ts is imported by any test file.
//
// Why this exists: CONFIG_PATH is `export const`-bound at module load from
// getStateDir(), which honors XDG_STATE_HOME. The integrity tests
// (test/integrity.test.ts) call fsp.unlink(CONFIG_PATH) in beforeEach /
// afterEach to manage test fixtures. If CONFIG_PATH resolves to the real
// user state dir (~/.local/state/pi-redactor/config.json), those unlinks
// destroy the user's actual config — and under a docker bind-mount, the
// file on the host filesystem.
//
// This setup file runs before test modules are imported (vitest setupFiles
// contract), so setting XDG_STATE_HOME here is in time for the const binding.
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-redactor-test-"));

process.env.XDG_STATE_HOME = testStateDir;

// Best-effort cleanup of the temp dir when the process exits. Tests create
// small config files; leaving them in os.tmpdir() is harmless, but tidiness
// avoids path-with-state surprises across runs.
process.on("exit", () => {
  try {
    fs.rmSync(testStateDir, { recursive: true, force: true });
  } catch {
    // Temp dir cleanup is best-effort; do not mask real failures.
  }
});
