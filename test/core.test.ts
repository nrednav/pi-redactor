import { describe, it, expect } from "vitest";
import { test, fc } from "@fast-check/vitest";
import {
  Pattern,
  PatternList,
  RedactorConfig,
  RedactionResult,
  ContractViolation,
  NonEmptyString,
  parseCommand,
  executeCommand,
  MAX_PATTERNS,
  MAX_PATTERN_LENGTH,
  MAX_CONFIGURABLE_LIMIT,
  type ConfigParseResult,
} from "../src/core";

describe("NonEmptyString", () => {
  describe("of()", () => {
    it("creates from valid string and exposes raw value", () => {
      const nonEmptyString = NonEmptyString.of("hello");
      expect(nonEmptyString.raw).toBe("hello");
    });

    it("trims surrounding whitespace", () => {
      const nonEmptyString = NonEmptyString.of("  hi  ");
      expect(nonEmptyString.raw).toBe("hi");
    });

    it("throws ContractViolation for empty string", () => {
      expect(() => NonEmptyString.of("")).toThrow(ContractViolation);
    });

    it("throws ContractViolation for whitespace-only string", () => {
      expect(() => NonEmptyString.of("   ")).toThrow(ContractViolation);
    });
  });

});

describe("Pattern", () => {
  describe("create()", () => {
    it("creates valid pattern with default replacement", () => {
      const pattern = Pattern.create("secret");

      expect(pattern.original.raw).toBe("secret");
      expect(pattern.replacement.raw).toBe("[REDACTED]");
    });

    it("creates valid pattern with custom replacement", () => {
      const pattern = Pattern.create("John Smith", "[CLIENT]");

      expect(pattern.original.raw).toBe("John Smith");
      expect(pattern.replacement.raw).toBe("[CLIENT]");
    });

    it("throws ContractViolation when replacement contains original", () => {
      expect(() => Pattern.create("ABC", "XABC")).toThrow(ContractViolation);

      try {
        Pattern.create("ABC", "XABC");
      } catch (error) {
        expect(error).toBeInstanceOf(ContractViolation);
        expect((error as ContractViolation).type).toBe("precondition");
      }
    });

    it("throws ContractViolation for case-insensitive overlap", () => {
      expect(() => Pattern.create("abc", "XAbCy")).toThrow(ContractViolation);
      expect(() => Pattern.create("ABC", "xabcz")).toThrow(ContractViolation);
    });

    it("throws ContractViolation for empty original", () => {
      expect(() => Pattern.create("")).toThrow(ContractViolation);
      expect(() => Pattern.create("   ")).toThrow(ContractViolation);
    });

    it("throws ContractViolation for empty replacement", () => {
      expect(() => Pattern.create("secret", "")).toThrow(ContractViolation);
      expect(() => Pattern.create("secret", "   ")).toThrow(ContractViolation);
    });

    it("trims whitespace from original and replacement", () => {
      const pattern = Pattern.create("  secret  ", "  [REDACTED]  ");

      expect(pattern.original.raw).toBe("secret");
      expect(pattern.replacement.raw).toBe("[REDACTED]");
    });

    it("accepts original at exactly MAX_PATTERN_LENGTH", () => {
      const original = "x".repeat(MAX_PATTERN_LENGTH);
      const pattern = Pattern.create(original, "[X]");

      expect(pattern.original.raw.length).toBe(MAX_PATTERN_LENGTH);
    });

    it("throws ContractViolation when original exceeds MAX_PATTERN_LENGTH", () => {
      const original = "x".repeat(MAX_PATTERN_LENGTH + 1);
      expect(() => Pattern.create(original, "[X]")).toThrow(ContractViolation);
    });

    it("throws ContractViolation when replacement exceeds MAX_PATTERN_LENGTH", () => {
      const replacement = "[" + "X".repeat(MAX_PATTERN_LENGTH) + "]";
      expect(() => Pattern.create("secret", replacement)).toThrow(ContractViolation);
    });
  });

  describe("toJSON()", () => {
    it("serializes to plain object", () => {
      const pattern = Pattern.create("secret", "[REDACTED]");
      const json = pattern.toJSON();

      expect(json).toEqual(
        expect.objectContaining({ original: "secret", replacement: "[REDACTED]" })
      );
      expect(typeof json.createdAt).toBe("number");
    });
  });

  describe("createdAt timestamp", () => {
    it("Pattern stores createdAt timestamp", () => {
      const before = Date.now();
      const pattern = Pattern.create("test", "[X]");
      const after = Date.now();

      expect(pattern.createdAt).toBeGreaterThanOrEqual(before);
      expect(pattern.createdAt).toBeLessThanOrEqual(after);
    });

    it("accepts explicit createdAt value", () => {
      const timestamp = 1_000_000;
      const pattern = Pattern.create("test", "[X]", timestamp);

      expect(pattern.createdAt).toBe(timestamp);
    });
  });

});

