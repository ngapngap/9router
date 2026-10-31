/**
 * WorkBuddy (Tencent's CodeBuddy desktop app) models.json helpers.
 *
 * WorkBuddy keeps its custom models in ~/.workbuddy/models.json — a bare
 * list of OpenAI chat-completions models, or {"models":[…],"availableModels":[…]}
 * as CodeBuddy Code's CLI writes it. An entry is asked at its "url" for
 * model "id", under "Bearer <apiKey>", with reasoning_effort when it
 * supportsReasoning:
 *
 *   {"id":"glm/glm-5.3","name":…,"vendor":"9router","apiKey":"…",
 *    "url":"http://127.0.0.1:20128/v1/chat/completions",
 *    "maxInputTokens":…,"maxOutputTokens":…,
 *    "supportsToolCall":true,"supportsImages":…,"supportsReasoning":…,
 *    "reasoning":{"supportedEfforts":[…],"canDisableThinking":…,"defaultEffort":…}}
 *
 * WorkBuddy AI, the international build, is the same app with its data in
 * ~/.workbuddy-ai. WORKBUDDY_CONFIG_DIR moves the Chinese build's folder
 * only (the AI build's cli/product.json carries its dataFolderName).
 *
 * WorkBuddy rewrites models.json itself seconds after every start (it
 * purges local models the computer can't run and saves the file again),
 * so a rewrite by the app is normal; ours keeps every other entry as the
 * app wrote it, keeps where ours sat, a model turned off in WorkBuddy off,
 * and a default effort the user picked there while the model still has it.
 */

import fs from "fs/promises";
import path from "path";
import os from "os";

export const WORKBUDDY_VENDOR = "9router";
export const WORKBUDDY_BUILDS = {
  workbuddy: {
    id: "workbuddy",
    name: "WorkBuddy",
    dirName: ".workbuddy",
    envVar: "WORKBUDDY_CONFIG_DIR",
  },
  "workbuddy-ai": {
    id: "workbuddy-ai",
    name: "WorkBuddy AI",
    dirName: ".workbuddy-ai",
    envVar: null,
  },
};

// Reasoning efforts WorkBuddy's picker offers; "none" (thinking off) is
// reported as canDisableThinking, not as an effort.
export const WORKBUDDY_EFFORTS = ["low", "medium", "high"];
const DEFAULT_EFFORT = "medium";
// Without maxInputTokens WorkBuddy falls back to a small window of its own.
const DEFAULT_CONTEXT = 200000;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The file as this helper reads it, for routes that only show it.
export { readDoc as workbuddyRead };

export function workbuddyBuilds() {
  return Object.values(WORKBUDDY_BUILDS);
}

/** The folder one build keeps its models.json in. */
export function workbuddyDir(build, home = os.homedir()) {
  const site = WORKBUDDY_BUILDS[build] || WORKBUDDY_BUILDS.workbuddy;
  if (site.envVar) {
    const envDir = (process.env[site.envVar] || "").trim();
    if (path.isAbsolute(envDir)) return envDir;
  }
  return path.join(home, site.dirName);
}

export function workbuddyPaths(build, home = os.homedir()) {
  const dir = workbuddyDir(build, home);
  return { dir, modelsPath: path.join(dir, "models.json") };
}

const readDoc = async (file) => {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { exists: false, models: [], rest: null };
  }
  const text = raw.trim();
  if (!text) return { exists: true, models: [], rest: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error(file + " is not valid JSON");
    error.status = 409;
    throw error;
  }
  if (Array.isArray(parsed)) return { exists: true, models: parsed, rest: null };
  if (isObject(parsed)) {
    return { exists: true, models: Array.isArray(parsed.models) ? parsed.models : [], rest: parsed };
  }
  return { exists: true, models: [], rest: null };
};

const isOurs = (entry, apiKeys = null) => {
  if (!isObject(entry)) return false;
  if (entry.vendor === WORKBUDDY_VENDOR) return true;
  // WorkBuddy's model settings save an edited entry under the vendor of the
  // provider it matches ("Custom"): still ours by its key.
  return Boolean(apiKeys && entry.apiKey && apiKeys.has(entry.apiKey));
};

/** Whether anything of 9router's is in one build's models.json. */
export async function workbuddyWired(build, home = os.homedir()) {
  const { modelsPath } = workbuddyPaths(build, home);
  const doc = await readDoc(modelsPath);
  return doc.models.some((m) => isOurs(m));
}

