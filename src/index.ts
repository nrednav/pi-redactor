import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  ContractViolation,
  RedactorConfig,
  executeCommand,
  parseCommand,
  type ContentBlock,
} from "./core";
import { interpretEffects, loadConfig, updateStatus, SaveFailedError } from "./shell";

function extractErrorReason(error: unknown): string {
  return error instanceof ContractViolation
    ? error.condition
    : (error instanceof Error ? error.message : String(error));
}

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
      const reason = extractErrorReason(error);

      context.ui.notify(
        `🛑 Message blocked — redaction failed: ${reason}. ` +
        `Fix patterns with /redact list or disable with /redact off.`,
        "error"
      );

      return { action: "handled" };
    }
  });

  // Redact tool results (file reads, command output, etc.) before they enter
  // the LLM context. Fail-closed: if redaction throws, replace the result
  // with an error to prevent leaking raw content.
  pi.on("tool_result", async (event, context) => {
    try {
      const result = config.redactContent(event.content as ContentBlock[]);

      if (result.wasRedacted) {
        context.ui.notify(
          `🔒 Redacted ${result.totalMatchCount} occurrence(s) from ${event.toolName} result`,
          "info"
        );
        return { content: result.content as typeof event.content };
      }

      return undefined; // no changes needed
    } catch (error) {
      const reason = extractErrorReason(error);

      context.ui.notify(
        `🛑 Tool result blocked — redaction failed: ${reason}. ` +
        `Fix patterns with /redact list or disable with /redact off.`,
        "error"
      );

      return {
        content: [{ type: "text" as const, text: "[REDACTED — internal redaction error]" }],
        isError: true,
      };
    }
  });

  // Redact all messages before each LLM call.
  // Catches secrets in historical context, custom messages, or assistant echoes.
  pi.on("context", async (event, context) => {
    if (!config.isEnabled || config.patterns.isEmpty) {
      return undefined;
    }

    try {
      let totalRedacted = 0;

      const messages = event.messages;

      for (const message of messages) {
        if (!("role" in message)) {
          continue;
        }

        // Handle string content (UserMessage, CustomMessage)
        if ("content" in message && typeof message.content === "string") {
          const result = config.redact(message.content);

          if (result.wasRedacted) {
            (message as any).content = result.text;
            totalRedacted += result.matchCount;
          }

          continue;
        }

        // Handle array content (UserMessage, AssistantMessage, ToolResultMessage, CustomMessage)
        if ("content" in message && Array.isArray(message.content)) {
          const result = config.redactContent(message.content as ContentBlock[]);

          if (result.wasRedacted) {
            (message as any).content = result.content;
            totalRedacted += result.totalMatchCount;
          }

          // Redact unsigned thinking blocks in assistant messages.
          //
          // @limitation Signed blocks (thinkingSignature present) are left
          // unaffected because modifying the thinking text would invalidate the
          // provider's cryptographic signature for multi-turn continuity.
          // Secrets in signed thinking blocks from turns before a pattern was
          // configured will persist in context.
          //
          // @limitation Redacted blocks (redacted: true) are opaque encrypted
          // payloads with no meaningful thinking text to scan.
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (
              block.type === "thinking" &&
              typeof block.thinking === "string" &&
              !block.thinkingSignature &&
              !block.redacted
            ) {
              const thinkingResult = config.redact(block.thinking as string);

              if (thinkingResult.wasRedacted) {
                block.thinking = thinkingResult.text;
                totalRedacted += thinkingResult.matchCount;
              }
            }
          }
        }
      }

      if (totalRedacted > 0) {
        context.ui.notify(
          `🔒 Redacted ${totalRedacted} occurrence(s) from conversation context`,
          "info"
        );

        return { messages };
      }

      return undefined;
    } catch (error) {
      const reason = extractErrorReason(error);

      context.ui.notify(
        `🛑 Context redaction failed: ${reason}. Blocking LLM call. ` +
        `Fix patterns with /redact list or disable with /redact off.`,
        "error"
      );

      // Fail-closed: return empty messages to prevent sending unredacted context.
      return { messages: [] };
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
          // Save failed, config was not updated, state remains consistent.
          // For confirm-gated commands (e.g. clear), onConfigChange is deferred
          // until after save succeeds, so this invariant holds in all paths.
        } else {
          throw error;
        }
      }
    },
  });
}