describe("PatternList", () => {
  describe("empty()", () => {
    it("creates empty list", () => {
      const list = PatternList.createEmpty();

      expect(list.length).toBe(0);
      expect(list.isEmpty).toBe(true);
    });
  });

  describe("add()", () => {
    it("adds pattern to empty list", () => {
      const list = PatternList.createEmpty();
      const pattern = Pattern.create("secret", "[HIDDEN]");
      const newList = list.add(pattern);

      expect(newList.length).toBe(1);
      expect(newList.has("secret")).toBe(true);
    });

    it("adds multiple patterns", () => {
      let list = PatternList.createEmpty();
      list = list.add(Pattern.create("one", "[1]"));
      list = list.add(Pattern.create("two", "[2]"));
      list = list.add(Pattern.create("three", "[3]"));

      expect(list.length).toBe(3);
    });

    it("throws when adding duplicate original", () => {
      const list = PatternList.createEmpty().add(Pattern.create("secret", "[HIDDEN]"));

      expect(() => list.add(Pattern.create("secret", "[OTHER]"))).toThrow(
        ContractViolation
      );
    });

    it("throws for case-insensitive duplicate", () => {
      const list = PatternList.createEmpty().add(Pattern.create("SECRET", "[HIDDEN]"));

      expect(() => list.add(Pattern.create("secret", "[OTHER]"))).toThrow(
        ContractViolation
      );
    });

    it("returns new list (immutable)", () => {
      const list1 = PatternList.createEmpty();
      const list2 = list1.add(Pattern.create("secret", "[HIDDEN]"));

      expect(list1.length).toBe(0);
      expect(list2.length).toBe(1);
    });

    it("throws when exceeding MAX_PATTERNS limit", () => {
      let list = PatternList.createEmpty();

      for (let patternIndex = 0; patternIndex < MAX_PATTERNS; patternIndex++) {
        list = list.add(Pattern.create(`pattern${patternIndex}`, `[R${patternIndex}]`));
      }

      expect(() => list.add(Pattern.create("overflow", "[X]"))).toThrow(ContractViolation);
    });

    it("respects custom maxPatterns limit", () => {
      let list = PatternList.createEmpty();

      for (let i = 0; i < 5; i++) {
        list = list.add(Pattern.create(`pattern${i}`, `[R${i}]`));
      }

      expect(() => list.add(Pattern.create("sixth", "[R5]"), 5)).toThrow(ContractViolation);
    });

    it("allows adding beyond default when custom maxPatterns is higher", () => {
      let list = PatternList.createEmpty();

      for (let i = 0; i < MAX_PATTERNS; i++) {
        list = list.add(Pattern.create(`pattern${i}`, `[R${i}]`));
      }

      const extended = list.add(Pattern.create("overflow", "[X]"), 200);

      expect(extended.length).toBe(MAX_PATTERNS + 1);
    });

    it("rejects maxPatterns above MAX_CONFIGURABLE_LIMIT", () => {
      const list = PatternList.createEmpty();
      const pattern = Pattern.create("test", "[T]");
      expect(() => list.add(pattern, MAX_CONFIGURABLE_LIMIT + 1)).toThrow(ContractViolation);
    });

    it("rejects maxPatterns below 1", () => {
      const list = PatternList.createEmpty();
      const pattern = Pattern.create("test", "[T]");
      expect(() => list.add(pattern, 0)).toThrow(ContractViolation);
    });
  });

  describe("remove()", () => {
    it("removes existing pattern", () => {
      const list = PatternList.createEmpty()
        .add(Pattern.create("one", "[1]"))
        .add(Pattern.create("two", "[2]"));

      const removed = list.remove("one");

      expect(removed.length).toBe(1);
      expect(removed.has("one")).toBe(false);
      expect(removed.has("two")).toBe(true);
    });

    it("removes case-insensitively", () => {
      const list = PatternList.createEmpty().add(Pattern.create("SECRET", "[HIDDEN]"));

      const removed = list.remove("secret");

      expect(removed.has("SECRET")).toBe(false);
      expect(removed.length).toBe(0);
    });

    it("returns unchanged list if not found", () => {
      const list = PatternList.createEmpty().add(Pattern.create("one", "[FIRST]"));

      const removed = list.remove("nonexistent");

      expect(removed.length).toBe(1);
    });
  });

  describe("has()", () => {
    it("finds pattern case-insensitively", () => {
      const list = PatternList.createEmpty().add(Pattern.create("Secret", "[HIDDEN]"));

      expect(list.has("Secret")).toBe(true);
      expect(list.has("SECRET")).toBe(true);
      expect(list.has("secret")).toBe(true);
      expect(list.has("other")).toBe(false);
    });
  });

  describe("from()", () => {
    it("builds a PatternList from an array of patterns", () => {
      const patterns = [
        Pattern.create("alpha", "[A]"),
        Pattern.create("beta", "[B]"),
      ];

      const list = PatternList.from(patterns);

      expect(list.length).toBe(2);
      expect(list.has("alpha")).toBe(true);
      expect(list.has("beta")).toBe(true);
    });

    it("throws ContractViolation for duplicate originals (case-insensitive)", () => {
      const patterns = [
        Pattern.create("dup", "[A]"),
        Pattern.create("DUP", "[B]"),
      ];

      expect(() => PatternList.from(patterns)).toThrow(ContractViolation);
    });

    it("builds empty list from empty array", () => {
      const list = PatternList.from([]);
      expect(list.isEmpty).toBe(true);
    });
  });

  describe("redact()", () => {
    it("applies patterns sequentially", () => {
      const list = PatternList.createEmpty()
        .add(Pattern.create("foo", "[F]"))
        .add(Pattern.create("bar", "[B]"));

      const result = list.redact("foo and bar together");

      expect(result.text).toBe("[F] and [B] together");
      expect(result.matchCount).toBe(2);
      expect(result.wasRedacted).toBe(true);
    });

    it("returns unchanged for empty list", () => {
      const list = PatternList.createEmpty();
      const result = list.redact("hello world");

      expect(result.text).toBe("hello world");
      expect(result.matchCount).toBe(0);
      expect(result.wasRedacted).toBe(false);
    });

    it("accumulates count across patterns", () => {
      const list = PatternList.createEmpty()
        .add(Pattern.create("foo", "[ONE]"))
        .add(Pattern.create("bar", "[TWO]"));

      const result = list.redact("foo bar foo bar foo");

      expect(result.matchCount).toBe(5);
    });

    it("count equals the sum of individual pattern match counts (additivity)", () => {
      const list = PatternList.createEmpty()
        .add(Pattern.create("foo", "[F]"))
        .add(Pattern.create("bar", "[B]"))
        .add(Pattern.create("baz", "[Z]"));

      const text = "foo bar baz foo baz";
      const result = list.redact(text);

      expect(result.matchCount).toBe(5);
      expect(result.text).toBe("[F] [B] [Z] [F] [Z]");
    });

    it("single pass does not double-count when patterns are adjacent", () => {
      const list = PatternList.createEmpty()
        .add(Pattern.create("ab", "[X]"))
        .add(Pattern.create("cd", "[Y]"));

      const result = list.redact("abcd");

      expect(result.matchCount).toBe(2);
      expect(result.text).toBe("[X][Y]");
    });

    it("redaction result is identical regardless of pattern insertion order", () => {
      const listA = PatternList.createEmpty()
        .add(Pattern.create("alpha", "[A]"))
        .add(Pattern.create("beta", "[B]"))
        .add(Pattern.create("gamma", "[G]"));

      const listB = PatternList.createEmpty()
        .add(Pattern.create("gamma", "[G]"))
        .add(Pattern.create("alpha", "[A]"))
        .add(Pattern.create("beta", "[B]"));

      const text = "alpha meets beta and gamma";

      expect(listA.redact(text).text).toBe(listB.redact(text).text);
      expect(listA.redact(text).matchCount).toBe(listB.redact(text).matchCount);
    });

    it("single-pass redaction is faster than sequential", () => {
      let list = PatternList.createEmpty();

      for (let patternIndex = 0; patternIndex < 50; patternIndex++) {
        list = list.add(Pattern.create(`word${patternIndex}`, `[W${patternIndex}]`));
      }

      const text = Array(100).fill("word0 word25 word49 other text").join(" ");

      const start = performance.now();
      const result = list.redact(text);
      const elapsed = performance.now() - start;

      expect(result.matchCount).toBe(300);
      expect(elapsed).toBeLessThan(20);
    });

    it("longest match wins (no partial replacement)", () => {
      const list = PatternList.createEmpty()
        .add(Pattern.create("secret", "[SHORT]"))
        .add(Pattern.create("secretkey", "[LONG]"));

      const result = list.redact("my secretkey is secret");

      expect(result.text).toBe("my [LONG] is [SHORT]");
    });
  });

  describe("toArray()", () => {
    it("returns copy of patterns", () => {
      const list = PatternList.createEmpty().add(Pattern.create("secret", "[HIDDEN]"));
      const arr = list.toArray();

      expect(arr.length).toBe(1);
      expect(arr[0].original.raw).toBe("secret");
    });
  });

  describe("getStalePatterns()", () => {
    it("returns patterns older than threshold", () => {
      const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
      const list = PatternList.createEmpty()
        .add(Pattern.create("old", "[STALE]", oldTime))
        .add(Pattern.create("recent", "[FRESH]"));

      const stale = list.getStalePatterns(90);

      expect(stale.length).toBe(1);
      expect(stale[0].original.raw).toBe("old");
    });

    it("returns empty array when no patterns are stale", () => {
      const list = PatternList.createEmpty().add(Pattern.create("recent", "[R]"));

      const stale = list.getStalePatterns(90);

      expect(stale.length).toBe(0);
    });

    it("returns all patterns when maxAgeDays is 0", () => {
      const pastTime = Date.now() - 1000;
      const list = PatternList.createEmpty().add(Pattern.create("past", "[P]", pastTime));

      const stale = list.getStalePatterns(0);

      expect(stale.length).toBe(1);
    });

    it("throws for negative maxAgeDays", () => {
      const list = PatternList.createEmpty();
      expect(() => list.getStalePatterns(-1)).toThrow(ContractViolation);
    });
  });

  describe("has() performance", () => {
    it("has() is O(1) - performance test", () => {
      let list = PatternList.createEmpty();

      for (let patternIndex = 0; patternIndex < 100; patternIndex++) {
        list = list.add(Pattern.create(`pattern${patternIndex}`, `[R${patternIndex}]`));
      }

      const start = performance.now();

      for (let lookupIndex = 0; lookupIndex < 10000; lookupIndex++) {
        list.has("pattern50");
        list.has("nonexistent");
      }

      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });
});

describe("RedactionResult", () => {
  describe("create()", () => {
    it("creates result with correct properties", () => {
      const result = RedactionResult.create("redacted text", 3);

      expect(result.text).toBe("redacted text");
      expect(result.matchCount).toBe(3);
      expect(result.wasRedacted).toBe(true);
    });

    it("sets wasRedacted=false when matchCount is 0", () => {
      const result = RedactionResult.create("unchanged", 0);

      expect(result.wasRedacted).toBe(false);
    });

    it("throws for negative count", () => {
      expect(() => RedactionResult.create("text", -1)).toThrow(ContractViolation);
    });
  });

  describe("unchanged()", () => {
    it("creates result with matchCount=0 and wasRedacted=false", () => {
      const result = RedactionResult.unchanged("original");

      expect(result.text).toBe("original");
      expect(result.matchCount).toBe(0);
      expect(result.wasRedacted).toBe(false);
    });
  });
});

describe("RedactorConfig", () => {
  describe("createDefault()", () => {
    it("creates enabled config with empty patterns", () => {
      const config = RedactorConfig.createDefault();

      expect(config.isEnabled).toBe(true);
      expect(config.patterns.length).toBe(0);
    });
  });

  describe("parseJSON()", () => {
    it("parses valid config", () => {
      const json = {
        enabled: false,
        patterns: [{ original: "secret", replacement: "[X]" }],
      };

      const { config } = RedactorConfig.parseJSON(json);

      expect(config.isEnabled).toBe(false);
      expect(config.patterns.length).toBe(1);
    });

    it("defaults isEnabled to true if missing", () => {
      const { config } = RedactorConfig.parseJSON({ patterns: [] });

      expect(config.isEnabled).toBe(true);
    });

    it("returns empty patterns for non-array patterns field", () => {
      const { config } = RedactorConfig.parseJSON({ enabled: true, patterns: "not an array" });

      expect(config.patterns.length).toBe(0);
    });

    it("returns warnings for malformed patterns", () => {
      const json = {
        patterns: [
          { original: "valid", replacement: "[OK]" },
          { original: "", replacement: "[BAD]" },
          { notOriginal: "wrong" },
        ],
      };

      const { config, warnings }: ConfigParseResult = RedactorConfig.parseJSON(json);

      expect(config.patterns.length).toBe(1);
      expect(warnings.length).toBe(2);
      expect(warnings[0]).toContain("#2");
      expect(warnings[1]).toContain("#3");
    });

    it("reports warnings for all invalid entries and only keeps valid ones", () => {
      const json = {
        enabled: true,
        patterns: [
          { original: "valid", replacement: "[OK]" },
          { original: "", replacement: "[INVALID]" },
          { original: "also-valid", replacement: "[OK2]" },
          { notOriginal: "wrong shape" },
          null,
          "string",
        ],
      };

      const { config, warnings } = RedactorConfig.parseJSON(json);

      expect(config.patterns.length).toBe(2);
      expect(warnings).toHaveLength(4);
    });

    it("returns empty warnings for fully valid patterns", () => {
      const json = {
        enabled: true,
        patterns: [
          { original: "alpha", replacement: "[A]" },
          { original: "beta", replacement: "[B]" },
        ],
      };

      const { config, warnings } = RedactorConfig.parseJSON(json);

      expect(config.patterns.length).toBe(2);
      expect(warnings).toHaveLength(0);
    });

    it("warns for non-object entries (null, string, number)", () => {
      const json = {
        patterns: [null, "string-entry", 42, { original: "valid", replacement: "[OK]" }],
      };

      const { config, warnings } = RedactorConfig.parseJSON(json);

      expect(config.patterns.length).toBe(1);
      expect(warnings).toHaveLength(3);
      expect(warnings[0]).toContain("#1");
      expect(warnings[1]).toContain("#2");
      expect(warnings[2]).toContain("#3");
    });

    it("warns for invalid replacement field", () => {
      const json = {
        patterns: [
          { original: "secret", replacement: "" },
          { original: "token", replacement: 42 },
        ],
      };

      const { config, warnings } = RedactorConfig.parseJSON(json);

      expect(config.patterns.length).toBe(0);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("#1");
      expect(warnings[1]).toContain("#2");
    });

    it("warns for entry with missing original field", () => {
      const json = {
        patterns: [
          { replacement: "[REDACTED]", createdAt: 1000 },
        ],
      };

      const { config, warnings } = RedactorConfig.parseJSON(json);

      expect(config.patterns.length).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Missing or empty");
    });

    it("preserves createdAt timestamp when loading patterns from JSON", () => {
      const timestamp = 1_700_000_000_000;
      const { config } = RedactorConfig.parseJSON({
        patterns: [{ original: "secret", replacement: "[X]", createdAt: timestamp }],
      });

      expect(config.patterns.toArray()[0].createdAt).toBe(timestamp);
    });

    it("warns when Pattern.create contract is violated", () => {
      const json = {
        patterns: [{ original: "foo", replacement: "xfooy" }],
      };

      const { config, warnings } = RedactorConfig.parseJSON(json);

      expect(config.patterns.length).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("#1");
      expect(warnings[0]).toContain("foo");
    });

    it("uses default replacement when replacement field is absent", () => {
      const { config, warnings } = RedactorConfig.parseJSON({
        patterns: [{ original: "secret" }],
      });

      expect(config.patterns.length).toBe(1);
      expect(config.patterns.toArray()[0].replacement.raw).toBe("[REDACTED]");
      expect(warnings).toHaveLength(0);
    });

    it("throws ContractViolation for null input", () => {
      expect(() => RedactorConfig.parseJSON(null)).toThrow(ContractViolation);
    });

    it("throws ContractViolation for non-object input", () => {
      expect(() => RedactorConfig.parseJSON("string")).toThrow(ContractViolation);
    });
  });

  describe("enable() / disable()", () => {
    it("enable() returns config with isEnabled=true", () => {
      const config = RedactorConfig.createDefault().disable().enable();

      expect(config.isEnabled).toBe(true);
    });

    it("disable() returns config with isEnabled=false", () => {
      const config = RedactorConfig.createDefault().disable();

      expect(config.isEnabled).toBe(false);
    });
  });

  describe("addPattern() / removePattern()", () => {
    it("addPattern increases pattern count by 1", () => {
      const config = RedactorConfig.createDefault();
      const newConfig = config.addPattern(Pattern.create("secret", "[HIDDEN]"));

      expect(newConfig.patterns.length).toBe(1);
    });

    it("removePattern removes pattern", () => {
      const config = RedactorConfig.createDefault()
        .addPattern(Pattern.create("secret", "[HIDDEN]"))
        .removePattern("secret");

      expect(config.patterns.length).toBe(0);
    });
  });

  describe("clearPatterns()", () => {
    it("removes all patterns", () => {
      const config = RedactorConfig.createDefault()
        .addPattern(Pattern.create("alpha", "[FIRST]"))
        .addPattern(Pattern.create("beta", "[SECOND]"))
        .clearPatterns();

      expect(config.patterns.length).toBe(0);
    });
  });

  describe("redact()", () => {
    it("returns unchanged when disabled", () => {
      const config = RedactorConfig.createDefault()
        .addPattern(Pattern.create("secret", "[X]"))
        .disable();

      const result = config.redact("my secret");

      expect(result.text).toBe("my secret");
      expect(result.wasRedacted).toBe(false);
    });

    it("returns unchanged when no patterns", () => {
      const config = RedactorConfig.createDefault();

      const result = config.redact("my secret");

      expect(result.wasRedacted).toBe(false);
    });

    it("applies redaction when enabled with patterns", () => {
      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create("secret", "[REDACTED]")
      );

      const result = config.redact("my secret data");

      expect(result.text).toBe("my [REDACTED] data");
      expect(result.wasRedacted).toBe(true);
    });
  });

  describe("toJSON()", () => {
    it("serializes config correctly", () => {
      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create("secret", "[HIDDEN]")
      );

      const json = config.toJSON();

      expect(json.enabled).toBe(true);
      expect(json.patterns).toHaveLength(1);
      expect(json.patterns[0]).toEqual(
        expect.objectContaining({ original: "secret", replacement: "[HIDDEN]" })
      );
      expect(typeof json.patterns[0].createdAt).toBe("number");
    });
  });
});

