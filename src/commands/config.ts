import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  getConfigPath as defaultGetConfigPath,
  loadConfig as defaultLoadConfig,
  saveConfig as defaultSaveConfig,
  type PerplexityConfig,
} from "../config.js";

const KNOWN_MODELS: { value: string; label: string }[] = [
  { value: "pplx_pro_upgraded", label: "Best (auto)" },
  { value: "pplx_pro", label: "Default Pro" },
  { value: "experimental", label: "Sonar" },
  { value: "gpt54", label: "GPT-5.4" },
  { value: "gpt54_thinking", label: "GPT-5.4 Thinking" },
  { value: "claude46sonnet", label: "Claude 4.6 Sonnet" },
  { value: "claude46sonnetthinking", label: "Claude 4.6 Sonnet Thinking" },
  { value: "gemini31pro_high", label: "Gemini 3.1 Pro" },
  { value: "nv_nemotron_3_super", label: "Nemotron 3 Super" },
  { value: "pplx_reasoning", label: "Default Reasoning" },
  { value: "pplx_alpha", label: "Deep Research" },
];

function formatCurrentConfig(config: { model?: string; incognito?: boolean }): string {
  const model = config.model ?? "pplx_pro_upgraded (default)";
  const modelLabel = KNOWN_MODELS.find((m) => m.value === config.model)?.label;
  const modelDisplay = modelLabel ? `${model} (${modelLabel})` : model;
  const incognito = config.incognito ?? true;
  return `Model: ${modelDisplay}\nIncognito: ${incognito}`;
}

interface ConfigCommandDeps {
  getConfigPath: () => string;
  loadConfig: () => Promise<PerplexityConfig>;
  saveConfig: (config: PerplexityConfig) => Promise<void>;
}

export function registerPerplexityConfigCommand(
  pi: ExtensionAPI,
  deps: ConfigCommandDeps = {
    getConfigPath: defaultGetConfigPath,
    loadConfig: defaultLoadConfig,
    saveConfig: defaultSaveConfig,
  },
): void {
  pi.registerCommand("perplexity-config", {
    description: "Configure Perplexity search defaults",
    handler: async (args, ctx) => {
      if (args.trim() === "--help" || args.trim() === "-h") {
        ctx.ui.notify(
          `Usage: /perplexity-config [--show]\n\nInteractively set default model and incognito mode.\nConfig stored at: ${deps.getConfigPath()}`,
          "info",
        );
        return;
      }

      try {
        const config = await deps.loadConfig();

        if (args.trim() === "--show") {
          ctx.ui.notify(`Perplexity config (${deps.getConfigPath()}):\n${formatCurrentConfig(config)}`, "info");
          return;
        }

        const modelLabels = KNOWN_MODELS.map((m) => `${m.label} (${m.value})`);
        const selected = await ctx.ui.select("Default model", modelLabels);
        if (selected === undefined || selected === null) {
          ctx.ui.notify("Perplexity config unchanged.", "info");
          return;
        }
        const selectedModel = KNOWN_MODELS[modelLabels.indexOf(selected)]?.value ?? selected;

        const incognito = await ctx.ui.confirm(
          "Incognito mode",
          "Hide searches from Perplexity web history? (recommended)",
        );
        if (incognito === undefined || incognito === null) {
          ctx.ui.notify("Perplexity config unchanged.", "info");
          return;
        }

        config.model = selectedModel;
        config.incognito = incognito;

        await deps.saveConfig(config);
        ctx.ui.notify(`Perplexity config saved:\n${formatCurrentConfig(config)}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Failed to save Perplexity config: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
