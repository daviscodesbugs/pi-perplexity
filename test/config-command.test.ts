import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerPerplexityConfigCommand } from "../src/commands/config.js";
import { loadConfig, saveConfig } from "../src/config.js";

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-perplexity-command-test-"));
  configPath = join(tempDir, "config.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("perplexity-config command", () => {
  test("writes selected config to disk", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;

    registerPerplexityConfigCommand(
      {
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
          expect(name).toBe("perplexity-config");
          handler = command.handler;
        },
      } as any,
      {
        getConfigPath: () => configPath,
        loadConfig: () => loadConfig(configPath),
        saveConfig: (config) => saveConfig(config, configPath),
      },
    );

    expect(handler).toBeDefined();

    const notifications: Array<{ message: string; level: string }> = [];
    await handler!("", {
      ui: {
        select: async () => "GPT-5.4 (gpt54)",
        confirm: async () => false,
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    const raw = await readFile(configPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ model: "gpt54", incognito: false });
    expect(notifications).toContainEqual({
      message: "Perplexity config saved:\nModel: gpt54 (GPT-5.4)\nIncognito: false",
      level: "info",
    });
  });
});