describe("RedactorConfig.maxPatterns", () => {
  it("defaults to MAX_PATTERNS", () => {
    const config = RedactorConfig.createDefault();
    expect(config.maxPatterns).toBe(MAX_PATTERNS);
  });

  it("preserves maxPatterns through enable/disable/clear/remove", () => {
    const config = RedactorConfig.create(true, PatternList.createEmpty(), 42)
      .addPattern(Pattern.create("secret", "[X]"));

    expect(config.enable().maxPatterns).toBe(42);
    expect(config.disable().maxPatterns).toBe(42);
    expect(config.clearPatterns().maxPatterns).toBe(42);
    expect(config.removePattern("secret").maxPatterns).toBe(42);
  });

  it("setMaxPatterns returns new config with updated limit", () => {
    const config = RedactorConfig.createDefault();
    const updated = config.setMaxPatterns(50);

    expect(updated.maxPatterns).toBe(50);
    expect(config.maxPatterns).toBe(MAX_PATTERNS); // original unchanged (immutable)
  });

  it("setMaxPatterns rejects limit below current pattern count", () => {
    const config = RedactorConfig.createDefault()
      .addPattern(Pattern.create("alpha", "[A]"))
      .addPattern(Pattern.create("beta", "[B]"))
      .addPattern(Pattern.create("gamma", "[G]"));

    expect(() => config.setMaxPatterns(2)).toThrow(ContractViolation);
  });

  it("setMaxPatterns rejects limit above MAX_CONFIGURABLE_LIMIT", () => {
    const config = RedactorConfig.createDefault();
    expect(() => config.setMaxPatterns(MAX_CONFIGURABLE_LIMIT + 1)).toThrow(ContractViolation);
  });

  it("addPattern respects custom maxPatterns", () => {
    let config = RedactorConfig.create(true, PatternList.createEmpty(), 5);

    for (let i = 0; i < 5; i++) {
      config = config.addPattern(Pattern.create(`pattern${i}`, `[R${i}]`));
    }

    expect(config.patterns.length).toBe(5);
    expect(() => config.addPattern(Pattern.create("overflow", "[X]"))).toThrow(ContractViolation);
  });

  it("parseJSON reads maxPatterns from raw JSON", () => {
    const json = {
      enabled: true,
      maxPatterns: 50,
      patterns: [{ original: "secret", replacement: "[X]" }],
    };

    const { config } = RedactorConfig.parseJSON(json);

    expect(config.maxPatterns).toBe(50);
  });

  it("parseJSON defaults to MAX_PATTERNS when maxPatterns is absent", () => {
    const json = {
      enabled: true,
      patterns: [],
    };

    const { config } = RedactorConfig.parseJSON(json);

    expect(config.maxPatterns).toBe(MAX_PATTERNS);
  });

  it("parseJSON clamps out-of-range maxPatterns and warns", () => {
    const jsonTooHigh = {
      enabled: true,
      maxPatterns: 9999,
      patterns: [],
    };

    const resultHigh = RedactorConfig.parseJSON(jsonTooHigh);

    expect(resultHigh.config.maxPatterns).toBe(MAX_CONFIGURABLE_LIMIT);
    expect(resultHigh.warnings.some((w) => w.includes("clamped"))).toBe(true);

    const jsonTooLow = {
      enabled: true,
      maxPatterns: -5,
      patterns: [],
    };

    const resultLow = RedactorConfig.parseJSON(jsonTooLow);

    expect(resultLow.config.maxPatterns).toBe(1);
    expect(resultLow.warnings.some((w) => w.includes("clamped"))).toBe(true);
  });

  it("toJSON includes maxPatterns field", () => {
    const config = RedactorConfig.create(true, PatternList.createEmpty(), 42);
    const json = config.toJSON();

    expect(json.maxPatterns).toBe(42);
  });
});

