/**
 * ZCode (Zhipu's desktop coding app) config helpers.
 *
 * ZCode keeps its model providers in two files under its data folder
 * (~/.zcode/v2, or the folder the user moved its data to via dataBaseDir in
 * ~/.zcode/v2/setting.json):
 *
 * - config.json — OpenCode's provider shape with a kind of its own:
 *     {"provider":{"9router":{"name":"9router","kind":"anthropic",
 *       "options":{"apiKey":"…","baseURL":"http://127.0.0.1:20128"},
 *       "enabled":true,"source":"custom",
 *       "models":{"<id>":{"name":…,"limit":{"context":…,"output":…},
 *         "modalities":{"input":[…],"output":["text"]},
 *         "reasoning":{"enabled":true,"variants":[…],"defaultVariant":…}}}}}}
 *   An anthropic provider is asked at baseURL + /v1/messages; an
 *   openai-compatible one at baseURL + /chat/completions; an openai one at
 *   baseURL + /responses. baseURL is therefore the gateway ROOT, not /v1.
 *
 * - provider_config.json — since ZCode 3.14 the file its settings write and
 *   read providers from (config.json is imported once). A provider is a rule
 *   and a model's window, inputs and caps are rules of their own:
 *     {"schemaVersion":1,"config":{
 *       "providerConfigRules":{"providerRules":[{
 *         "providerId":"9router","providerName":"9router","enabled":true,
 *         "config":{"group":"standard-personal",
 *           "access":{"type":"api-key","apiKey":"…"},
 *           "api":{"type":"anthropic-messages","baseUrl":"…"},
 *           "personalModelIds":[…],"modelOrder":[…]}}]},
 *       "modelConfigRules":{
 *         "providerModelRules":[{"providerId":"9router","modelId":…,
 *           "config":{"properties":{"contextWindow":…,
 *             "inputFormat":{"supportsImage":…}}},
 *           "optionSpecs":{"maxOutputTokens":{"max":…},
 *             "reasoningLevel":{"values":[…]}}}],
 *         "manualProviderModelRules":[…]}}}
 *
 * ZCode reads its providers at start-up, so it must be restarted to see a
 * change. Both files are written together, so an older ZCode sees its models
 * too. What the user set by hand in ZCode (a manual rule, a renamed provider)
 * stays. Files are 0600, as ZCode keeps its own.
 */

import fs from "fs/promises";
import path from "path";
import os from "os";

export const ZCODE_PROVIDER_ID = "9router";

// ZCode's API formats in provider_config.json (api.type) and the kind each is
// in config.json, as ZCode maps one to the other.
export const ZCODE_KINDS = {
  "anthropic-messages": "anthropic",
  "openai-chat-completions": "openai-compatible",
  "openai-responses": "openai",
};

export const DEFAULT_FORMAT = "anthropic-messages";
// Some vendors report their context window as the output limit; ZCode would
// offer that much, so cap what we write.
const MAX_OUTPUT_CAP = 128000;
// Written where the real context window is unknown; ZCode's own default.
export const DEFAULT_CONTEXT = 200000;
// Reasoning levels ZCode offers when a model takes a reasoning effort;
// "disabled" turns thinking off, the rest go out as the effort.
export const REASONING_LEVELS = ["disabled", "low", "medium", "high"];
const DEFAULT_REASONING_LEVEL = "medium";

const isRooted = (p) => typeof p === "string" && path.isAbsolute(p);

/**
 * ZCode, a Node app, reads its HOME first (process.env.HOME) on every OS:
 * on Windows a HOME the user set for Git Bash / MSYS2 wins, where
 * os.homedir() reports USERPROFILE. Mirror that choice.
 */
export function zcodeHome() {
  let home = os.homedir();
  if (process.platform === "win32") {
    const envHome = (process.env.HOME || "").trim();
    const userProfile = process.env.USERPROFILE || "";
    if (isRooted(envHome) && (!userProfile || path.resolve(envHome) !== path.resolve(userProfile))) {
      home = envHome;
    }
  }
  return home;
}

/**
 * Folder ZCode keeps its .zcode data in: the home folder, unless the user
 * moved it in ZCode's settings — the choice stays in the home folder's
 * .zcode/v2/setting.json as an absolute dataBaseDir, which ZCode's main
 * process reads before anything else. A value that isn't absolute is ignored,
 * as ZCode ignores one.
 */
export async function zcodeBaseDir(home = zcodeHome()) {
  try {
    const raw = await fs.readFile(path.join(home, ".zcode", "v2", "setting.json"), "utf8");
    const setting = JSON.parse(raw);
    const dir = typeof setting?.dataBaseDir === "string" ? setting.dataBaseDir.trim() : "";
    if (isRooted(dir)) return dir;
  } catch {
    // no setting.json, or unreadable — the data lives at home
  }
  return home;
}

