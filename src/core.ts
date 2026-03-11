/** Prevents memory exhaustion from unbounded pattern growth. */
export const MAX_PATTERNS = 100;

/** Prevents oversized regex alternations and config bloat. */
export const MAX_PATTERN_LENGTH = 1000;

/** The absolute ceiling for user-configurable pattern limits. */
export const MAX_CONFIGURABLE_LIMIT = 1000;

export class ContractViolation extends Error {
  constructor(
    public readonly type: "precondition" | "postcondition" | "invariant",
    public readonly condition: string,
    public readonly context?: string
  ) {
    super(
      `${type.toUpperCase()} VIOLATION: ${condition}${context ? ` [${context}]` : ""}`
    );
    this.name = "ContractViolation";
  }
}

export function require(
  condition: boolean,
  message: string,
  context?: string
): asserts condition {
  if (!condition) {
    throw new ContractViolation("precondition", message, context);
  }
}

export function ensure(
  condition: boolean,
  message: string,
  context?: string
): asserts condition {
  if (!condition) {
    throw new ContractViolation("postcondition", message, context);
  }
}

export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolation("invariant", message);
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class NonEmptyString {
  private constructor(private readonly value: string) {}

  static of(raw: string): NonEmptyString {
    const trimmed = raw.trim();

    require(
      trimmed.length > 0,
      "String cannot be empty or whitespace",
      "NonEmptyString.of"
    );

    return new NonEmptyString(trimmed);
  }

  get raw(): string {
    return this.value;
  }
}

export class Pattern {
  readonly createdAt: number; // Unix timestamp ms

  private constructor(
    readonly original: NonEmptyString,
    readonly replacement: NonEmptyString,
    createdAt?: number,
  ) {
    this.createdAt = createdAt ?? Date.now();
  }

  /**
   * @limitation Original strings are compared via `.toLowerCase()` without Unicode
   * normalization. Visually identical strings in different normal forms (NFC vs NFD)
   * are treated as distinct patterns and will not match each other during redaction.
   */
  static create(original: string, replacement?: string, createdAt?: number): Pattern {
    const parsedOriginal = NonEmptyString.of(original);
    const parsedReplacement =
      replacement !== undefined
        ? NonEmptyString.of(replacement)
        : NonEmptyString.of("[REDACTED]");

    require(
      parsedOriginal.raw.length <= MAX_PATTERN_LENGTH,
      `Original exceeds ${MAX_PATTERN_LENGTH} characters`,
      "Pattern.create"
    );

    require(
      parsedReplacement.raw.length <= MAX_PATTERN_LENGTH,
      `Replacement exceeds ${MAX_PATTERN_LENGTH} characters`,
      "Pattern.create"
    );

    require(
      !parsedReplacement.raw.toLowerCase().includes(parsedOriginal.raw.toLowerCase()),
      "Replacement cannot contain the original string (would cause infinite expansion)",
      "Pattern.create"
    );

    return new Pattern(parsedOriginal, parsedReplacement, createdAt);
  }

  toJSON(): { original: string; replacement: string; createdAt: number } {
    return {
      original: this.original.raw,
      replacement: this.replacement.raw,
      createdAt: this.createdAt,
    };
  }
}

export class RedactionResult {
  private constructor(
    readonly text: string,
    readonly matchCount: number,
    readonly wasRedacted: boolean
  ) {}

  static create(text: string, matchCount: number): RedactionResult {
    ensure(matchCount >= 0, "matchCount must be non-negative", "RedactionResult.create");

    const result = new RedactionResult(text, matchCount, matchCount > 0);

    ensure(
      result.wasRedacted === (result.matchCount > 0),
      "wasRedacted flag must equal (matchCount > 0)",
      "RedactionResult.create"
    );

    return result;
  }

  static unchanged(text: string): RedactionResult {
    return new RedactionResult(text, 0, false);
  }
}

export class PatternList {
  private readonly patternIndex: Map<string, Pattern>;
  // Invariant: single-threaded access assumed. The global flag makes this RegExp
  // stateful (lastIndex). It is reset before each use in redact(), but concurrent
  // calls (e.g. from Workers) would create a data race. Do not share a PatternList
  // instance across threads.
  private readonly combinedRegex: RegExp | null;
  private readonly replacementMap: Map<string, string>;