describe("parseCommand()", () => {
  it("parses 'add foo' as add with default replacement", () => {
    const command = parseCommand("add foo");

    expect(command.type).toBe("add");

    if (command.type === "add") {
      expect(command.original).toBe("foo");
      expect(command.replacement).toBeUndefined();
    }
  });

  it("parses 'add foo as [BAR]' with custom replacement", () => {
    const command = parseCommand("add foo as [BAR]");

    expect(command.type).toBe("add");

    if (command.type === "add") {
      expect(command.original).toBe("foo");
      expect(command.replacement).toBe("[BAR]");
    }
  });

  it("handles 'as' in the original text (uses last occurrence)", () => {
    const command = parseCommand("add John Smith as CEO as [PERSON]");

    expect(command.type).toBe("add");

    if (command.type === "add") {
      expect(command.original).toBe("John Smith as CEO");
      expect(command.replacement).toBe("[PERSON]");
    }
  });

  it("parses 'remove foo' as remove command", () => {
    const command = parseCommand("remove foo");

    expect(command.type).toBe("remove");

    if (command.type === "remove") {
      expect(command.original).toBe("foo");
    }
  });

  it("parses 'list' as list command", () => {
    const command = parseCommand("list");
    expect(command.type).toBe("list");
  });

  it("parses 'clear' as clear command", () => {
    const command = parseCommand("clear");
    expect(command.type).toBe("clear");
  });

  it("parses 'on' as enable command", () => {
    const command = parseCommand("on");
    expect(command.type).toBe("enable");
  });

  it("parses 'off' as disable command", () => {
    const command = parseCommand("off");
    expect(command.type).toBe("disable");
  });

  it("parses unknown command as help", () => {
    const command = parseCommand("unknown");
    expect(command.type).toBe("help");
  });

  it("parses empty string as help", () => {
    const command = parseCommand("");
    expect(command.type).toBe("help");
  });

  it("returns invalid for 'add' without argument", () => {
    const command = parseCommand("add");
    expect(command.type).toBe("invalid");
  });

  it("returns invalid for 'remove' without argument", () => {
    const command = parseCommand("remove");
    expect(command.type).toBe("invalid");
  });

  it("parses 'limit 200' as limit command with value 200", () => {
    const command = parseCommand("limit 200");

    expect(command.type).toBe("limit");

    if (command.type === "limit") {
      expect(command.value).toBe(200);
    }
  });

  it("returns invalid for 'limit' without argument", () => {
    const command = parseCommand("limit");

    expect(command.type).toBe("invalid");

    if (command.type === "invalid") {
      expect(command.reason).toContain("Usage:");
    }
  });

  it("returns invalid for 'limit abc' (non-numeric)", () => {
    const command = parseCommand("limit abc");

    expect(command.type).toBe("invalid");

    if (command.type === "invalid") {
      expect(command.reason).toContain("Usage:");
    }
  });
});

