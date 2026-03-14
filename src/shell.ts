import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RedactorConfig } from "./core";
import type { Effect, ConfigParseResult } from "./core";

export class SaveFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveFailedError";
  }
}

export class EffectError extends Error {
  constructor(
    public readonly effectType: string,
    public readonly cause: Error
  ) {
    super(`Effect "${effectType}" failed: ${cause.message}`);
    this.name = "EffectError";
  }
}

/**
 * Resolves the platform-appropriate state directory for data that should
 * persist across restarts but must never be committed to version control.
 *
 * - Linux/macOS: $XDG_STATE_HOME (default ~/.local/state)
 * - Windows:     %LOCALAPPDATA% (default ~/AppData/Local)
 */
function getStateDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();

  if (xdgStateHome && path.isAbsolute(xdgStateHome)) {
    return xdgStateHome;
  }

  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  }

  return path.join(os.homedir(), ".local", "state");
}

export const CONFIG_PATH = path.join(getStateDir(), "pi-redactor", "config.json");

/**
 * - "ok": Config loaded from existing file.
 * - "default": No config file exists (first run).
 * - "recovered": Config file was corrupted or unreadable.
 */
export type LoadResult = {
  config: RedactorConfig;
  status: "ok" | "default" | "recovered";
  warning?: string;
  patternWarnings: string[];
};

/**
 * `configVersion` is a monotonically incrementing counter for optimistic
 * concurrency control — it lets concurrent sessions detect conflicting writes.
 */
interface ConfigEnvelope {
  version: 1;
  configVersion: number;
  checksum: string;
  data: ReturnType<RedactorConfig["toJSON"]>;
}

/**
 * Tracks the configVersion last read/written by THIS process.
 * Null means no load has occurred this session — the concurrency check
 * is skipped so a fresh session can always bootstrap.
 */
let lastKnownConfigVersion: number | null = null;

/**
 * @internal For test isolation only.
 *
 * Guarded: throws at runtime outside Vitest to prevent
 * other extensions from resetting the concurrency baseline.
 */
export function _resetConfigVersionForTesting(): void {
  if (!process.env.VITEST) {
    throw new Error(
      "_resetConfigVersionForTesting is only available in test environments"
    );
  }

  lastKnownConfigVersion = null;
}

function computeChecksum(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function isConfigEnvelope(candidate: unknown): candidate is ConfigEnvelope {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "version" in candidate &&
    "checksum" in candidate &&
    "data" in candidate
  );
}

/**
 * Never crashes on startup due to a bad config file — returns a safe default
 * on any error so the extension can always initialise.
 */
export async function loadConfig(): Promise<LoadResult> {
  try {
    const rawFileContent = await fsp.readFile(CONFIG_PATH, "utf-8");
    const parsed: unknown = JSON.parse(rawFileContent);

    if (!isConfigEnvelope(parsed)) {
      lastKnownConfigVersion = null;
      return {
        config: RedactorConfig.createDefault(),
        status: "recovered",
        warning: "⚠️ Redactor config was corrupted or unreadable. Starting with no patterns.",
        patternWarnings: [],
      };
    }

    const serializedData = JSON.stringify(parsed.data);
    const expectedChecksum = computeChecksum(serializedData);

    if (parsed.checksum !== expectedChecksum) {
      lastKnownConfigVersion = null;
      const { config, warnings }: ConfigParseResult = RedactorConfig.parseJSON(parsed.data);

      return {
        config,
        status: "recovered",
        warning:
          "⚠️ Config file integrity check failed. File may have been tampered with.",
        patternWarnings: warnings,
      };
    }

    const { config, warnings }: ConfigParseResult = RedactorConfig.parseJSON(parsed.data);

    // configVersion may be absent on older files; default to 0.
    lastKnownConfigVersion = (parsed.configVersion as number | undefined) ?? 0;

    return { config, status: "ok", patternWarnings: warnings };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      lastKnownConfigVersion = null;
      return { config: RedactorConfig.createDefault(), status: "default", patternWarnings: [] };
    }

    return {
      config: RedactorConfig.createDefault(),
      status: "recovered",
      warning:
        "⚠️ Redactor config was corrupted or unreadable. Starting with no patterns.",
      patternWarnings: [],
    };
  }
}