  private constructor(private readonly patterns: ReadonlyArray<Pattern>) {
    this.patternIndex = new Map(
      patterns.map((pattern) => [pattern.original.raw.toLowerCase(), pattern])
    );

    if (patterns.length === 0) {
      this.combinedRegex = null;
      this.replacementMap = new Map();
    } else {
      // Sort longest-first so "secretkey" wins over "secret" in the alternation.
      const sorted = [...patterns].sort(
        (a, b) => b.original.raw.length - a.original.raw.length
      );

      const alternation = sorted
        .map((pattern) => escapeRegex(pattern.original.raw))
        .join("|");

      this.combinedRegex = new RegExp(`(${alternation})`, "gi");
      this.replacementMap = new Map(
        patterns.map((pattern) => [pattern.original.raw.toLowerCase(), pattern.replacement.raw])
      );
    }
  }

  static createEmpty(): PatternList {
    return new PatternList([]);
  }

  /** @limitation See Pattern.create — dedup uses toLowerCase() without Unicode normalization. */
  static from(patterns: Pattern[]): PatternList {
    const seen = new Set<string>();

    for (const pattern of patterns) {
      const normalizedOriginal = pattern.original.raw.toLowerCase();

      invariant(
        !seen.has(normalizedOriginal),
        `duplicate original "${pattern.original.raw}" in PatternList`
      );

      seen.add(normalizedOriginal);
    }

    return new PatternList([...patterns]);
  }

  get length(): number {
    return this.patterns.length;
  }

  get isEmpty(): boolean {
    return this.patterns.length === 0;
  }

  has(original: string): boolean {
    return this.patternIndex.has(original.toLowerCase());
  }

  add(pattern: Pattern, maxPatterns: number = MAX_PATTERNS): PatternList {
    require(
      maxPatterns >= 1 && maxPatterns <= MAX_CONFIGURABLE_LIMIT,
      `maxPatterns must be between 1 and ${MAX_CONFIGURABLE_LIMIT}`,
      "PatternList.add"
    );

    require(
      this.patterns.length < maxPatterns,
      `Cannot exceed ${maxPatterns} patterns. Remove unused patterns first.`,
      "PatternList.add"
    );

    require(
      !this.has(pattern.original.raw),
      `Pattern "${pattern.original.raw}" already exists`,
      "PatternList.add"
    );

    const result = new PatternList([...this.patterns, pattern]);

    ensure(
      result.length === this.length + 1,
      "List must grow by exactly one after add",
      "PatternList.add"
    );

    return result;
  }

  remove(original: string): PatternList {
    const lowercaseOriginal = original.toLowerCase();
    const result = new PatternList(
      this.patterns.filter((pattern) => pattern.original.raw.toLowerCase() !== lowercaseOriginal)
    );

    ensure(
      result.length <= this.length,
      "List must not grow after remove",
      "PatternList.remove"
    );

    return result;
  }

  /**
   * Single-pass redaction using a combined alternation regex.
   * Longest match wins at any position (e.g. "secretkey" beats "secret").
   */
  redact(text: string): RedactionResult {
    require(typeof text === "string", "text must be a string", "PatternList.redact");

    if (this.isEmpty || !this.combinedRegex) {
      return RedactionResult.unchanged(text);
    }

    let matchCount = 0;

    // Global RegExp is stateful, reset before each use.
    this.combinedRegex.lastIndex = 0;

    const result = text.replace(this.combinedRegex, (match) => {
      matchCount++;
      return this.replacementMap.get(match.toLowerCase()) ?? match;
    });

    return RedactionResult.create(result, matchCount);
  }

  getStalePatterns(maxAgeDays: number): Pattern[] {
    require(maxAgeDays >= 0, "maxAgeDays must be non-negative", "PatternList.getStalePatterns");

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    return this.patterns.filter((pattern) => pattern.createdAt < cutoff);
  }

  toArray(): Pattern[] {
    return [...this.patterns];
  }

  toJSON(): Array<{ original: string; replacement: string; createdAt: number }> {
    return this.patterns.map((pattern) => pattern.toJSON());
  }
}

export type ConfigParseResult = {
  config: RedactorConfig;
  warnings: string[];
};

export class RedactorConfig {
  private constructor(
    readonly isEnabled: boolean,
    readonly patterns: PatternList,
    readonly maxPatterns: number
  ) {}

  static create(isEnabled: boolean, patterns: PatternList, maxPatterns: number = MAX_PATTERNS): RedactorConfig {
    invariant(typeof isEnabled === "boolean", "isEnabled must be boolean");

    require(
      maxPatterns >= 1 && maxPatterns <= MAX_CONFIGURABLE_LIMIT,
      `maxPatterns must be between 1 and ${MAX_CONFIGURABLE_LIMIT}`,
      "RedactorConfig.create"
    );

    return new RedactorConfig(isEnabled, patterns, maxPatterns);
  }

