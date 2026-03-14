import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fsp from "node:fs/promises";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { RedactorConfig, Pattern, ContractViolation, executeCommand, parseCommand } from "../src/core";
import type { Effect } from "../src/core";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  access: vi.fn(),
  unlink: vi.fn(),
}));

import { loadConfig, saveConfig, SaveFailedError, EffectError, interpretEffects, _resetConfigVersionForTesting, CONFIG_PATH } from "../src/shell";

describe("shell.ts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetConfigVersionForTesting();
  });

  describe("loadConfig()", () => {
    it("returns status 'ok' for valid config file (envelope format)", async () => {
      const data = {
        enabled: true,
        patterns: [{ original: "secret", replacement: "[REDACTED]", createdAt: 0 }],
      };

      const dataStr = JSON.stringify(data);

      const checksum = require("node:crypto")
        .createHash("sha256")
        .update(dataStr)
        .digest("hex");

      const validJson = JSON.stringify({ version: 1, checksum, data });

      vi.mocked(fsp.readFile).mockResolvedValue(validJson as any);

      const result = await loadConfig();

      expect(result.status).toBe("ok");
      expect(result.config.patterns.length).toBe(1);
      expect(result.warning).toBeUndefined();
    });

    it("returns status 'recovered' for non-envelope JSON (no version/checksum/data)", async () => {
      const validJson = JSON.stringify({
        enabled: true,
        patterns: [{ original: "secret", replacement: "[REDACTED]" }],
      });

      vi.mocked(fsp.readFile).mockResolvedValue(validJson as any);

      const result = await loadConfig();

      expect(result.status).toBe("recovered");
      expect(result.warning).toBeDefined();
      expect(result.config.patterns.length).toBe(0);
    });

    it("returns status 'default' when file does not exist (ENOENT)", async () => {
      const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;

      error.code = "ENOENT";

      vi.mocked(fsp.readFile).mockRejectedValue(error);

      const result = await loadConfig();

      expect(result.status).toBe("default");
      expect(result.config.patterns.length).toBe(0);
      expect(result.config.isEnabled).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it("returns status 'recovered' with warning for corrupt JSON", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue("{ invalid json" as any);

      const result = await loadConfig();

      expect(result.status).toBe("recovered");
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("corrupted");
    });

    it("returns status 'recovered' for permission error (EACCES)", async () => {
      const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;

      error.code = "EACCES";

      vi.mocked(fsp.readFile).mockRejectedValue(error);

      const result = await loadConfig();

      expect(result.status).toBe("recovered");
      expect(result.warning).toBeDefined();
    });

    it("returns status 'recovered' for any non-ENOENT error", async () => {
      const error = new Error("Some other error");

      vi.mocked(fsp.readFile).mockRejectedValue(error);

      const result = await loadConfig();

      expect(result.status).toBe("recovered");
    });

    it("skips malformed patterns in valid envelope", async () => {
      const data = {
        enabled: true,
        patterns: [
          { original: "valid", replacement: "[OK]", createdAt: 0 },
          { original: "", replacement: "[BAD]", createdAt: 0 },
          { wrongKey: "value" },
        ],
      };

      const dataStr = JSON.stringify(data);

      const checksum = require("node:crypto")
        .createHash("sha256")
        .update(dataStr)
        .digest("hex");

      const json = JSON.stringify({ version: 1, checksum, data });

      vi.mocked(fsp.readFile).mockResolvedValue(json as any);

      const result = await loadConfig();

      expect(result.status).toBe("ok");
      expect(result.config.patterns.length).toBe(1);
    });
  });

  describe("saveConfig()", () => {
    it("creates directory if needed", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const config = RedactorConfig.createDefault();

      await saveConfig(config);

      expect(fsp.mkdir).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });

    it("writes to temp file then renames (atomic pattern)", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const config = RedactorConfig.createDefault();

      await saveConfig(config);

      expect(fsp.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.any(String),
        "utf-8"
      );

      expect(fsp.rename).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.stringContaining("config.json")
      );
    });

    it("writes valid JSON content in envelope format with checksum", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create("test", "[HIDDEN]")
      );

      await saveConfig(config);

      const writtenContent = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);

      expect(parsed.version).toBe(1);
      expect(typeof parsed.checksum).toBe("string");
      expect(parsed.checksum).toHaveLength(64);
      expect(parsed.data.enabled).toBe(true);
      expect(parsed.data.patterns).toHaveLength(1);
      expect(parsed.data.patterns[0].original).toBe("test");
    });

    it("cleans up temp file on write failure", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockRejectedValue(new Error("Disk full"));
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.unlink).mockResolvedValue(undefined);

      const config = RedactorConfig.createDefault();

      await expect(saveConfig(config)).rejects.toThrow("Disk full");

      expect(fsp.unlink).toHaveBeenCalled();
    });

    it("cleans up temp file on rename failure", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockRejectedValue(new Error("Rename failed"));
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.unlink).mockResolvedValue(undefined);

      const config = RedactorConfig.createDefault();

      await expect(saveConfig(config)).rejects.toThrow("Rename failed");

      expect(fsp.unlink).toHaveBeenCalled();
    });

    it("ignores cleanup errors silently", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockRejectedValue(new Error("Write failed"));
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.unlink).mockRejectedValue(new Error("Cleanup also failed"));

      const config = RedactorConfig.createDefault();

      await expect(saveConfig(config)).rejects.toThrow("Write failed");
    });
  });

  describe("SaveFailedError", () => {
    it("is exported and constructable", () => {
      const error = new SaveFailedError("test message");

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("SaveFailedError");
      expect(error.message).toBe("test message");
    });

    it("has correct prototype chain", () => {
      const error = new SaveFailedError("test");

      expect(error instanceof SaveFailedError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe("interpretEffects()", () => {
    const createMockContext = () =>
      ({
        ui: {
          notify: vi.fn(),
          setStatus: vi.fn(),
          confirm: vi.fn().mockResolvedValue(false),
        },
      }) as unknown as ExtensionContext;

    it("handles notify effect", async () => {
      const ctx = createMockContext();
      const effects: Effect[] = [
        { type: "notify", message: "Test message", level: "info" },
      ];

      await interpretEffects(effects, ctx, vi.fn());

      expect(ctx.ui.notify).toHaveBeenCalledWith("Test message", "info");
    });

    it("handles notify effect with all levels", async () => {
      const ctx = createMockContext();

      for (const level of ["info", "success", "warning", "error"] as const) {
        const effects: Effect[] = [{ type: "notify", message: `Level: ${level}`, level }];
        await interpretEffects(effects, ctx, vi.fn());
        expect(ctx.ui.notify).toHaveBeenCalledWith(`Level: ${level}`, level);
      }
    });

    it("handles updateStatus effect", async () => {
      const ctx = createMockContext();
      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create("test", "[HIDDEN]")
      );
      const effects: Effect[] = [{ type: "updateStatus", config }];

      await interpretEffects(effects, ctx, vi.fn());

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "redactor",
        expect.stringContaining("1 pattern")
      );
    });

    it("handles save effect successfully", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();
      const config = RedactorConfig.createDefault();
      const effects: Effect[] = [{ type: "save", config }];

      await interpretEffects(effects, ctx, vi.fn());

      expect(fsp.writeFile).toHaveBeenCalled();
    });

    it("handles save effect failure with SaveFailedError", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockRejectedValue(new Error("Permission denied"));
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();
      const config = RedactorConfig.createDefault();
      const effects: Effect[] = [{ type: "save", config }];

      await expect(interpretEffects(effects, ctx, vi.fn())).rejects.toThrow(
        SaveFailedError
      );

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Failed to save"),
        "error"
      );
    });

    it("handles confirm effect when declined", async () => {
      const ctx = createMockContext();

      vi.mocked(ctx.ui.confirm).mockResolvedValue(false);

      const onConfigChange = vi.fn();
      const clearedConfig = RedactorConfig.createDefault();
      const effects: Effect[] = [
        {
          type: "confirm",
          title: "Confirm",
          message: "Are you sure?",
          confirmedOutcome: {
            config: clearedConfig,
            effects: [{ type: "notify", message: "Confirmed!", level: "success" }],
          },
        },
      ];

      await interpretEffects(effects, ctx, onConfigChange);

      expect(ctx.ui.confirm).toHaveBeenCalledWith("Confirm", "Are you sure?");
      expect(onConfigChange).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalledWith("Confirmed!", "success");
    });

    it("handles confirm effect when accepted", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();

      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

      const onConfigChange = vi.fn();
      const clearedConfig = RedactorConfig.createDefault();
      const effects: Effect[] = [
        {
          type: "confirm",
          title: "Confirm",
          message: "Are you sure?",
          confirmedOutcome: {
            config: clearedConfig,
            effects: [{ type: "notify", message: "Confirmed!", level: "success" }],
          },
        },
      ];

      await interpretEffects(effects, ctx, onConfigChange);

      expect(onConfigChange).toHaveBeenCalledWith(clearedConfig);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Confirmed!", "success");
    });

    it("continues processing effects after non-critical failure", async () => {
      const ctx = createMockContext();

      vi.mocked(ctx.ui.notify).mockImplementationOnce(() => {
        throw new Error("Notify failed");
      });

      const effects: Effect[] = [
        { type: "notify", message: "Will fail", level: "info" },
        { type: "updateStatus", config: RedactorConfig.createDefault() },
      ];

      await interpretEffects(effects, ctx, vi.fn());

      expect(ctx.ui.setStatus).toHaveBeenCalled();
    });

    it("processes multiple effects in order", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();
      const config = RedactorConfig.createDefault();
      const callOrder: string[] = [];

      vi.mocked(ctx.ui.notify).mockImplementation(() => {
        callOrder.push("notify");
      });

      vi.mocked(fsp.writeFile).mockImplementation(async () => {
        callOrder.push("save");
      });

      vi.mocked(ctx.ui.setStatus).mockImplementation(() => {
        callOrder.push("status");
      });

      const effects: Effect[] = [
        { type: "save", config },
        { type: "notify", message: "Adding", level: "success" },
        { type: "updateStatus", config },
      ];

      await interpretEffects(effects, ctx, vi.fn());

      expect(callOrder).toEqual(["save", "notify", "status"]);
    });

    it("confirm accepted → save fails → onConfigChange is NOT called", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockRejectedValue(new Error("Disk full"));
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();

      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

      const onConfigChange = vi.fn();
      const clearedConfig = RedactorConfig.createDefault();
      const originalConfig = RedactorConfig.createDefault().addPattern(
        Pattern.create("secret", "[X]")
      );
      const effects: Effect[] = [
        {
          type: "confirm",
          title: "Clear all",
          message: "Are you sure?",
          confirmedOutcome: {
            config: clearedConfig,
            effects: [
              { type: "notify", message: "Cleared!", level: "success" },
              { type: "save", config: clearedConfig },
              { type: "updateStatus", config: clearedConfig },
            ],
          },
        },
      ];

      await expect(
        interpretEffects(effects, ctx, onConfigChange)
      ).rejects.toThrow(SaveFailedError);

      expect(onConfigChange).not.toHaveBeenCalled();
    });

    it("confirm accepted → save succeeds → onConfigChange IS called with confirmed config", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();

      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

      const onConfigChange = vi.fn();
      const clearedConfig = RedactorConfig.createDefault();
      const effects: Effect[] = [
        {
          type: "confirm",
          title: "Clear all",
          message: "Are you sure?",
          confirmedOutcome: {
            config: clearedConfig,
            effects: [
              { type: "notify", message: "Cleared!", level: "success" },
              { type: "save", config: clearedConfig },
              { type: "updateStatus", config: clearedConfig },
            ],
          },
        },
      ];

      await interpretEffects(effects, ctx, onConfigChange);

      expect(onConfigChange).toHaveBeenCalledTimes(1);
      expect(onConfigChange).toHaveBeenCalledWith(clearedConfig);
    });
  });

  describe("Observability", () => {
    const createMockContext = () =>
      ({
        ui: {
          notify: vi.fn(),
          setStatus: vi.fn(),
          confirm: vi.fn().mockResolvedValue(false),
        },
      }) as unknown as ExtensionContext;

    it("notify effect emits correct message and level", async () => {
      const ctx = createMockContext();
      const effects: Effect[] = [
        { type: "notify", message: "Operation complete", level: "success" },
      ];

      await interpretEffects(effects, ctx, vi.fn());

      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Operation complete", "success");
    });

    it("updateStatus shows correct pattern count", async () => {
      const ctx = createMockContext();
      const config = RedactorConfig.createDefault()
        .addPattern(Pattern.create("one", "[FIRST]"))
        .addPattern(Pattern.create("two", "[SECOND]"));
      const effects: Effect[] = [{ type: "updateStatus", config }];

      await interpretEffects(effects, ctx, vi.fn());

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "redactor",
        expect.stringContaining("2 pattern")
      );
    });

    it("updateStatus shows 'off' when disabled", async () => {
      const ctx = createMockContext();
      const config = RedactorConfig.createDefault().disable();
      const effects: Effect[] = [{ type: "updateStatus", config }];

      await interpretEffects(effects, ctx, vi.fn());

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "redactor",
        expect.stringContaining("off")
      );
    });

    it("updateStatus shows 'no patterns' when enabled with zero patterns", async () => {
      const ctx = createMockContext();
      const config = RedactorConfig.createDefault(); // enabled, 0 patterns
      const effects: Effect[] = [{ type: "updateStatus", config }];

      await interpretEffects(effects, ctx, vi.fn());

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "redactor",
        expect.stringContaining("no patterns")
      );
    });

    it("save failure notifies with error level before throwing", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockRejectedValue(new Error("ENOSPC: no space left"));
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();
      const config = RedactorConfig.createDefault();
      const effects: Effect[] = [{ type: "save", config }];

      await expect(interpretEffects(effects, ctx, vi.fn())).rejects.toThrow();

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Failed to save"),
        "error"
      );
    });
  });

  describe("Resource Asymmetry", () => {
    it("handles pattern at MAX_PATTERN_LENGTH without hanging", () => {
      const longString = "x".repeat(1000);

      const start = Date.now();
      const pattern = Pattern.create(longString, "[LONG]");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
      expect(pattern.original.raw.length).toBe(1000);
    });

    it("rejects pattern exceeding MAX_PATTERN_LENGTH", () => {
      const tooLong = "x".repeat(1001);
      expect(() => Pattern.create(tooLong, "[LONG]")).toThrow(ContractViolation);
    });

    it("handles pattern with special regex characters", () => {
      const specialChars = ".*+?^${}()|[]\\";
      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create(specialChars, "[SPECIAL]")
      );

      const result = config.redact(`Text with ${specialChars} in it`);

      expect(result.text).toBe("Text with [SPECIAL] in it");
      expect(result.matchCount).toBe(1);
    });

    it("parseJSON handles many patterns gracefully", () => {
      const manyPatterns = Array.from({ length: 500 }, (_, i) => ({
        original: `pattern${i}`,
        replacement: `[REPL${i}]`,
      }));

      const json = { enabled: true, patterns: manyPatterns };

      const start = Date.now();
      const { config } = RedactorConfig.parseJSON(json);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
      expect(config.patterns.length).toBe(500);
    });

    it("parseJSON handles deeply malformed input gracefully", () => {
      const malformed = {
        enabled: "not a boolean",
        patterns: [
          null,
          undefined,
          42,
          "string",
          { wrongKeys: true },
          { original: null, replacement: "x" },
          { original: "valid", replacement: "[OK]" },
        ],
      };

      const { config } = RedactorConfig.parseJSON(malformed);

      expect(config.patterns.length).toBe(1);
      expect(config.isEnabled).toBe(true);
    });
  });

  describe("Metabolic Profiling", () => {
    it("redacts 50 patterns against 10KB text in under 100ms", () => {
      let config = RedactorConfig.createDefault();

      for (let patternIndex = 0; patternIndex < 50; patternIndex++) {
        const pattern = Pattern.create(`secret${patternIndex}`, `[REDACTED_${patternIndex}]`);
        config = config.addPattern(pattern);
      }

      const text = Array(100)
        .fill("This contains secret0 and secret25 and other words. ")
        .join("");

      expect(text.length).toBeGreaterThan(5000);

      const start = performance.now();
      const result = config.redact(text);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
      expect(result.wasRedacted).toBe(true);
      expect(result.matchCount).toBeGreaterThan(0);
    });

    it("pattern matching scales linearly with text size", () => {
      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create("needle", "[FOUND]")
      );

      const text1k = "x".repeat(1000) + "needle" + "x".repeat(1000);

      const start1 = performance.now();
      config.redact(text1k);
      const elapsed1 = performance.now() - start1;

      const text10k = "x".repeat(10000) + "needle" + "x".repeat(10000);

      const start2 = performance.now();
      config.redact(text10k);
      const elapsed2 = performance.now() - start2;

      // 10x text should not be more than 50x slower (catches O(n^2))
      expect(elapsed2).toBeLessThan(elapsed1 * 50);
    });

    it("empty pattern list returns immediately", () => {
      const config = RedactorConfig.createDefault();
      const hugeText = "x".repeat(100_000);

      const start = performance.now();
      const result = config.redact(hugeText);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(10);
      expect(result.wasRedacted).toBe(false);
    });
  });

  describe("Optimistic Concurrency Control", () => {
    const crypto = require("node:crypto");

    const makeEnvelope = (configVersion: number): string => {
      const data = RedactorConfig.createDefault().toJSON();
      const dataStr = JSON.stringify(data);
      const checksum = crypto.createHash("sha256").update(dataStr).digest("hex");

      return JSON.stringify({ version: 1, configVersion, checksum, data });
    };

    const mockSuccessfulSave = () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));
    };

    it("detects concurrent modification", async () => {
      vi.mocked(fsp.readFile).mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      mockSuccessfulSave();

      await saveConfig(RedactorConfig.createDefault());

      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(1) as any);

      await loadConfig();

      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(2) as any);

      await expect(
        saveConfig(
          RedactorConfig.createDefault().addPattern(Pattern.create("test", "[T]"))
        )
      ).rejects.toThrow("modified by another session");
    });

    it("allows save when no prior load has occurred (null baseline)", async () => {
      vi.mocked(fsp.readFile).mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      mockSuccessfulSave();

      await expect(saveConfig(RedactorConfig.createDefault())).resolves.toBeUndefined();
    });

    it("allows save when on-disk version matches last known version", async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(1) as any);

      await loadConfig();

      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(1) as any);

      mockSuccessfulSave();

      await expect(saveConfig(RedactorConfig.createDefault())).resolves.toBeUndefined();
    });

    it("advances lastKnownConfigVersion after a successful save", async () => {
      vi.mocked(fsp.readFile).mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      mockSuccessfulSave();

      await saveConfig(RedactorConfig.createDefault());

      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(1) as any);

      mockSuccessfulSave();

      await saveConfig(RedactorConfig.createDefault());

      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(2) as any);

      mockSuccessfulSave();

      await expect(saveConfig(RedactorConfig.createDefault())).resolves.toBeUndefined();
    });

    it("error message directs user to reload", async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(1) as any);

      await loadConfig();

      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(99) as any);

      const caughtError = await saveConfig(RedactorConfig.createDefault()).catch((error) => error);

      expect(caughtError).toBeInstanceOf(SaveFailedError);
      expect(caughtError.message).toMatch(/\/redact list/);
    });
  });

  describe("Checksum Verification", () => {
    const crypto = require("node:crypto");

    const makeEnvelopeWithBadChecksum = (configVersion = 1): string => {
      const data = RedactorConfig.createDefault().toJSON();

      return JSON.stringify({
        version: 1,
        configVersion,
        checksum: "0".repeat(64),
        data,
      });
    };

    const makeEnvelopeWithPatterns = (patterns: unknown[], badChecksum = false): string => {
      const data = { enabled: true, patterns };
      const dataStr = JSON.stringify(data);
      const validChecksum = crypto.createHash("sha256").update(dataStr).digest("hex");

      return JSON.stringify({
        version: 1,
        configVersion: 1,
        checksum: badChecksum ? "0".repeat(64) : validChecksum,
        data,
      });
    };

    it("returns status 'recovered' with integrity warning on checksum mismatch", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(makeEnvelopeWithBadChecksum() as any);

      const result = await loadConfig();

      expect(result.status).toBe("recovered");
      expect(result.warning).toContain("integrity check failed");
    });

    it("integrity warning mentions potential tampering", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(makeEnvelopeWithBadChecksum() as any);

      const result = await loadConfig();

      expect(result.warning).toContain("tampered");
    });

    it("checksum mismatch still extracts valid patterns into config", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        makeEnvelopeWithPatterns(
          [{ original: "secret", replacement: "[REDACTED]", createdAt: 0 }],
          true
        ) as any
      );

      const result = await loadConfig();

      expect(result.status).toBe("recovered");
      expect(result.config.patterns.length).toBe(1);
    });

    it("checksum mismatch populates patternWarnings for invalid patterns in the payload", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        makeEnvelopeWithPatterns(
          [
            { original: "valid", replacement: "[OK]", createdAt: 0 },
            { original: "", replacement: "[BAD]", createdAt: 0 },
          ],
          true
        ) as any
      );

      const result = await loadConfig();

      expect(result.patternWarnings.length).toBeGreaterThan(0);
    });

    it("does not set optimistic-lock baseline on checksum mismatch", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(makeEnvelopeWithBadChecksum(5) as any);
      await loadConfig();

      vi.mocked(fsp.readFile).mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      await expect(saveConfig(RedactorConfig.createDefault())).resolves.toBeUndefined();
    });
  });

  describe("Stale lastKnownConfigVersion after recovery", () => {
    const crypto = require("node:crypto");

    const makeEnvelope = (configVersion: number): string => {
      const data = RedactorConfig.createDefault().toJSON();
      const dataStr = JSON.stringify(data);
      const checksum = crypto.createHash("sha256").update(dataStr).digest("hex");

      return JSON.stringify({ version: 1, configVersion, checksum, data });
    };

    const makeEnvelopeWithBadChecksum = (configVersion: number): string => {
      const data = RedactorConfig.createDefault().toJSON();

      return JSON.stringify({
        version: 1,
        configVersion,
        checksum: "0".repeat(64),
        data,
      });
    };

    const mockSuccessfulSave = () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));
    };

    it("load valid config (version 5) → load corrupted non-envelope → save succeeds", async () => {
      // First load: valid envelope with configVersion 5
      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(5) as any);

      const firstLoad = await loadConfig();

      expect(firstLoad.status).toBe("ok");

      // Second load: non-envelope JSON (corrupted externally)
      vi.mocked(fsp.readFile).mockResolvedValueOnce(
        JSON.stringify({ not: "an envelope" }) as any
      );

      const secondLoad = await loadConfig();

      expect(secondLoad.status).toBe("recovered");

      // Save: disk file is gone (ENOENT), should bootstrap fresh and not throw SaveFailedError
      vi.mocked(fsp.readFile).mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      mockSuccessfulSave();

      await expect(saveConfig(RedactorConfig.createDefault())).resolves.toBeUndefined();
    });

    it("load valid config (version 5) → load checksum-mismatch → save succeeds", async () => {
      // First load: valid envelope with configVersion 5
      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(5) as any);

      const firstLoad = await loadConfig();

      expect(firstLoad.status).toBe("ok");

      // Second load: envelope structure but tampered checksum
      vi.mocked(fsp.readFile).mockResolvedValueOnce(
        makeEnvelopeWithBadChecksum(5) as any
      );

      const secondLoad = await loadConfig();

      expect(secondLoad.status).toBe("recovered");

      // Save: disk file is gone (ENOENT), should bootstrap fresh and not throw SaveFailedError
      vi.mocked(fsp.readFile).mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      mockSuccessfulSave();

      await expect(saveConfig(RedactorConfig.createDefault())).resolves.toBeUndefined();
    });
  });

  describe("Pattern Warning Aggregation", () => {
    const crypto = require("node:crypto");

    const makeEnvelopeWithPatterns = (patterns: unknown[]): string => {
      const data = { enabled: true, patterns };
      const dataStr = JSON.stringify(data);
      const checksum = crypto.createHash("sha256").update(dataStr).digest("hex");

      return JSON.stringify({ version: 1, configVersion: 1, checksum, data });
    };

    it("returns empty patternWarnings array for all-valid patterns", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        makeEnvelopeWithPatterns([
          { original: "secret", replacement: "[REDACTED]", createdAt: 0 },
        ]) as any
      );

      const result = await loadConfig();

      expect(result.patternWarnings).toEqual([]);
    });

    it("emits exactly one warning per invalid pattern", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        makeEnvelopeWithPatterns([
          { original: "valid", replacement: "[OK]", createdAt: 0 },
          { original: "", replacement: "[BAD]", createdAt: 0 },
          { wrongKey: "value" },
        ]) as any
      );

      const result = await loadConfig();

      expect(result.patternWarnings).toHaveLength(2);
    });

    it("warning messages identify the 1-based pattern index", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        makeEnvelopeWithPatterns([
          { original: "", replacement: "[BAD]", createdAt: 0 },
          { original: "good", replacement: "[OK]", createdAt: 0 },
          { wrongKey: "value" },
        ]) as any
      );

      const result = await loadConfig();

      expect(result.patternWarnings[0]).toContain("#1");
      expect(result.patternWarnings[1]).toContain("#3");
    });

    it("warns for non-object pattern entries (null, number, string)", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        makeEnvelopeWithPatterns([null, 42, "string-value"]) as any
      );

      const result = await loadConfig();

      expect(result.patternWarnings).toHaveLength(3);
      expect(result.patternWarnings[0]).toContain("Invalid format");
    });

    it("warns for patterns with an empty replacement field", async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        makeEnvelopeWithPatterns([
          { original: "secret", replacement: "", createdAt: 0 },
        ]) as any
      );

      const result = await loadConfig();

      expect(result.patternWarnings).toHaveLength(1);
      expect(result.patternWarnings[0]).toContain("replacement");
    });
  });

  describe("Effect Chain Error Handling", () => {
    const createMockContext = () =>
      ({
        ui: {
          notify: vi.fn(),
          setStatus: vi.fn(),
          confirm: vi.fn().mockResolvedValue(false),
        },
      }) as unknown as ExtensionContext;

    it("logs EffectError messages to console.error after the chain completes", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const ctx = createMockContext();

      vi.mocked(ctx.ui.notify).mockImplementationOnce(() => {
        throw new Error("Notify exploded");
      });

      await interpretEffects(
        [{ type: "notify", message: "will fail", level: "info" }],
        ctx,
        vi.fn()
      );

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Notify exploded")
      );
      consoleSpy.mockRestore();
    });

    it("collects all non-critical failures before logging — no early exit", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const ctx = createMockContext();

      vi.mocked(ctx.ui.notify)
        .mockImplementationOnce(() => { throw new Error("First failure"); })
        .mockImplementationOnce(() => { throw new Error("Second failure"); });

      await interpretEffects(
        [
          { type: "notify", message: "one", level: "info" },
          { type: "notify", message: "two", level: "info" },
        ],
        ctx,
        vi.fn()
      );

      expect(consoleSpy).toHaveBeenCalledTimes(2);

      consoleSpy.mockRestore();
    });

    it("does not call console.error when all effects succeed", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const ctx = createMockContext();

      await interpretEffects(
        [{ type: "notify", message: "success", level: "info" }],
        ctx,
        vi.fn()
      );

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("SaveFailedError propagates immediately — subsequent effects are skipped", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockRejectedValue(new Error("ENOSPC: no space left"));
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();
      const config = RedactorConfig.createDefault();

      await expect(
        interpretEffects(
          [
            { type: "save", config },
            { type: "notify", message: "after save", level: "success" },
          ],
          ctx,
          vi.fn()
        )
      ).rejects.toThrow(SaveFailedError);

      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Failed to save"),
        "error"
      );
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("EffectError class", () => {
    it("stores effectType and cause on the instance", () => {
      const cause = new Error("root cause");
      const err = new EffectError("notify", cause);

      expect(err.effectType).toBe("notify");
      expect(err.cause).toBe(cause);
    });

    it("has correct name and prototype chain", () => {
      const err = new EffectError("save", new Error("disk full"));

      expect(err.name).toBe("EffectError");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EffectError);
    });

    it("message embeds both effectType and cause message", () => {
      const err = new EffectError("updateStatus", new Error("ctx is undefined"));

      expect(err.message).toContain("updateStatus");
      expect(err.message).toContain("ctx is undefined");
    });
  });

  describe("saveConfig non-envelope file during lock read", () => {
    const crypto = require("node:crypto");

    const makeEnvelope = (configVersion: number): string => {
      const data = RedactorConfig.createDefault().toJSON();
      const dataStr = JSON.stringify(data);
      const checksum = crypto.createHash("sha256").update(dataStr).digest("hex");
      return JSON.stringify({ version: 1, configVersion, checksum, data });
    };

    const mockSuccessfulSave = () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));
    };

    it("treats a non-envelope on-disk file as version 0 for the lock check", async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce(makeEnvelope(1) as any);

      await loadConfig();

      vi.mocked(fsp.readFile).mockResolvedValueOnce(
        JSON.stringify({ enabled: true, patterns: [] }) as any
      );

      await expect(saveConfig(RedactorConfig.createDefault())).rejects.toThrow(
        "modified by another session"
      );
    });

    it("succeeds with non-envelope on-disk file when no baseline is established", async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce(
        JSON.stringify({ enabled: true, patterns: [] }) as any
      );

      mockSuccessfulSave();

      await expect(saveConfig(RedactorConfig.createDefault())).resolves.toBeUndefined();
    });
  });

  describe("CONFIG_PATH validation", () => {
    it("CONFIG_PATH is an absolute path", () => {
      const nodePath = require("node:path");
      expect(nodePath.isAbsolute(CONFIG_PATH)).toBe(true);
    });

    it("CONFIG_PATH ends with the expected filename", () => {
      expect(CONFIG_PATH).toMatch(/config\.json$/);
    });
  });

  describe("_resetConfigVersionForTesting guard", () => {
    it("succeeds inside Vitest (VITEST env var present)", () => {
      expect(process.env.VITEST).toBeDefined();
      expect(() => _resetConfigVersionForTesting()).not.toThrow();
    });

    it("throws outside test environments", () => {
      const original = process.env.VITEST;

      delete process.env.VITEST;

      try {
        expect(() => _resetConfigVersionForTesting()).toThrow(
          "only available in test environments"
        );
      } finally {
        process.env.VITEST = original;
      }
    });
  });

  describe("Confirm-gated command integration", () => {
    const createMockContext = () =>
      ({
        ui: {
          notify: vi.fn(),
          setStatus: vi.fn(),
          confirm: vi.fn().mockResolvedValue(false),
        },
      }) as unknown as ExtensionContext;

    it("clear command retains cleared config after confirm acceptance", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();

      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

      const originalConfig = RedactorConfig.createDefault()
        .addPattern(Pattern.create("secret", "[X]"));

      let config = originalConfig;

      const result = executeCommand(parseCommand("clear"), config);

      let configUpdatedByConfirm = false;

      await interpretEffects(result.effects, ctx, (newConfig) => {
        config = newConfig;
        configUpdatedByConfirm = true;
      });

      if (!configUpdatedByConfirm) {
        config = result.config;
      }

      expect(config.patterns.isEmpty).toBe(true);
      expect(configUpdatedByConfirm).toBe(true);
    });

    it("non-confirm command applies result.config when no confirm occurs", async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.rename).mockResolvedValue(undefined);
      vi.mocked(fsp.access).mockRejectedValue(new Error("ENOENT"));

      const ctx = createMockContext();

      let config = RedactorConfig.createDefault();

      const result = executeCommand(parseCommand("add secret"), config);

      let configUpdatedByConfirm = false;

      await interpretEffects(result.effects, ctx, (newConfig) => {
        config = newConfig;
        configUpdatedByConfirm = true;
      });

      if (!configUpdatedByConfirm) {
        config = result.config;
      }

      expect(config.patterns.has("secret")).toBe(true);
      expect(configUpdatedByConfirm).toBe(false);
    });

    it("declined confirm retains original config", async () => {
      const ctx = createMockContext();

      vi.mocked(ctx.ui.confirm).mockResolvedValue(false);

      const originalConfig = RedactorConfig.createDefault()
        .addPattern(Pattern.create("secret", "[X]"));

      let config = originalConfig;

      const result = executeCommand(parseCommand("clear"), config);

      let configUpdatedByConfirm = false;

      await interpretEffects(result.effects, ctx, (newConfig) => {
        config = newConfig;
        configUpdatedByConfirm = true;
      });

      if (!configUpdatedByConfirm) {
        config = result.config;
      }

      expect(config.patterns.has("secret")).toBe(true);
      expect(config.patterns.isEmpty).toBe(false);
      expect(configUpdatedByConfirm).toBe(false);
    });
  });
});