describe("executeCommand()", () => {
  describe("add command", () => {
    it("returns save + notify + updateStatus effects", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("add secret");
      const result = executeCommand(command, config);

      expect(result.effects.length).toBe(3);
      expect(result.effects[0].type).toBe("save");
      expect(result.effects[1].type).toBe("notify");
      expect(result.effects[2].type).toBe("updateStatus");

      const notify = result.effects[1];
      if (notify.type === "notify") {
        expect(notify.message).toContain("Added:");
        expect(notify.level).toBe("success");
      }
    });

    it("warns if pattern already exists", () => {
      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create("secret", "[X]")
      );
      const command = parseCommand("add secret");
      const result = executeCommand(command, config);

      expect(result.effects.length).toBe(1);
      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain("already exists");
        expect(notify.level).toBe("warning");
      }
    });

    it("adds pattern to config", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("add secret as [HIDDEN]");
      const result = executeCommand(command, config);

      expect(result.config.patterns.length).toBe(1);
      expect(result.config.patterns.has("secret")).toBe(true);
    });
  });

  describe("remove command", () => {
    it("returns effects for existing pattern", () => {
      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create("secret", "[HIDDEN]")
      );
      const command = parseCommand("remove secret");
      const result = executeCommand(command, config);

      expect(result.effects.length).toBe(3);
      expect(result.config.patterns.has("secret")).toBe(false);
    });

    it("warns if pattern not found", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("remove nonexistent");
      const result = executeCommand(command, config);

      expect(result.effects.length).toBe(1);
      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain("not found");
        expect(notify.level).toBe("warning");
      }
    });
  });

  describe("list command", () => {
    it("returns pattern listing", () => {
      const config = RedactorConfig.createDefault()
        .addPattern(Pattern.create("alpha", "[FIRST]"))
        .addPattern(Pattern.create("beta", "[SECOND]"));
      const command = parseCommand("list");
      const result = executeCommand(command, config);

      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain("Active redaction patterns");
        expect(notify.message).toContain('"alpha"');
        expect(notify.message).toContain('"beta"');
      }
    });

    it("returns info message when no patterns", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("list");
      const result = executeCommand(command, config);

      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain("No redaction patterns");
      }
    });

    it("list shows quoted original for each pattern", () => {
      const config = RedactorConfig.createDefault()
        .addPattern(Pattern.create("my-api-key", "[KEY]"))
        .addPattern(Pattern.create("my-token", "[TOKEN]"));
      const result = executeCommand(parseCommand("list"), config);

      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain('"my-api-key"');
        expect(notify.message).toContain('"my-token"');
      }
    });
  });

  describe("clear command", () => {
    it("returns confirm effect with confirmedOutcome payload", () => {
      const config = RedactorConfig.createDefault().addPattern(
        Pattern.create("secret", "[HIDDEN]")
      );
      const command = parseCommand("clear");
      const result = executeCommand(command, config);

      expect(result.effects.length).toBe(1);
      expect(result.effects[0].type).toBe("confirm");

      const confirm = result.effects[0];
      if (confirm.type === "confirm") {
        expect(confirm.confirmedOutcome.config.patterns.length).toBe(0);
        expect(confirm.confirmedOutcome.effects.length).toBe(3);
      }
    });

    it("returns info when no patterns to clear", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("clear");
      const result = executeCommand(command, config);

      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain("No patterns to clear");
      }
    });
  });

  describe("enable/disable commands", () => {
    it("enable toggles config.isEnabled to true", () => {
      const config = RedactorConfig.createDefault().disable();
      const command = parseCommand("on");
      const result = executeCommand(command, config);

      expect(result.config.isEnabled).toBe(true);
    });

    it("disable toggles config.isEnabled to false", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("off");
      const result = executeCommand(command, config);

      expect(result.config.isEnabled).toBe(false);
    });

    it("shows info when already enabled", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("on");
      const result = executeCommand(command, config);

      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain("already enabled");
      }
    });

    it("shows info when already disabled", () => {
      const config = RedactorConfig.createDefault().disable();
      const command = parseCommand("off");
      const result = executeCommand(command, config);

      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain("already disabled");
      }
    });
  });

  describe("limit command", () => {
    it("updates maxPatterns and emits save + success + warning for value > MAX_PATTERNS", () => {
      const config = RedactorConfig.createDefault();
      const result = executeCommand({ type: "limit", value: 200 }, config);

      expect(result.config.maxPatterns).toBe(200);

      const effectTypes = result.effects.map((e) => e.type);

      expect(effectTypes).toContain("save");
      expect(effectTypes).toContain("updateStatus");

      const successNotify = result.effects.find(
        (e) => e.type === "notify" && "level" in e && e.level === "success"
      );

      expect(successNotify).toBeDefined();

      if (successNotify && successNotify.type === "notify") {
        expect(successNotify.message).toContain("→");
      }

      const warningNotify = result.effects.find(
        (e) => e.type === "notify" && "level" in e && e.level === "warning"
      );

      expect(warningNotify).toBeDefined();

      if (warningNotify && warningNotify.type === "notify") {
        expect(warningNotify.message).toContain("advanced");
      }
    });

    it("returns error effect when setting limit below current pattern count", () => {
      let config = RedactorConfig.create(true, PatternList.createEmpty(), 80);

      for (let i = 0; i < 80; i++) {
        config = config.addPattern(Pattern.create(`pattern${i}`, `[R${i}]`));
      }

      const result = executeCommand({ type: "limit", value: 50 }, config);

      expect(result.config.maxPatterns).toBe(80); // unchanged
      expect(result.effects.length).toBe(1);

      const notify = result.effects[0];

      expect(notify.type).toBe("notify");

      if (notify.type === "notify") {
        expect(notify.level).toBe("error");
        expect(notify.message).toContain("below current pattern count");
      }
    });

    it("returns no-op info message when limit is already the same", () => {
      const config = RedactorConfig.createDefault();
      const result = executeCommand({ type: "limit", value: MAX_PATTERNS }, config);

      expect(result.config).toBe(config); // same reference
      expect(result.effects.length).toBe(1);

      const notify = result.effects[0];

      expect(notify.type).toBe("notify");

      if (notify.type === "notify") {
        expect(notify.level).toBe("info");
        expect(notify.message).toContain("already");
      }
    });
  });

  describe("help/invalid commands", () => {
    it("help returns usage info", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("help");

      const result = executeCommand(command, config);

      const notify = result.effects[0];

      if (notify.type === "notify") {
        expect(notify.message).toContain("/redact add");
        expect(notify.message).toContain("/redact remove");
      }
    });

    it("invalid command shows targeted reason and hint, not full help dump", () => {
      const config = RedactorConfig.createDefault();
      const command = parseCommand("add");

      const result = executeCommand(command, config);

      const notify = result.effects[0];
      if (notify.type === "notify") {
        expect(notify.message).toContain("Usage:");
        expect(notify.message).toContain("Run /redact for full usage.");
        expect(notify.message).not.toContain("/redact remove");
        expect(notify.level).toBe("warning");
      }
    });
  });
});