  static createDefault(): RedactorConfig {
    return new RedactorConfig(true, PatternList.createEmpty(), MAX_PATTERNS);
  }

  /**
   * Malformed patterns are skipped and reported in the warnings array
   * rather than silently dropped, so callers can surface them to the user.
   */
  static parseJSON(rawJson: unknown): ConfigParseResult {
    require(
      typeof rawJson === "object" && rawJson !== null,
      "Config must be a non-null object",
      "RedactorConfig.parseJSON"
    );

    const configRecord = rawJson as Record<string, unknown>;
    const isEnabled = typeof configRecord.enabled === "boolean" ? configRecord.enabled : true;
    const rawPatterns = Array.isArray(configRecord.patterns) ? configRecord.patterns : [];
    const warnings: string[] = [];

    let maxPatterns = MAX_PATTERNS;

    if (typeof configRecord.maxPatterns === "number") {
      const rawMaxPatterns = configRecord.maxPatterns;

      maxPatterns = Math.max(1, Math.min(rawMaxPatterns, MAX_CONFIGURABLE_LIMIT));

      if (maxPatterns !== rawMaxPatterns) {
        warnings.push(
          `maxPatterns value ${rawMaxPatterns} was clamped to ${maxPatterns} (valid range: 1–${MAX_CONFIGURABLE_LIMIT})`
        );
      }
    }

    const validPatterns: Pattern[] = [];

    for (let patternIndex = 0; patternIndex < rawPatterns.length; patternIndex++) {
      const rawEntry = rawPatterns[patternIndex];

      if (typeof rawEntry !== "object" || rawEntry === null) {
        warnings.push(`Pattern #${patternIndex + 1}: Invalid format (not an object)`);
        continue;
      }

      const entry = rawEntry as Record<string, unknown>;

      if (typeof entry.original !== "string" || entry.original.trim().length === 0) {
        warnings.push(`Pattern #${patternIndex + 1}: Missing or empty "original" field`);
        continue;
      }

      if (
        entry.replacement !== undefined &&
        (typeof entry.replacement !== "string" || entry.replacement.trim().length === 0)
      ) {
        warnings.push(`Pattern #${patternIndex + 1} ("${entry.original}"): Invalid "replacement" field`);
        continue;
      }

      const replacementValue =
        typeof entry.replacement === "string" ? entry.replacement : undefined;

      const createdAt =
        typeof entry.createdAt === "number" ? entry.createdAt : undefined;

      try {
        validPatterns.push(Pattern.create(entry.original, replacementValue, createdAt));
      } catch (error) {
        warnings.push(
          `Pattern #${patternIndex + 1} ("${entry.original}"): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      config: RedactorConfig.create(isEnabled, PatternList.from(validPatterns), maxPatterns),
      warnings,
    };
  }

  enable(): RedactorConfig {
    return new RedactorConfig(true, this.patterns, this.maxPatterns);
  }

  disable(): RedactorConfig {
    return new RedactorConfig(false, this.patterns, this.maxPatterns);
  }

  addPattern(pattern: Pattern): RedactorConfig {
    const newPatterns = this.patterns.add(pattern, this.maxPatterns);
    const result = new RedactorConfig(this.isEnabled, newPatterns, this.maxPatterns);

    ensure(
      result.patterns.length === this.patterns.length + 1,
      "Pattern count must increase by one",
      "RedactorConfig.addPattern"
    );

    return result;
  }

  removePattern(original: string): RedactorConfig {
    return new RedactorConfig(this.isEnabled, this.patterns.remove(original), this.maxPatterns);
  }

  clearPatterns(): RedactorConfig {
    return new RedactorConfig(this.isEnabled, PatternList.createEmpty(), this.maxPatterns);
  }

  setMaxPatterns(newLimit: number): RedactorConfig {
    require(
      newLimit >= 1 && newLimit <= MAX_CONFIGURABLE_LIMIT,
      `maxPatterns must be between 1 and ${MAX_CONFIGURABLE_LIMIT}`,
      "RedactorConfig.setMaxPatterns"
    );

    require(
      newLimit >= this.patterns.length,
      `Cannot set limit below current pattern count (${this.patterns.length})`,
      "RedactorConfig.setMaxPatterns"
    );

    return new RedactorConfig(this.isEnabled, this.patterns, newLimit);
  }

  redact(text: string): RedactionResult {
    if (!this.isEnabled || this.patterns.isEmpty) {
      return RedactionResult.unchanged(text);
    }

    return this.patterns.redact(text);
  }

  toJSON(): {
    enabled: boolean;
    maxPatterns: number;
    patterns: Array<{ original: string; replacement: string; createdAt: number }>;
  } {
    return { enabled: this.isEnabled, maxPatterns: this.maxPatterns, patterns: this.patterns.toJSON() };
  }
}

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

/**
 * The `confirm` effect embeds a full CommandResult in `confirmedOutcome`,
 * enabling the shell to apply the deferred state change and its
 * downstream effects atomically upon user acceptance.
 */
export type Effect =
  | { type: "notify"; message: string; level: "info" | "success" | "warning" | "error" }
  | { type: "confirm"; title: string; message: string; confirmedOutcome: CommandResult }
  | { type: "save"; config: RedactorConfig }
  | { type: "updateStatus"; config: RedactorConfig };

export interface CommandResult {
  config: RedactorConfig;
  effects: Effect[];
}

const HELP_TEXT = [
  "Redactor — redact sensitive strings from your messages before the LLM sees them.",
  "",
  "  /redact add <string>             Replace <string> with [REDACTED]",
  "  /redact add <string> as <label>  Replace <string> with a custom <label>",
  "  /redact remove <string>          Remove a pattern by its original string",
  "  /redact list                     Show all active patterns",
  "  /redact clear                    Remove all patterns (asks confirmation)",
  "  /redact on                       Enable redaction",
  "  /redact off                      Disable redaction",
  "  /redact limit <n>                Set max pattern count (default 100, max 1000)",
  "",
  `Limit: ${MAX_PATTERNS} by default (configurable up to ${MAX_CONFIGURABLE_LIMIT} via /redact limit <n>).`,
  "",
  "Tip: 'as' is the delimiter between original and label.",
  "     The LAST occurrence of ' as ' splits the two parts, so:",
  "     '/redact add John Smith as CEO as [PERSON]' redacts 'John Smith as CEO'.",
].join("\n");

export function parseCommand(args: string): ParsedCommand {
  const parts = args.trim().split(/\s+/);
  const action = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1).join(" ");

  switch (action) {
    case "add": {
      if (!rest) {
        return {
          type: "invalid",
          reason: "Usage: /redact add <string> [as <label>]",
        };
      }

      // Use the LAST ' as ' so originals containing ' as ' are handled correctly.
      const lastAsIndex = rest.lastIndexOf(" as ");

      if (lastAsIndex !== -1) {
        return {
          type: "add",
          original: rest.slice(0, lastAsIndex).trim(),
          replacement: rest.slice(lastAsIndex + 4).trim(),
        };
      }

      return { type: "add", original: rest.trim(), replacement: undefined };
    }

    case "remove": {
      if (!rest) {
        return { type: "invalid", reason: "Usage: /redact remove <string>" };
      }

      return { type: "remove", original: rest.trim() };
    }

    case "list":  return { type: "list" };
    case "clear": return { type: "clear" };
    case "on":    return { type: "enable" };
    case "off":   return { type: "disable" };
    case "limit": {
      const value = parseInt(rest, 10);

      if (!rest || isNaN(value)) {
        return { type: "invalid", reason: "Usage: /redact limit <number>" };
      }

      return { type: "limit", value };
    }
    default:      return { type: "help" };
  }
}

export function executeCommand(
  command: ParsedCommand,
  config: RedactorConfig
): CommandResult {
  switch (command.type) {
    case "add": {
      require(
        command.original.trim().length > 0,
        "add requires a non-empty original string",
        "executeCommand:add"
      );

      if (config.patterns.has(command.original)) {
        return {
          config,
          effects: [
            {
              type: "notify",
              message: `Pattern "${command.original}" already exists`,
              level: "warning",
            },
          ],
        };
      }

      const pattern = Pattern.create(command.original, command.replacement);
      const newConfig = config.addPattern(pattern);

      return {
        config: newConfig,
        effects: [
          { type: "save", config: newConfig },
          {
            type: "notify",
            message: `Added: "${pattern.original.raw}" → ${pattern.replacement.raw}`,
            level: "success",
          },
          { type: "updateStatus", config: newConfig },
        ],
      };
    }

    case "remove": {
      if (!config.patterns.has(command.original)) {
        return {
          config,
          effects: [
            {
              type: "notify",
              message: `Pattern "${command.original}" not found`,
              level: "warning",
            },
          ],
        };
      }

      const newConfig = config.removePattern(command.original);

      return {
        config: newConfig,
        effects: [
          { type: "save", config: newConfig },
          {
            type: "notify",
            message: `Removed: "${command.original}"`,
            level: "success",
          },
          { type: "updateStatus", config: newConfig },
        ],
      };
    }

    // @security: This command echoes raw original strings to the local UI via
    // notify(). These are the sensitive values the user is redacting. If the
    // notify channel is ever routed into the LLM conversation context, this
    // would leak the secrets. Verify that notify() is local-only before changing
    // its routing.
    case "list": {
      if (config.patterns.isEmpty) {
        return {
          config,
          effects: [
            {
              type: "notify",
              message: "No redaction patterns configured. Use /redact add <string> to add one.",
              level: "info",
            },
          ],
        };
      }

      const lines = config.patterns
        .toArray()
        .map((pattern, index) =>
          `  ${index + 1}. "${pattern.original.raw}" → ${pattern.replacement.raw}`
        )
        .join("\n");

      return {
        config,
        effects: [
          {
            type: "notify",
            message: `Active redaction patterns:\n${lines}`,
            level: "info",
          },
        ],
      };
    }

    case "clear": {
      if (config.patterns.isEmpty) {
        return {
          config,
          effects: [
            { type: "notify", message: "No patterns to clear.", level: "info" },
          ],
        };
      }

      const clearedConfig = config.clearPatterns();

      return {
        config,
        effects: [
          {
            type: "confirm",
            title: "Clear All Patterns",
            message: `Remove all ${config.patterns.length} redaction pattern(s)? This cannot be undone.`,
            confirmedOutcome: {
              config: clearedConfig,
              effects: [
                {
                  type: "notify",
                  message: "All redaction patterns cleared.",
                  level: "success",
                },
                { type: "save", config: clearedConfig },
                { type: "updateStatus", config: clearedConfig },
              ],
            },
          },
        ],
      };
    }

    case "enable": {
      if (config.isEnabled) {
        return {
          config,
          effects: [
            {
              type: "notify",
              message: "Redactor is already enabled.",
              level: "info",
            },
          ],
        };
      }

      const newConfig = config.enable();

      return {
        config: newConfig,
        effects: [
          { type: "save", config: newConfig },
          { type: "notify", message: "Redactor enabled.", level: "success" },
          { type: "updateStatus", config: newConfig },
        ],
      };
    }

    case "disable": {
      if (!config.isEnabled) {
        return {
          config,
          effects: [
            {
              type: "notify",
              message: "Redactor is already disabled.",
              level: "info",
            },
          ],
        };
      }

      const newConfig = config.disable();

      return {
        config: newConfig,
        effects: [
          { type: "save", config: newConfig },
          { type: "notify", message: "Redactor disabled.", level: "warning" },
          { type: "updateStatus", config: newConfig },
        ],
      };
    }

    case "limit": {
      if (command.value === config.maxPatterns) {
        return {
          config,
          effects: [
            { type: "notify", message: `Pattern limit is already ${config.maxPatterns}.`, level: "info" },
          ],
        };
      }

      try {
        const newConfig = config.setMaxPatterns(command.value);

        const effects: Effect[] = [
          { type: "save", config: newConfig },
          { type: "notify", message: `Pattern limit updated: ${config.maxPatterns} → ${command.value}`, level: "success" },
          { type: "updateStatus", config: newConfig },
        ];

        if (command.value > MAX_PATTERNS) {
          effects.unshift({
            type: "notify",
            message: `⚠️ Limits above ${MAX_PATTERNS} may increase regex compilation time. This is an advanced setting.`,
            level: "warning",
          });
        }

        return { config: newConfig, effects };
      } catch (error) {
        return {
          config,
          effects: [
            {
              type: "notify",
              message: error instanceof ContractViolation ? error.condition : String(error),
              level: "error",
            },
          ],
        };
      }
    }

    case "help": {
      return {
        config,
        effects: [{ type: "notify", message: HELP_TEXT, level: "info" }],
      };
    }

    case "invalid": {
      return {
        config,
        effects: [
          {
            type: "notify",
            message: `${command.reason}\n\nRun /redact for full usage.`,
            level: "warning",
          },
        ],
      };
    }
  }
}
