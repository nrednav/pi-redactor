import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  ContractViolation,
  RedactorConfig,
  executeCommand,
  parseCommand,
} from "./core";
import { interpretEffects, loadConfig, updateStatus, SaveFailedError } from "./shell";

export default function (pi: ExtensionAPI) {
  // Initialised to a safe default synchronously because session_start always
  // does a full reload before any user interaction, so the race window is
  // harmless.
  let config: RedactorConfig = RedactorConfig.createDefault();

  pi.on("session_start", async (_event, context) => {
    const loadResult = await loadConfig();

    config = loadResult.config;

    const isDegraded =
      loadResult.status === "recovered" || loadResult.patternWarnings.length > 0;

    if (loadResult.status === "recovered" && loadResult.warning) {
      context.ui.notify(loadResult.warning, "warning");
    }

    if (loadResult.patternWarnings.length > 0) {
      context.ui.notify(
        `⚠️ ${loadResult.patternWarnings.length} pattern(s) could not be loaded:\n` +
          loadResult.patternWarnings.slice(0, 3).join("\n") +
          (loadResult.patternWarnings.length > 3
            ? `\n... and ${loadResult.patternWarnings.length - 3} more. Run /redact list to review.`
            : ""),
        "warning"
      );
    }

    // If the config was degraded, disable redaction to prevent the user from
    // typing secrets while believing dropped patterns are protecting them.
    // They must explicitly re-enable after reviewing.
    if (isDegraded) {
      config = config.disable();
      context.ui.notify(
        "🛑 Redactor DISABLED — config could not be fully loaded. " +
        "Run /redact list to review, then /redact on to re-enable.",
        "error"
      );
    }

    const stalePatterns = config.patterns.getStalePatterns(90);

    if (stalePatterns.length > 0) {
      context.ui.notify(
        `⚠️ ${stalePatterns.length} pattern(s) added over 90 days ago. Run /redact list to review.`,
        "warning"
      );
    }

    updateStatus(config, context);
  });

  // Fail-closed: if redaction fails, block the message from reaching the LLM.
  // The user added this tool because they consider these strings sensitive.
  // Sending them unredacted on error would betray the tool's purpose.
  pi.on("input", async (event, context) => {
    try {
      const result = config.redact(event.text);

      if (result.wasRedacted) {
        context.ui.notify(
          `🔒 Redacted ${result.matchCount} occurrence(s) from your message`,
          "info"
        );
        return { action: "transform", text: result.text };
      }

      return { action: "continue" };
    } catch (error) {
      const reason = error instanceof ContractViolation
        ? error.condition
        : (error instanceof Error ? error.message : String(error));

      context.ui.notify(
        `🛑 Message blocked — redaction failed: ${reason}. ` +
        `Fix patterns with /redact list or disable with /redact off.`,
        "error"
      );

      return { action: "handled" };
    }
  });

  pi.registerCommand("redact", {
    description: "Manage redaction patterns. Run '/redact' for full usage.",
    handler: async (args, context) => {
      const parsed = parseCommand(args ?? "");

      try {
        const result = executeCommand(parsed, config);

        let configUpdatedByConfirm = false;

        await interpretEffects(result.effects, context, (newConfig) => {
          config = newConfig;
          configUpdatedByConfirm = true;
        });

        // For non-confirm commands (add, remove, enable, disable, limit),
        // result.config holds the new state so apply it.
        // For confirm-gated commands (clear), the onConfigChange callback
        // already applied the confirmed state. Overwriting with result.config
        // would revert the change, because executeCommand returns the
        // pre-confirmation config and defers the real mutation to
        // confirmedOutcome.
        if (!configUpdatedByConfirm) {
          config = result.config;
        }
      } catch (error) {
        if (error instanceof ContractViolation) {
          context.ui.notify(`Invalid input: ${error.condition}`, "error");
        } else if (error instanceof SaveFailedError) {
          // Save failed, config was not updated, state remains consistent
        } else {
          throw error;
        }
      }
    },
  });
}