/** 9router's entries of one build's models.json, as the card shows them. */
export function ourEntries(doc) {
  return doc.models.filter((m) => isOurs(m));
}

/**
 * One 9router model as a models.json entry. "models" items carry
 * {id, name, vision, contextWindow, maxOutput, reasoning}.
 */
export function buildWorkbuddyEntry({ model, url, apiKey, existing = null }) {
  const was = isObject(existing) ? existing : {};
  const context = Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : DEFAULT_CONTEXT;
  const entry = {
    id: model.id,
    name: model.name || model.id,
    vendor: WORKBUDDY_VENDOR,
    apiKey,
    url,
    maxInputTokens: context,
    supportsToolCall: true,
    supportsImages: Boolean(model.vision),
    supportsReasoning: false,
  };
  if (Number.isFinite(model.maxOutput) && model.maxOutput > 0) {
    entry.maxOutputTokens = model.maxOutput;
  }
  if (model.reasoning) {
    entry.supportsReasoning = true;
    entry.reasoning = {
      supportedEfforts: [...WORKBUDDY_EFFORTS],
      canDisableThinking: true,
      defaultEffort: DEFAULT_EFFORT,
    };
    // A default effort set in WorkBuddy's model settings stays while the
    // model still offers it; an empty one is its "Auto" (no default).
    const wasEffort = was.reasoning?.defaultEffort ?? was.reasoning?.effort;
    if (wasEffort === "") delete entry.reasoning.defaultEffort;
    else if (wasEffort && WORKBUDDY_EFFORTS.includes(wasEffort)) {
      entry.reasoning.defaultEffort = wasEffort;
    }
  }
  // A model turned off in WorkBuddy stays off.
  if (was.disabled === true) entry.disabled = true;
  // Anything else the user or the app set on the entry is kept.
  return { ...was, ...entry };
}

/**
 * Put 9router's models into one build's models.json (or take them out with
 * models: null), leaving every other entry and the rest of the file as
 * WorkBuddy wrote it. Ours keep the place in the list they already had.
 */
export async function writeWorkbuddyModels({ build, url, apiKey, models, home = os.homedir() }) {
  const site = WORKBUDDY_BUILDS[build] || WORKBUDDY_BUILDS.workbuddy;
  const { modelsPath } = workbuddyPaths(build, home);
  const doc = await readDoc(modelsPath);

  // Keys ours may carry: the one we write, and one the user pointed at a
  // 9router on another machine (kept, as ZCode's address is).
  const keys = new Set([apiKey]);
  const kept = [];
  const previous = new Map();
  let at = -1;
  for (const entry of doc.models) {
    if (isOurs(entry, keys) || isOurs(entry)) {
      if (at < 0) at = kept.length;
      if (entry.apiKey) keys.add(entry.apiKey);
      previous.set(entry.id, entry);
      continue;
    }
    kept.push(entry);
  }

  const add = [];
  const ids = [];
  if (models) {
    for (const model of models) {
      add.push(buildWorkbuddyEntry({ model, url, apiKey, existing: previous.get(model.id) }));
      ids.push(model.id);
    }
  }
  if (!models && previous.size === 0) return { modelsPath, changed: false, ids: [] };
  if (at < 0) at = kept.length;
  const next = [...kept.slice(0, at), ...add, ...kept.slice(at)];

  let out;
  if (doc.rest) {
    const rest = { ...doc.rest };
    // A list of the models to show keeps showing ours.
    if (Array.isArray(rest.availableModels) && rest.availableModels.length > 0) {
      const oldIds = [...previous.keys()];
      rest.availableModels = [
        ...rest.availableModels.filter((id) => !oldIds.includes(id)),
        ...ids,
      ];
    }
    rest.models = next;
    out = rest;
  } else {
    // A new file is a bare list, as WorkBuddy itself writes one.
    out = next;
  }

  await fs.mkdir(path.dirname(modelsPath), { recursive: true });
  const body = JSON.stringify(out, null, 2) + "\n";
  let mode = 0o600;
  try {
    mode = (await fs.stat(modelsPath)).mode & 0o777;
  } catch {
    // new file — private, as WorkBuddy's own store is
  }
  const tmp = modelsPath + ".9router-tmp";
  await fs.writeFile(tmp, body, { mode });
  await fs.rename(tmp, modelsPath);
  return { modelsPath, changed: true, ids, site };
}
