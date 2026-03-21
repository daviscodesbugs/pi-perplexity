import { describe, expect, test } from "bun:test";

describe("extension entrypoint", () => {
  test("registers the config command", async () => {
    const { default: registerExtension } = await import(`../src/index.ts?test=${crypto.randomUUID()}`);

    const commands: string[] = [];

    registerExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool() {
        return undefined;
      },
    } as any);

    expect(commands).toContain("perplexity-login");
    expect(commands).toContain("perplexity-config");
  });
});
