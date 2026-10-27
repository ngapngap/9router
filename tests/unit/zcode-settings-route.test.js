import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";

let fakeHome, movedData, mod;

const v2Dir = () => path.join(movedData, ".zcode", "v2");
const readRules = async () => JSON.parse(await fs.readFile(path.join(v2Dir(), "provider_config.json"), "utf8"));
const readCfg = async () => JSON.parse(await fs.readFile(path.join(v2Dir(), "config.json"), "utf8"));
const jsonOf = async (res) => ({ status: res.status, body: await res.json() });

beforeAll(async () => {
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-home-"));
  movedData = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-moved-"));

  // ZCode moved its data folder: dataBaseDir in the home folder's setting.json
  await fs.mkdir(path.join(fakeHome, ".zcode", "v2"), { recursive: true });
  await fs.writeFile(path.join(fakeHome, ".zcode", "v2", "setting.json"), JSON.stringify({ dataBaseDir: movedData }));

  // Pre-existing state: another provider's rule and a hand-set model rule
  await fs.mkdir(v2Dir(), { recursive: true });
  await fs.writeFile(path.join(v2Dir(), "provider_config.json"), JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{ providerId: "other", enabled: true, config: { group: "standard-personal", access: { type: "api-key", apiKey: "o" }, api: { type: "anthropic-messages", baseUrl: "http://x" }, personalModelIds: ["x"] } }] },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [{ providerId: "9router", modelId: "glm/glm-5.3", config: { properties: { contextWindow: 5 } } }],
      },
    },
  }), { mode: 0o600 }); // ZCode keeps this file private
  await fs.writeFile(path.join(v2Dir(), "config.json"), JSON.stringify({ provider: { other: { name: "other" } } }), { mode: 0o600 });

  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  mod = await import("@/app/api/cli-tools/zcode-settings/route.js");
});

afterAll(async () => {
  await fs.rm(fakeHome, { recursive: true, force: true });
  await fs.rm(movedData, { recursive: true, force: true });
});

describe("zcode-settings route", () => {
  it("reports ZCode installed but not wired before applying", async () => {
    const { status, body } = await jsonOf(await mod.GET());
    expect(status).toBe(200);
    expect(body.installed).toBe(true);
    expect(body.has9Router).toBe(false);
    expect(body.zcode.dataBaseDir).toBe(movedData);
  });

  it("applies 9router into both files, keeping what ZCode owns", async () => {
    const req = { json: async () => ({
      baseUrl: "http://127.0.0.1:20128/v1/",
      apiKey: "sk-test-123",
      models: ["glm/glm-5.3", "cc/claude-sonnet-5"],
      format: "anthropic-messages",
    }) };
    const { status, body } = await jsonOf(await mod.POST(req));
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const rules = await readRules();
    const rule = rules.config.providerConfigRules.providerRules.find((r) => r.providerId === "9router");
    // /v1 stripped — ZCode appends /v1/messages itself
    expect(rule.config.api.baseUrl).toBe("http://127.0.0.1:20128");
    expect(rule.config.api.type).toBe("anthropic-messages");
    expect(rule.config.personalModelIds).toEqual(["glm/glm-5.3", "cc/claude-sonnet-5"]);
    // another provider's rule and the user's hand-set rule survive
    expect(rules.config.providerConfigRules.providerRules.some((r) => r.providerId === "other")).toBe(true);
    expect(rules.config.modelConfigRules.manualProviderModelRules).toHaveLength(1);
    // no rule of ours for a hand-set model — its own stands
    const ours = rules.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === "9router");
    expect(ours.some((r) => r.modelId === "glm/glm-5.3")).toBe(false);
    expect(ours.some((r) => r.modelId === "cc/claude-sonnet-5")).toBe(true);

    const cfg = await readCfg();
    const entry = cfg.provider["9router"];
    expect(entry.kind).toBe("anthropic");
    expect(entry.options.baseURL).toBe("http://127.0.0.1:20128");
    expect(entry.options.apiKey).toBe("sk-test-123");
    expect(entry.models["glm/glm-5.3"].limit.context).toBe(1000000);
    expect(entry.models["glm/glm-5.3"].reasoning.defaultVariant).toBe("medium");
    expect(entry.models["cc/claude-sonnet-5"].modalities.input).toContain("image");
    expect(cfg.provider.other).toEqual({ name: "other" });
    // ZCode keeps these files private
    const mode = fsSync.statSync(path.join(v2Dir(), "provider_config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reads back the wiring", async () => {
    const { body } = await jsonOf(await mod.GET());
    expect(body.has9Router).toBe(true);
    expect(body.zcode.format).toBe("anthropic-messages");
    expect(body.zcode.baseURL).toBe("http://127.0.0.1:20128");
    expect(body.zcode.models).toEqual(["glm/glm-5.3", "cc/claude-sonnet-5"]);
  });

  it("removes a single model on ?model=", async () => {
    const { body } = await jsonOf(await mod.DELETE({ url: "http://localhost/x?model=cc%2Fclaude-sonnet-5" }));
    expect(body.success).toBe(true);
    const rules = await readRules();
    const rule = rules.config.providerConfigRules.providerRules.find((r) => r.providerId === "9router");
    expect(rule.config.personalModelIds).toEqual(["glm/glm-5.3"]);
    const ours = rules.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === "9router");
    expect(ours.some((r) => r.modelId === "cc/claude-sonnet-5")).toBe(false);
  });

  it("resets fully and leaves every other provider as it was", async () => {
    const { body } = await jsonOf(await mod.DELETE({ url: "http://localhost/x" }));
    expect(body.success).toBe(true);
    const rules = await readRules();
    expect(rules.config.providerConfigRules.providerRules.some((r) => r.providerId === "9router")).toBe(false);
    expect(rules.config.providerConfigRules.providerRules.some((r) => r.providerId === "other")).toBe(true);
    const cfg = await readCfg();
    expect(cfg.provider["9router"]).toBeUndefined();
    expect(cfg.provider.other).toEqual({ name: "other" });
  });

  it("refuses a body without models", async () => {
    const req = { json: async () => ({ baseUrl: "http://127.0.0.1:20128", apiKey: "", models: [] }) };
    const { status } = await jsonOf(await mod.POST(req));
    expect(status).toBe(400);
  });

  it("refuses an unknown format", async () => {
    const req = { json: async () => ({ baseUrl: "http://127.0.0.1:20128", apiKey: "", models: ["glm/glm-5.3"], format: "grpc" }) };
    const { status } = await jsonOf(await mod.POST(req));
    expect(status).toBe(400);
  });
});
