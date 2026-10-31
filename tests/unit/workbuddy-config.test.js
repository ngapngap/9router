import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  WORKBUDDY_VENDOR,
  buildWorkbuddyEntry,
  ourEntries,
  workbuddyPaths,
  workbuddyRead,
  workbuddyWired,
  writeWorkbuddyModels,
} from "../../src/lib/workbuddyConfig.js";

const URL = "http://127.0.0.1:20128/v1/chat/completions";
const KEY = "sk-test";
const model = (over = {}) => ({
  id: "glm/glm-5.3",
  name: "glm-5.3",
  vision: false,
  contextWindow: 200000,
  maxOutput: 128000,
  reasoning: true,
  ...over,
});

let home;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-test-"));
  delete process.env.WORKBUDDY_CONFIG_DIR;
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  delete process.env.WORKBUDDY_CONFIG_DIR;
});

describe("WorkBuddy models.json", () => {
  it("writes a new file as a bare list with the entry WorkBuddy asks for", async () => {
    const { modelsPath } = workbuddyPaths("workbuddy", home);
    await writeWorkbuddyModels({ build: "workbuddy", url: URL, apiKey: KEY, models: [model()], home });
    const doc = JSON.parse(await fs.readFile(modelsPath, "utf8"));
    expect(Array.isArray(doc)).toBe(true);
    expect(doc).toHaveLength(1);
    expect(doc[0]).toMatchObject({
      id: "glm/glm-5.3",
      vendor: WORKBUDDY_VENDOR,
      apiKey: KEY,
      url: URL,
      maxInputTokens: 200000,
      maxOutputTokens: 128000,
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
    });
    expect(doc[0].reasoning).toEqual({
      supportedEfforts: ["low", "medium", "high"],
      canDisableThinking: true,
      defaultEffort: "medium",
    });
    expect(await workbuddyWired("workbuddy", home)).toBe(true);
  });

  it("keeps the app's other entries, the slot ours sat in, and the rest of an object file", async () => {
    const { modelsPath } = workbuddyPaths("workbuddy", home);
    const own = { id: "llama-local", name: "Llama", vendor: "Local", local: true };
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    await fs.writeFile(modelsPath, JSON.stringify({
      models: [
        { id: "old/mine", vendor: WORKBUDDY_VENDOR, apiKey: KEY, url: "http://old/v1/chat/completions" },
        own,
      ],
      availableModels: ["old/mine", "llama-local"],
      other: true,
    }));
    await writeWorkbuddyModels({ build: "workbuddy", url: URL, apiKey: KEY, models: [model()], home });

    const doc = JSON.parse(await fs.readFile(modelsPath, "utf8"));
    expect(doc.other).toBe(true);
    expect(doc.models[0].id).toBe("glm/glm-5.3"); // our slot, first as before
    expect(doc.models[1]).toEqual(own);
    expect(doc.availableModels).toEqual(["llama-local", "glm/glm-5.3"]);
  });

  it("keeps a model turned off in WorkBuddy and a default effort it still offers", async () => {
    const existing = {
      id: "glm/glm-5.3",
      vendor: WORKBUDDY_VENDOR,
      apiKey: KEY,
      url: URL,
      disabled: true,
      reasoning: { supportedEfforts: ["low", "medium", "high"], defaultEffort: "high" },
      handSet: "kept",
    };
    const entry = buildWorkbuddyEntry({ model: model(), url: URL, apiKey: KEY, existing });
    expect(entry.disabled).toBe(true);
    expect(entry.reasoning.defaultEffort).toBe("high");
    expect(entry.handSet).toBe("kept");

    // An effort the model no longer offers falls back to ours; "" is Auto.
    const stale = buildWorkbuddyEntry({ model: model(), url: URL, apiKey: KEY, existing: { reasoning: { defaultEffort: "max" } } });
    expect(stale.reasoning.defaultEffort).toBe("medium");
    const auto = buildWorkbuddyEntry({ model: model(), url: URL, apiKey: KEY, existing: { reasoning: { defaultEffort: "" } } });
    expect(auto.reasoning).not.toHaveProperty("defaultEffort");

    const plain = buildWorkbuddyEntry({ model: model({ reasoning: false, vision: true, maxOutput: 0 }), url: URL, apiKey: KEY });
    expect(plain.supportsReasoning).toBe(false);
    expect(plain.supportsImages).toBe(true);
    expect(plain).not.toHaveProperty("maxOutputTokens");
  });

  it("takes ours out with models: null and leaves everything else", async () => {
    const { modelsPath } = workbuddyPaths("workbuddy", home);
    const own = { id: "llama-local", name: "Llama", vendor: "Local" };
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    await fs.writeFile(modelsPath, JSON.stringify([
      { id: "glm/glm-5.3", vendor: WORKBUDDY_VENDOR, apiKey: KEY, url: URL },
      own,
      { id: "renamed", vendor: "Custom", apiKey: KEY, url: URL }, // ours by its key after an edit in WorkBuddy
    ]));
    const result = await writeWorkbuddyModels({ build: "workbuddy", url: "", apiKey: KEY, models: null, home });
    expect(result.changed).toBe(true);
    expect(JSON.parse(await fs.readFile(modelsPath, "utf8"))).toEqual([own]);
    expect(await workbuddyWired("workbuddy", home)).toBe(false);
  });

  it("reads both builds' own folders and honours WORKBUDDY_CONFIG_DIR for the CN build only", async () => {
    const cnDir = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-env-"));
    process.env.WORKBUDDY_CONFIG_DIR = cnDir;
    expect(workbuddyPaths("workbuddy", home).modelsPath).toBe(path.join(cnDir, "models.json"));
    expect(workbuddyPaths("workbuddy-ai", home).modelsPath).toBe(path.join(home, ".workbuddy-ai", "models.json"));

    await writeWorkbuddyModels({ build: "workbuddy-ai", url: URL, apiKey: KEY, models: [model()], home });
    const ai = await workbuddyRead(workbuddyPaths("workbuddy-ai", home).modelsPath);
    expect(ourEntries(ai).map((e) => e.id)).toEqual(["glm/glm-5.3"]);
    const cn = await workbuddyRead(path.join(cnDir, "models.json"));
    expect(ourEntries(cn)).toEqual([]);
    await fs.rm(cnDir, { recursive: true, force: true });
  });

  it("refuses to rewrite a models.json that is not valid JSON", async () => {
    const { modelsPath } = workbuddyPaths("workbuddy", home);
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    await fs.writeFile(modelsPath, "not json");
    await expect(
      writeWorkbuddyModels({ build: "workbuddy", url: URL, apiKey: KEY, models: [model()], home }),
    ).rejects.toThrow(/not valid JSON/);
  });
});