/**
 * Atomic write: writes to a temp file then renames to prevent corruption
 * if the process is killed mid-write.
 *
 * Uses optimistic concurrency control via configVersion: if another process
 * wrote the file since this session last loaded it, throws SaveFailedError.
 */
export async function saveConfig(config: RedactorConfig): Promise<void> {
  let currentVersion = 0;

  try {
    const rawFileContent = await fsp.readFile(CONFIG_PATH, "utf-8");
    const existing: unknown = JSON.parse(rawFileContent);

    if (isConfigEnvelope(existing)) {
      currentVersion = (existing.configVersion as number | undefined) ?? 0;
    }
  } catch {
    // File absent or unreadable, currentVersion stays 0
  }

  // Only enforce when there is known baseline (fresh session always allows)
  if (lastKnownConfigVersion !== null && currentVersion !== lastKnownConfigVersion) {
    throw new SaveFailedError(
      "Config was modified by another session. Reload with /redact list and reapply changes."
    );
  }

  const newVersion = currentVersion + 1;
  const data = config.toJSON();
  const serializedData = JSON.stringify(data);
  const envelope: ConfigEnvelope = {
    version: 1,
    configVersion: newVersion,
    checksum: computeChecksum(serializedData),
    data,
  };
  const tempPath = CONFIG_PATH + ".tmp";

  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });

  try {
    await fsp.writeFile(tempPath, JSON.stringify(envelope, null, 2), "utf-8");
    await fsp.rename(tempPath, CONFIG_PATH);
  } finally {
    try {
      await fsp.access(tempPath);
      await fsp.unlink(tempPath);
    } catch {
      // Temp file already gone or never created, nothing to clean up
    }
  }

  lastKnownConfigVersion = newVersion;
}

export function updateStatus(
  config: RedactorConfig,
  context: ExtensionContext
): void {
  if (!config.isEnabled) {
    context.ui.setStatus("redactor", "🔓 Redactor: off");
  } else if (config.patterns.isEmpty) {
    context.ui.setStatus("redactor", "🔒 Redactor: no patterns");
  } else {
    context.ui.setStatus(
      "redactor",
      `🔒 Redactor: ${config.patterns.length} pattern(s)`
    );
  }
}

/**
 * The `onConfigChange` callback is the only mechanism by which effects
 * may update the caller's mutable config variable, keeping this interpreter
 * stateless while supporting deferred config changes (e.g. confirm).
 */
export async function interpretEffects(
  effects: Effect[],
  context: ExtensionContext,
  onConfigChange: (newConfig: RedactorConfig) => void
): Promise<void> {
  const errors: EffectError[] = [];

  for (const effect of effects) {
    try {
      switch (effect.type) {
        case "notify":
          context.ui.notify(effect.message, effect.level);
          break;

        case "save":
          try {
            await saveConfig(effect.config);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            context.ui.notify(
              `❌ Failed to save config: ${errorMessage}. Changes may not persist.`,
              "error"
            );

            throw new SaveFailedError(errorMessage);
          }
          break;

        case "updateStatus":
          updateStatus(effect.config, context);
          break;

        case "confirm": {
          const wasAccepted = await context.ui.confirm(effect.title, effect.message);

          if (wasAccepted) {
            await interpretEffects(
              effect.confirmedOutcome.effects,
              context,
              onConfigChange
            );

            // Only apply config change after all effects (including save) succeed.
            // If save throws SaveFailedError, onConfigChange never fires,
            // keeping in-memory config consistent with on-disk state.
            onConfigChange(effect.confirmedOutcome.config);
          }

          break;
        }
      }
    } catch (error) {
      if (error instanceof SaveFailedError) {
        throw error; // Save failures are critical so propagate immediately
      }

      errors.push(
        new EffectError(
          effect.type,
          error instanceof Error ? error : new Error(String(error))
        )
      );
    }
  }

  if (errors.length > 0) {
    for (const effectError of errors) {
      console.error(effectError.message);
    }
  }
}