export async function zcodeConfigPaths(home = zcodeHome()) {
  const base = await zcodeBaseDir(home);
  const dir = path.join(base, ".zcode", "v2");
  return {
    dir,
    dataBaseDir: base,
    configPath: path.join(dir, "config.json"),
    rulesPath: path.join(dir, "provider_config.json"),
  };
}

const readJsonDoc = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const objAt = (parent, key) => {
  if (!isObject(parent[key])) parent[key] = {};
  return parent[key];
};

const listAt = (parent, key) => {
  if (!Array.isArray(parent[key])) parent[key] = [];
  return parent[key];
};

/** provider_config.json has the 9router provider rule? */
export function hasProviderRule(rulesDoc, providerId = ZCODE_PROVIDER_ID) {
  const rules = rulesDoc?.config?.providerConfigRules?.providerRules;
  return Array.isArray(rules) && rules.some((r) => r?.providerId === providerId);
}

/** config.json has the 9router provider entry? */
export function hasConfigEntry(configDoc, providerId = ZCODE_PROVIDER_ID) {
  return isObject(configDoc?.provider?.[providerId]);
}

/** Whether anything of 9router's is wired into ZCode's files. */
export function isWired(configDoc, rulesDoc, providerId = ZCODE_PROVIDER_ID) {
  return hasConfigEntry(configDoc, providerId) || hasProviderRule(rulesDoc, providerId);
}

/**
 * The API format the user picked in ZCode's provider settings, else the
 * default. Both files are written together, so where they differ the user
 * changed one of them in ZCode — the provider_config.json rule wins when it
 * names a format ZCode knows (it is the file ZCode's own settings write).
 */
export function currentFormat(rulesDoc, configDoc, providerId = ZCODE_PROVIDER_ID) {
  const ruleType = rulesDoc?.config?.providerConfigRules?.providerRules
    ?.find((r) => r?.providerId === providerId)?.config?.api?.type;
  if (ruleType && ZCODE_KINDS[ruleType]) return ruleType;
  const kind = configDoc?.provider?.[providerId]?.kind;
  for (const [format, formatKind] of Object.entries(ZCODE_KINDS)) {
    if (formatKind === kind) return format;
  }
  return DEFAULT_FORMAT;
}

/** The default reasoning variant each of 9router's models has in config.json. */
function keptVariants(configDoc, providerId = ZCODE_PROVIDER_ID) {
  const models = configDoc?.provider?.[providerId]?.models;
  const out = {};
  if (isObject(models)) {
    for (const [id, m] of Object.entries(models)) {
      const variant = m?.reasoning?.defaultVariant;
      if (typeof variant === "string" && variant) out[id] = variant;
    }
  }
  return out;
}

/** ZCode caps every reply at 32000 tokens where no output limit is written. */
export function outputLimit(caps) {
  const out = Number.isFinite(caps?.maxOutput) && caps.maxOutput > 0 ? Math.min(caps.maxOutput, MAX_OUTPUT_CAP) : 0;
  return out;
}

/**
 * 9router's provider entry for ZCode's config.json. An entry turned off in
 * ZCode stays off; the user's extra keys and a model's hand-set default
 * reasoning variant are kept.
 */
export function buildConfigEntry({ format, baseUrl, apiKey, models, existing, enabled }) {
  const was = isObject(existing) ? existing : {};
  const wasOptions = isObject(was.options) ? was.options : {};
  const variants = keptVariants({ provider: { [ZCODE_PROVIDER_ID]: was } });

  const builtModels = {};
  for (const m of models) {
    const entry = {
      name: m.name || m.id,
      limit: { context: m.contextWindow > 0 ? m.contextWindow : DEFAULT_CONTEXT },
      modalities: { input: m.vision ? ["text", "image"] : ["text"], output: ["text"] },
    };
    if (outputLimit(m) > 0) entry.limit.output = outputLimit(m);
    if (m.reasoning) {
      const fallback = variants[m.id];
      entry.reasoning = {
        enabled: true,
        variants: REASONING_LEVELS,
        defaultVariant: REASONING_LEVELS.includes(fallback) ? fallback : DEFAULT_REASONING_LEVEL,
      };
    }
    builtModels[m.id] = entry;
  }

  return {
    ...was,
    name: typeof was.name === "string" && was.name.trim() ? was.name : ZCODE_PROVIDER_ID,
    kind: ZCODE_KINDS[format] || ZCODE_KINDS[DEFAULT_FORMAT],
    enabled: typeof enabled === "boolean" ? enabled : was.enabled !== false,
    source: "custom",
    options: { ...wasOptions, apiKey, baseURL: baseUrl },
    models: builtModels,
  };
}

/**
 * 9router's provider rule and model rules for ZCode's provider_config.json.
 * Every other provider's rules, and rules the user set by hand in ZCode
 * (manualProviderModelRules), are kept as ZCode wrote them.
 */