describe("Generative Laws (Property-Based)", () => {
  test.prop([fc.string(), fc.integer({ min: 0, max: 10000 })])(
    "RedactionResult.wasRedacted === (matchCount > 0)",
    (text, matchCount) => {
      const result = RedactionResult.create(text, matchCount);
      expect(result.wasRedacted).toBe(matchCount > 0);
    }
  );

  test.prop([fc.string({ minLength: 1, maxLength: 50 })])(
    "PatternList.add() increases length by exactly 1",
    (original) => {
      if (original.trim().length === 0) {
        return;
      }

      const replacement = "§§§REPLACED§§§";

      if (replacement.toLowerCase().includes(original.trim().toLowerCase())) {
        return;
      }

      try {
        const list = PatternList.createEmpty();
        const pattern = Pattern.create(original, replacement);
        const newList = list.add(pattern);

        expect(newList.length).toBe(list.length + 1);
      } catch (error) {
        if (error instanceof ContractViolation) {
          return;
        }

        throw error;
      }
    }
  );

  test.prop([fc.string({ minLength: 1, maxLength: 50 })])(
    "PatternList.remove() ensures has() returns false",
    (original) => {
      if (original.trim().length === 0) {
        return;
      }

      const replacement = "§§§REPLACED§§§";

      if (replacement.toLowerCase().includes(original.trim().toLowerCase())) {
        return;
      }

      try {
        const pattern = Pattern.create(original, replacement);
        const list = PatternList.createEmpty().add(pattern);
        const removed = list.remove(original);

        expect(removed.has(original)).toBe(false);
      } catch (error) {
        if (error instanceof ContractViolation) {
          return;
        }

        throw error;
      }
    }
  );

  test.prop([
    fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
      minLength: 0,
      maxLength: 10,
    }),
    fc.string({ minLength: 0, maxLength: 100 }),
  ])(
    "PatternList.redact() count is non-negative",
    (originals, text) => {
      const seen = new Set<string>();

      let list = PatternList.createEmpty();

      for (const original of originals) {
        const trimmed = original.trim().toLowerCase();

        if (trimmed.length === 0) {
          continue;
        }

        if (seen.has(trimmed)) {
          continue;
        }

        if ("[HIDDEN]".toLowerCase().includes(trimmed)) {
          continue;
        }

        seen.add(trimmed);

        try {
          list = list.add(Pattern.create(original, "[HIDDEN]"));
        } catch {
          // Skip patterns that violate contracts
        }
      }

      const result = list.redact(text);

      expect(result.matchCount).toBeGreaterThanOrEqual(0);
      expect(result.wasRedacted).toBe(result.matchCount > 0);
    }
  );
});

describe("Known Limitations", () => {
  describe("Unicode normalization", () => {
    it("NFC and NFD forms of the same visual string are treated as distinct patterns", () => {
      // "café" in NFC (precomposed é) vs NFD (e + combining acute accent)
      const nfc = "caf\u00E9"; // café (4 code units)
      const nfd = "cafe\u0301"; // café (5 code units, decomposed)

      // They look the same but are different byte sequences
      expect(nfc).not.toBe(nfd);
      expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));

      // This is a known limitation wherein adding an NFC pattern does NOT
      // redact NFD input
      const config = RedactorConfig.createDefault()
        .addPattern(Pattern.create(nfc, "[REDACTED]"));

      const result = config.redact(`Meeting at ${nfd} at 3pm`);

      expect(result.wasRedacted).toBe(false);
    });

    it("NFC pattern redacts NFC input correctly", () => {
      const nfc = "caf\u00E9";

      const config = RedactorConfig.createDefault()
        .addPattern(Pattern.create(nfc, "[REDACTED]"));

      const result = config.redact(`Meeting at ${nfc} at 3pm`);

      expect(result.wasRedacted).toBe(true);
      expect(result.text).toBe("Meeting at [REDACTED] at 3pm");
    });
  });
});
