import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  buildConfigEntry,
  buildRuleDocs,
  currentFormat,
  hasProviderRule,
  isWired,
  outputLimit,
  removeConfigEntry,
  writeAtomic,
  zcodeBaseUrl,
  ZCODE_KINDS,
  DEFAULT_FORMAT,
  REASONING_LEVELS,
} from "@/lib/zcodeConfig.js";

describe("zcodeConfig", () => {
  it("caps the output limit ZCode is told about", () => {
    expect(outputLimit({ maxOutput: 128000 })).toBe(128000);
    expect(outputLimit({ maxOutput: 500000 })).toBe(128000);
    expect(outputLimit({ maxOutput: 0 })).toBe(0);
    expect(outputLimit(null)).toBe(0);
  });

  it("strips a /v1 suffix — ZCode is given the gateway root", () => {
    expect(zcodeBaseUrl("http://127.0.0.1:20128/v1/")).toBe("http://127.0.0.1:20128");
    expect(zcodeBaseUrl("http://127.0.0.1:20128/")).toBe("http://127.0.0.1:20128");
    expect(zcodeBaseUrl("http://127.0.0.1:20128")).toBe("http://127.0.0.1:20128");
  });

  it("builds an anthropic provider entry with rules for every model", () => {
    const models = [
      { id: "glm/glm-5.3", name: "glm-5.3", vision: false, contextWindow: 1000000, maxOutput: 128000, reasoning: true },
      { id: "claude/claude-sonnet-5", name: "claude-sonnet-5", vision: true, contextWindow: 128000, maxOutput: 32000, reasoning: false },
    ];
    const entry = buildConfigEntry({ format: "anthropic-messages", baseUrl: "http://127.0.0.1:20128", apiKey: "sk", models });
    expect(entry.kind).toBe("anthropic");
    expect(entry.options.baseURL).toBe("http://127.0.0.1:20128");
    expect(entry.models["glm/glm-5.3"].limit).toEqual({ context: 1000000, output: 128000 });
    expect(entry.models["glm/glm-5.3"].reasoning).toEqual({ enabled: true, variants: REASONING_LEVELS, defaultVariant: "medium" });
    expect(entry.models["claude/claude-sonnet-5"].reasoning).toBeUndefined();
    expect(entry.models["claude/claude-sonnet-5"].modalities.input).toContain("image");

    const { rulesDoc, rule } = buildRuleDocs({ rulesDoc: null, format: "anthropic-messages", baseUrl: "http://127.0.0.1:20128", apiKey: "sk", models });
    expect(rulesDoc.schemaVersion).toBe(1);
    expect(rule.config.api).toEqual({ type: "anthropic-messages", baseUrl: "http://127.0.0.1:20128" });
    expect(rule.config.personalModelIds).toEqual(["glm/glm-5.3", "claude/claude-sonnet-5"]);
    const modelRule = rulesDoc.config.modelConfigRules.providerModelRules.find((r) => r.modelId === "glm/glm-5.3");
    expect(modelRule.config.properties.contextWindow).toBe(1000000);
    expect(modelRule.config.properties.inputFormat.supportsImage).toBe(false);
    expect(modelRule.config.optionSpecs.reasoningLevel.values).toEqual(REASONING_LEVELS);
    expect(modelRule.config.optionSpecs.maxOutputTokens.max).toBe(128000);
    expect(hasProviderRule(rulesDoc)).toBe(true);
  });

  it("keeps what the user set by hand in ZCode on re-apply", () => {
    const models = [{ id: "glm/glm-5.3", name: "glm-5.3", vision: false, contextWindow: 1000000, maxOutput: 128000, reasoning: true }];
    const first = buildRuleDocs({ rulesDoc: null, format: DEFAULT_FORMAT, baseUrl: "http://a:1", apiKey: "k1", models });
    const renamed = { ...first.rule, providerName: "My router", extraUserKey: { keep: true } };
    renamed.config.apiHeaders = { "X-Keep": "1" };
    let rules = buildRuleDocs({ rulesDoc: first.rulesDoc, format: DEFAULT_FORMAT, baseUrl: "http://b:2", apiKey: "k2", models });
    // Simulate the user renaming the provider in ZCode before the next apply.
    rules.rulesDoc.config.providerConfigRules.providerRules.splice(0, 1, renamed);
    const second = buildRuleDocs({ rulesDoc: rules.rulesDoc, format: DEFAULT_FORMAT, baseUrl: "http://b:2", apiKey: "k2", models });
    expect(second.rule.providerName).toBe("My router");
    expect(second.rule.extraUserKey).toEqual({ keep: true });
    expect(second.rule.config.apiHeaders).toEqual({ "X-Keep": "1" });
    expect(second.rule.config.api.baseUrl).toBe("http://b:2");
    expect(second.rule.config.access.apiKey).toBe("k2");
    // Another provider's rules and a manual rule survive untouched.
    const withOthers = {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{ providerId: "other", config: {} }, first.rule] },
        modelConfigRules: {
          providerModelRules: [{ providerId: "other", modelId: "x", config: {} }],
          manualProviderModelRules: [{ providerId: "9router", modelId: "glm/glm-5.3", config: {} }],
        },
      },
    };
    const third = buildRuleDocs({ rulesDoc: withOthers, format: DEFAULT_FORMAT, baseUrl: "http://b:2", apiKey: "k2", models });
    const ids = third.rulesDoc.config.providerConfigRules.providerRules.map((r) => r.providerId);
    expect(ids).toEqual(["other", "9router"]);
    expect(third.rulesDoc.config.modelConfigRules.manualProviderModelRules).toHaveLength(1);
  });

  it("reads the user's API format choice and maps config.json kinds", () => {
    const models = [{ id: "m", name: "m", vision: false, contextWindow: 0, maxOutput: 0, reasoning: false }];
    const openai = buildRuleDocs({ rulesDoc: null, format: "openai-chat-completions", baseUrl: "http://a:1", apiKey: "k", models });
    expect(currentFormat(openai.rulesDoc, null)).toBe("openai-chat-completions");
    expect(ZCODE_KINDS["openai-chat-completions"]).toBe("openai-compatible");
    const entry = buildConfigEntry({ format: "openai-responses", baseUrl: "http://a:1", apiKey: "k", models });
    expect(entry.kind).toBe("openai");
    expect(currentFormat(null, { provider: { "9router": { kind: "openai" } } })).toBe("openai-responses");
    expect(currentFormat(null, null)).toBe("anthropic-messages");
    // Unknown context defaults to ZCode's 200000 in config.json.
    expect(entry.models.m.limit.context).toBe(200000);
    expect(entry.models.m.limit.output).toBeUndefined();
  });

  it("keeps an entry ZCode turned off and a hand-set default variant", () => {
    const models = [{ id: "glm/glm-5.3", name: "glm-5.3", vision: false, contextWindow: 1000000, maxOutput: 128000, reasoning: true }];
    const existing = {
      name: "9router",
      kind: "anthropic",
      enabled: false,
      options: { apiKey: "old", baseURL: "http://old:1", customHeader: "keep" },
      models: { "glm/glm-5.3": { reasoning: { defaultVariant: "high" } } },
    };
    const entry = buildConfigEntry({ format: DEFAULT_FORMAT, baseUrl: "http://new:2", apiKey: "new", models, existing });
    expect(entry.enabled).toBe(false);
    expect(entry.options.customHeader).toBe("keep");
    expect(entry.options.baseURL).toBe("http://new:2");
    expect(entry.models["glm/glm-5.3"].reasoning.defaultVariant).toBe("high");
  });

  it("wires, unwires, and writes atomically", async () => {
    const models = [{ id: "m", name: "m", vision: false, contextWindow: 0, maxOutput: 64000, reasoning: false }];
    const built = buildRuleDocs({ rulesDoc: null, format: DEFAULT_FORMAT, baseUrl: "http://a:1", apiKey: "k", models });
    expect(isWired(null, built.rulesDoc)).toBe(true);
    expect(isWired({ provider: { "9router": {} } }, null)).toBe(true);
    expect(isWired({ provider: {} }, { config: {} })).toBe(false);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-test-"));
    try {
      const file = path.join(dir, "provider_config.json");
      await writeAtomic(file, JSON.stringify(built.rulesDoc)); // new file → 0600
      const stat = await fs.stat(file);
      expect(stat.mode & 0o777).toBe(0o600);
      const again = buildRuleDocs({ rulesDoc: built.rulesDoc, format: DEFAULT_FORMAT, baseUrl: "http://a:1", apiKey: "k", models: null });
      const cleaned = removeConfigEntry({ provider: { "9router": { models: {} }, other: {} } });
      expect(cleaned.provider.other).toEqual({});
      expect(cleaned.provider["9router"]).toBeUndefined();
      await writeAtomic(file, JSON.stringify(again.rulesDoc)); // rewrite keeps mode, no .tmp left
      const files = await fs.readdir(dir);
      expect(files).toEqual(["provider_config.json"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
