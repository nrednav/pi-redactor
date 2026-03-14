# AGENTS.md — pi-redactor

Pi extension that redacts sensitive strings from user input, tool results, and context before the LLM sees them.

## Setup / Environment

- **Runtime:** Node.js 20+, ESM (`"type": "module"` in `package.json`)
- **Language:** TypeScript (strict)
- **Package manager:** npm
- **Install deps:** `npm install`
- **Peer dependency:** `@mariozechner/pi-coding-agent` (Pi SDK)

## Commands

```bash
npm test            # vitest run — full suite, single pass
npm run test:watch  # vitest — watch mode
```

No build step. Pi loads `./src/index.ts` directly via the `pi.extensions` field.

## Architecture — Functional Core / Imperative Shell

| File | Role | Rules |
|------|------|-------|
| `src/core.ts` | **Functional Core** — pure logic, zero I/O | NO imports of `node:fs`, `node:os`, `node:path`, `node:net`, `node:child_process`, Pi SDK. NO `process.env`, `process.cwd`, `process.exit`, `console.*`, `setTimeout`, `fetch`. |
| `src/shell.ts` | **Imperative Shell** — file I/O, platform paths, effect interpreter | Allowed to import Node built-ins and Pi SDK types. Imports from `./core`. |
| `src/index.ts` | **Extension entry point** — wires events to core + shell | Registers Pi event handlers (`session_start`, `input`, `tool_result`, `context`) and the `/redact` command. |

Architectural boundary is enforced by `test/integrity.test.ts`. Do not violate it.

## Code Style

- **Immutable value objects.** `Pattern`, `PatternList`, `RedactorConfig` return new instances on mutation. Never mutate in place.
- **Design by Contract.** Use `require()` for preconditions, `ensure()` for postconditions, `invariant()` for class invariants. All throw `ContractViolation`.
- **Effect system.** Commands in `core.ts` return `CommandResult = { config, effects: Effect[] }`. The shell interprets effects. Commands never perform I/O directly.
- **Type imports.** Use `import type` for interfaces/types that are not used at runtime:
  ```ts
  import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
  ```
- **No abbreviations.** Use `patternIndex` not `pIdx`, `redactedText` not `rTxt`.
- **Explicit error classes.** `ContractViolation`, `SaveFailedError`, `EffectError`. Do not throw bare `Error` for domain conditions.

### Naming Conventions

```ts
// Classes: PascalCase
class PatternList { }

// Methods/functions: camelCase
function parseCommand(args: string): ParsedCommand { }

// Constants: UPPER_SNAKE_CASE
export const MAX_PATTERNS = 100;

// Type aliases / discriminated unions: PascalCase
export type ParsedCommand =
  | { type: "add"; original: string; replacement: string | undefined }
  | { type: "remove"; original: string }
  | { type: "list" }
  | { type: "clear" }
  | { type: "enable" }
  | { type: "disable" }
  | { type: "limit"; value: number }
  | { type: "help" }
  | { type: "invalid"; reason: string };
```

## Testing

| Test file | Covers | Notes |
|-----------|--------|-------|
| `test/core.test.ts` | Pure logic: `Pattern`, `PatternList`, `RedactorConfig`, `parseCommand`, `executeCommand` | Property-based tests via `@fast-check/vitest`. No mocks. |
| `test/shell.test.ts` | I/O: `loadConfig`, `saveConfig`, `interpretEffects`, concurrency, checksums | Mocks `node:fs/promises` via `vi.mock`. |
| `test/integrity.test.ts` | Architectural boundary enforcement + real filesystem round-trip for tamper detection | Reads source files as strings to assert import constraints. Uses real `CONFIG_PATH` for integration. |

- Every new pure-logic function in `core.ts` must have tests in `core.test.ts`.
- Every new I/O path in `shell.ts` must have tests in `shell.test.ts` with mocked fs.
- Property-based tests use `test.prop([...arbitraries])` from `@fast-check/vitest`.

## Project Structure

```
pi-redactor/
├── src/
│   ├── core.ts          # Pure domain logic (patterns, config, commands)
│   ├── shell.ts         # I/O (load/save config, effect interpreter)
│   └── index.ts         # Pi extension entry point
├── test/
│   ├── core.test.ts     # Unit + property-based tests for core
│   ├── shell.test.ts    # Mocked I/O tests for shell
│   └── integrity.test.ts# Boundary enforcement + real fs integration
├── package.json
├── config.json          # Tracked by mistake — gitignored, do not modify
└── AGENTS.md
```

**Config at runtime** is stored at `~/.local/state/pi-redactor/config.json` (Linux/macOS) or `%LOCALAPPDATA%\pi-redactor\config.json` (Windows). Resolved by `CONFIG_PATH` in `shell.ts`.

## Key Invariants

- **Fail-closed.** If redaction throws, the content is blocked — never sent unredacted. User messages return `"handled"`, tool results are replaced with an error, and context is emptied.
- **Single-pass regex.** `PatternList.redact()` uses one combined alternation. Longest match wins. Results are insertion-order-independent.
- **Atomic writes.** `saveConfig` writes to `.tmp` then renames.
- **Optimistic concurrency.** `configVersion` counter detects cross-session conflicts.
- **SHA-256 checksum.** Tamper detection on `data` payload in the envelope.
- **Default 100 patterns (configurable up to MAX_CONFIGURABLE_LIMIT = 1000), max 1000 chars each.**
- **No Unicode normalization.** Pattern comparison and dedup use `.toLowerCase()` without `.normalize()`. NFC and NFD forms of the same string are treated as distinct.

## Boundaries

### Always Do

- Always run `npm test` and confirm all tests pass before proposing changes.
- Always preserve the Functional Core / Imperative Shell boundary.
- Always use `require()` / `ensure()` / `invariant()` for contract assertions in `core.ts`.
- Always return new instances from mutation methods to keep value objects immutable.
- Always add tests for every new function or behavior change.

### Ask First

- Ask before changing the config envelope schema (`version`, `configVersion`, `checksum`).
- Ask before modifying `MAX_PATTERNS`, `MAX_PATTERN_LENGTH`, or `MAX_CONFIGURABLE_LIMIT` constants.
- Ask before adding new Pi event handlers or commands in `index.ts`.
- Ask before adding new dependencies to `package.json`.

### Never Do

- Never add I/O imports (`node:fs`, `node:os`, `node:path`, `node:net`, `fetch`) to `core.ts`.
- Never use `process.env`, `process.cwd`, `process.exit`, or `console.*` in `core.ts`.
- Never hardcode secrets, tokens, API keys, or credentials anywhere.
- Never mutate `Pattern`, `PatternList`, or `RedactorConfig` instances in place.
- Never delete or weaken tests in `test/integrity.test.ts`.
- Never commit `config.json` or `.env` files to version control.
- Never bypass the effect system — commands must not perform I/O directly.
- Never route `notify()` effects into the LLM conversation context. The `list` command echoes the secrets being redacted as raw original strings.
