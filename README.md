# pi-redactor

Pi extension that redacts sensitive strings from user input, tool results, and context before the LLM sees them.

## Installation

```bash
pi install npm:pi-redactor
```

Or from a local path:

```bash
pi install /path/to/pi-redactor
```

## How It Works

The extension intercepts messages at three points:

1. **`input`** — rewrites your message before it reaches the LLM.
2. **`tool_result`** — redacts tool output (file reads, command output, etc.) before it enters the conversation.
3. **`context`** — scans the full message history immediately before each LLM call, catching secrets in historical context, assistant echoes, or custom messages.

All configured patterns are applied using a single-pass regex with longest-match-first semantics. The transformed text is sent instead of the original.

The LLM never sees the original sensitive strings.

If redaction fails at runtime (e.g., a malformed pattern), the extension **fails closed**: user messages are blocked, tool results are replaced with an error, and context is emptied. An error notification is displayed in each case. Disable the redactor with `/redact off` to bypass.

## Commands

| Command | Description |
|---------|-------------|
| `/redact` | Show help and usage |
| `/redact add <string>` | Add pattern; replaces with `[REDACTED]` |
| `/redact add <string> as <label>` | Add pattern with custom replacement label |
| `/redact remove <string>` | Remove pattern by its original string |
| `/redact list` | Show all active patterns |
| `/redact clear` | Remove all patterns (prompts for confirmation) |
| `/redact on` | Enable redaction |
| `/redact off` | Disable redaction |
| `/redact limit <n>` | Set max pattern count (default 100, max 1000) |

### Parsing Rule

The delimiter ` as ` splits original from label. The **last** occurrence of ` as ` is used, so:

```
/redact add John Smith as CEO as [PERSON]
```

Redacts `John Smith as CEO` → `[PERSON]`.

## Example

```
/redact add John Smith as [CLIENT]
/redact add acct_12345
```

Input: `"Contact John Smith about acct_12345."`

LLM receives: `"Contact [CLIENT] about [REDACTED]."`

Notification: `🔒 Redacted 2 occurrence(s) from your message`

## Behavior

- **Case-insensitive:** `john smith` matches `John Smith`.
- **Longest match wins:** If both `secret` and `secretkey` are patterns, the input `secretkey` matches the longer pattern. Patterns do not apply sequentially.
- **Match order is deterministic:** Results are identical regardless of the order patterns were added.
- **Fail-closed on error:** If redaction fails, the content is blocked — it never reaches the LLM unredacted. User messages return `handled`, tool results are replaced with an error, and context is emptied.
- **Disabled on degraded config:** If the config file is corrupted or patterns could not be loaded, the redactor starts disabled. Run `/redact list` to review, then `/redact on` to re-enable.
- **Default limit: 100 patterns.** Configurable up to 1000 via `/redact limit <n>`. Adding a pattern beyond the current limit produces an error.
- **Maximum 1000 characters** per pattern (original and replacement).
- **Stale pattern warnings.** At session start, a warning is shown if any patterns were added more than 90 days ago.

## Status Bar

| State | Display |
|-------|---------|
| Enabled, N patterns (N > 0) | `🔒 Redactor: N pattern(s)` |
| Enabled, 0 patterns | `🔒 Redactor: no patterns` |
| Disabled | `🔓 Redactor: off` |

## Configuration

Patterns persist to a platform-specific state directory that is outside of typical version-controlled dotfile paths:

| Platform | Path |
|----------|------|
| Linux | `~/.local/state/pi-redactor/config.json` |
| macOS | `~/.local/state/pi-redactor/config.json` |
| Windows | `%LOCALAPPDATA%\pi-redactor\config.json` |

The `XDG_STATE_HOME` environment variable is respected on Linux/macOS. On Windows, `LOCALAPPDATA` is used.

### On-Disk Format

The file uses an envelope format with integrity checking:

```json
{
  "version": 1,
  "configVersion": 3,
  "checksum": "<sha256-hex-of-serialized-data>",
  "data": {
    "enabled": true,
    "maxPatterns": 100,
    "patterns": [
      {
        "original": "John Smith",
        "replacement": "[CLIENT]",
        "createdAt": 1710000000000
      }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `version` | Envelope schema version. Currently `1`. |
| `configVersion` | Monotonically incrementing counter for concurrency control. |
| `checksum` | SHA-256 hex digest of `JSON.stringify(data)`. Used for tamper detection. |
| `data.enabled` | Whether redaction is active. |
| `data.maxPatterns` | Maximum number of patterns allowed. Default `100`, max `1000`. |
| `data.patterns[].original` | The original string to redact. |
| `data.patterns[].replacement` | The replacement label. |
| `data.patterns[].createdAt` | Unix timestamp in milliseconds when the pattern was added. |

### Integrity and Concurrency

- **Checksum verification.** On load, the checksum is recomputed and compared. A mismatch triggers a tamper warning and disables the redactor until the user reviews.
- **Optimistic concurrency control.** Each save increments `configVersion`. If another pi session modified the file since this session last read it, the save fails with an error instructing the user to reload.
- **Atomic writes.** Saves write to a temporary file and rename, preventing corruption from interrupted writes.
- **Degraded config recovery.** If the config file is corrupted, unreadable, or has dropped patterns, the extension starts with the redactor disabled and displays a warning. The user must explicitly re-enable after reviewing.

## Limitations

- No expiration or automatic cleanup of stored patterns.
- Performance may degrade as pattern count approaches the 1000 ceiling due to regex alternation size. Untested above 50 patterns at maximum character length.
- `/redact list` displays the raw original strings in the local UI. These are the sensitive values being redacted. Do not use this command where the terminal output may be captured or shared.
- Pattern matching uses `toLowerCase()` without Unicode normalization. Visually identical strings in different normal forms (NFC vs NFD) are treated as distinct patterns (e.g., `é` as U+00E9 vs U+0065 U+0301).
- **Signed thinking blocks are not redacted.** The `context` handler scans unsigned thinking blocks, but blocks with a `thinkingSignature` are passed through unchanged. Modifying the thinking text would invalidate the cryptographic signature used by LLM providers for multi-turn thought chain continuity. Secrets that appeared in signed thinking blocks (from turns before a redaction pattern was configured) will persist in the conversation context.
- **Redacted thinking blocks are opaque.** Blocks with `redacted: true` are encrypted payloads with no meaningful text to scan.
- **ToolCall arguments are not redacted.** The `context` handler does not scan `type: "toolCall"` block arguments. The corresponding `ToolResultMessage` content is redacted.
- **TOCTOU window in config saves.** Concurrent saves within milliseconds from separate processes can silently overwrite each other. This is bounded by the single-process Pi event model and is not expected to occur in normal usage.

## Development Disclosure

This package was developed predominantly using an AI coding agent.
All code, tests, and documentation were reviewed, validated, and approved by me.

## License

MIT
