import { describe, it, expect, vi, beforeEach } from "vitest";
import registerExtension from "../src/index";
import { RedactorConfig, PatternList, Pattern } from "../src/core";
import type { ContentBlock } from "../src/core";

vi.mock("../src/shell", () => ({
  loadConfig: vi.fn(),
  interpretEffects: vi.fn(),
  updateStatus: vi.fn(),
  saveConfig: vi.fn(),
  SaveFailedError: class SaveFailedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SaveFailedError";
    }
  },
}));

import { loadConfig, interpretEffects, updateStatus } from "../src/shell";

function setupExtension() {
  const handlers: Record<string, Function> = {};

  const mockPi = {
    on: vi.fn((event: string, handler: Function) => {
      handlers[event] = handler;
    }),
    registerCommand: vi.fn((name: string, opts: { handler: Function }) => {
      handlers[`cmd:${name}`] = opts.handler;
    }),
  };

  registerExtension(mockPi as any);

  return { handlers, mockPi };
}

function createMockContext() {
  return {
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

describe("index.ts — extension integration", () => {
  let handlers: Record<string, Function>;
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(async () => {
    vi.resetAllMocks();

    const result = setupExtension();

    handlers = result.handlers;
    mockContext = createMockContext();

    vi.mocked(loadConfig).mockResolvedValue({
      config: RedactorConfig.create(
        true,
        PatternList.from([Pattern.create("secret")]),
      ),
      status: "ok" as const,
      patternWarnings: [],
    });

    await handlers["session_start"]({}, mockContext);
  });

  // Fail-closed
  it("tool_result fail-closed: returns static error string, not the error reason", async () => {
    // Pass non-array content to trigger ContractViolation in redactContent
    const result = await handlers["tool_result"](
      { toolName: "read", content: "not-an-array" },
      mockContext,
    );

    expect(result.content[0].text).toBe("[REDACTED — internal redaction error]");
    // The dynamic reason must not leak into the LLM-visible content
    expect(result.content[0].text).not.toContain("content must be an array");
    expect(result.isError).toBe(true);

    // The detailed reason is shown locally via notify
    expect(mockContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("content must be an array"),
      "error",
    );
  });

  it("context fail-closed: returns empty messages on error", async () => {
    // A text block with a non-string `text` triggers ContractViolation
    // inside PatternList.redact during the content.map() pass.
    const result = await handlers["context"](
      {
        messages: [
          { role: "user", content: [{ type: "text", text: 42 }] },
        ],
      },
      mockContext,
    );

    expect(result).toEqual({ messages: [] });
  });

  it("input fail-closed: returns handled on error", async () => {
    // undefined text triggers ContractViolation in PatternList.redact
    const result = await handlers["input"](
      { text: undefined },
      mockContext,
    );

    expect(result).toEqual({ action: "handled" });
  });

  // Content redaction
  it("context: redacts string content in messages", async () => {
    const result = await handlers["context"](
      { messages: [{ role: "user", content: "my secret data" }] },
      mockContext,
    );

    expect(result.messages[0].content).toBe("my [REDACTED] data");
  });

  it("context: redacts array content in messages", async () => {
    const result = await handlers["context"](
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "my secret data" }],
          },
        ],
      },
      mockContext,
    );

    expect(result.messages[0].content[0].text).toBe("my [REDACTED] data");
  });

  it("context: skips messages without role property", async () => {
    const messages = [{ content: "secret" }];

    const result = await handlers["context"](
      { messages },
      mockContext,
    );

    expect(result).toBeUndefined();
    expect(messages[0].content).toBe("secret");
  });

  // Thinking block scanning
  it("context: redacts unsigned thinking blocks", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "the secret is here" },
        ],
      },
    ];

    const result = await handlers["context"](
      { messages },
      mockContext,
    );

    expect(result.messages[0].content[0].thinking).toBe(
      "the [REDACTED] is here",
    );
  });

  it("context: preserves signed thinking blocks unchanged", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "the secret is here",
            thinkingSignature: "sig123",
          },
        ],
      },
    ];

    const result = await handlers["context"](
      { messages },
      mockContext,
    );

    expect(result).toBeUndefined();
    expect(messages[0].content[0].thinking).toBe("the secret is here");
  });

  it("context: preserves redacted thinking blocks unchanged", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: "sig",
            redacted: true,
          },
        ],
      },
    ];

    const result = await handlers["context"](
      { messages },
      mockContext,
    );

    expect(result).toBeUndefined();
    expect(messages[0].content[0].thinking).toBe("");
    expect(messages[0].content[0].redacted).toBe(true);
  });
});