export function buildRuleDocs({ rulesDoc, format, baseUrl, apiKey, models, providerId = ZCODE_PROVIDER_ID }) {
  const doc = isObject(rulesDoc) ? rulesDoc : {};
  if (doc.schemaVersion == null) doc.schemaVersion = 1;
  const config = objAt(doc, "config");
  const pcr = objAt(config, "providerConfigRules");
  const mcr = objAt(config, "modelConfigRules");

  const mine = (r) => isObject(r) && r.providerId === providerId;

  const oldRules = listAt(pcr, "providerRules");
  const others = oldRules.filter((r) => !mine(r));
  const old = oldRules.find(mine) || null;
  const at = oldRules.indexOf(old);

  const manual = listAt(mcr, "manualProviderModelRules");
  // A model the user configured by hand in ZCode: its own rule stands, and
  // ours for it is not rewritten.
  const byHand = new Set(manual.filter(mine).map((r) => r.modelId));
  const providerModels = listAt(mcr, "providerModelRules").filter((r) => !mine(r));

  let rule = null;
  if (models) {
    for (const m of models) {
      if (byHand.has(m.id)) continue;
      const properties = {
        ...(m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
        inputFormat: { supportsImage: !!m.vision },
      };
      const optionSpecs = {
        ...(outputLimit(m) > 0 ? { maxOutputTokens: { max: outputLimit(m) } } : {}),
        ...(m.reasoning ? { reasoningLevel: { values: REASONING_LEVELS } } : {}),
      };
      providerModels.push({
        providerId,
        modelId: m.id,
        config: {
          properties,
          ...(Object.keys(optionSpecs).length > 0 ? { optionSpecs } : {}),
        },
      });
    }

    const ids = models.map((m) => m.id);
    const ruleConfig = {
      group: "standard-personal",
      access: { type: "api-key", apiKey },
      api: { type: format, baseUrl },
      personalModelIds: ids,
      modelOrder: ids,
    };
    rule = { providerId, providerName: providerId, enabled: true, config: ruleConfig };
    // What the user set on it in ZCode stays: its name, and every key of the
    // old rule and old config we don't own ourselves (logo, visibility, a
    // header, the key's management link). The address, key, format and model
    // lists are ours.
    if (isObject(old)) {
      if (typeof old.providerName === "string" && old.providerName.trim()) {
        rule.providerName = old.providerName;
      }
      const oldConfig = isObject(old.config) ? old.config : {};
      const ours = new Set(["group", "access", "api", "personalModelIds", "modelOrder"]);
      const kept = {};
      for (const [k, v] of Object.entries(oldConfig)) {
        if (!ours.has(k)) kept[k] = v;
      }
      rule.config = { ...kept, ...ruleConfig };
      for (const [k, v] of Object.entries(old)) {
        if (k !== "config" && !(k in rule)) rule[k] = v;
      }
      if (typeof old.enabled === "boolean") rule.enabled = old.enabled;
    }
  }

  const next = { ...doc };
  next.config = {
    ...config,
    providerConfigRules: { ...pcr, providerRules: others },
    modelConfigRules: { ...mcr, providerModelRules: providerModels, manualProviderModelRules: manual },
  };
  if (rule) {
    const rules = next.config.providerConfigRules.providerRules;
    if (at >= 0 && at <= rules.length) rules.splice(at, 0, rule);
    else rules.push(rule);
  }
  return { rulesDoc: next, rule };
}

/** Remove 9router's entry from config.json, leaving every other key as it was. */
export function removeConfigEntry(configDoc, providerId = ZCODE_PROVIDER_ID) {
  if (!isObject(configDoc?.provider) || !isObject(configDoc.provider[providerId])) return configDoc;
  const next = { ...configDoc, provider: { ...configDoc.provider } };
  delete next.provider[providerId];
  if (Object.keys(next.provider).length === 0) delete next.provider;
  return next;
}

/** Atomic write: temp file in the same folder, then rename over the target.
 *  A new file is private (0600); an existing one keeps its mode. */
export async function writeAtomic(file, contents, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), "." + path.basename(file) + ".tmp");
  let m = mode;
  if (m == null) {
    try {
      m = (await fs.stat(file)).mode & 0o777;
    } catch {
      m = 0o600;
    }
  }
  // writeFile applies the mode only at creation, and the process umask (often
  // 0002) strips group/other bits from it — chmod after the write so a file
  // ZCode keeps private (0600) stays private across a rewrite.
  await fs.writeFile(tmp, contents, { mode: m });
  if (m != null) {
    try {
      await fs.chmod(tmp, m);
    } catch {
      // best effort — the write itself already succeeded
    }
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Strip a trailing /v1 — ZCode is given the gateway ROOT and appends the
 *  rest itself (/v1/messages, /chat/completions, /responses). */
export function zcodeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "") || "http://127.0.0.1:20128";
}

// Kept for the route: read either file without throwing.
export async function readZcodeFile(file) {
  return fs.readFile(file, "utf8").catch(() => null);
}

export { readJsonDoc };
