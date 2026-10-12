import { defineConfig } from "vitest/config";

// setupFiles runs in each worker BEFORE test files import their dependencies.
// This is load-bearing for test isolation: src/shell.ts binds CONFIG_PATH at
// module-load time from getStateDir(), which honors XDG_STATE_HOME. The setup
// file sets XDG_STATE_HOME to an ephemeral temp dir so CONFIG_PATH resolves
// there instead of the user's real ~/.local/state/pi-redactor/config.json —
// which the integrity tests' fsp.unlink(CONFIG_PATH) would otherwise clobber
// (and, under a docker bind-mount, destroy the host file).
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
