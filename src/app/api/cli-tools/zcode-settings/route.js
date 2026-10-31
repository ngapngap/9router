"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import {
  ZCODE_KINDS,
  DEFAULT_FORMAT,
  buildConfigEntry,
  buildRuleDocs,
  currentFormat,
  hasProviderRule,
  isWired,
  readZcodeFile,
  removeConfigEntry,
  writeAtomic,
  zcodeBaseUrl,
  zcodeConfigPaths,
} from "@/lib/zcodeConfig.js";
import fs from "fs/promises";

// ZCode is a desktop app, not a CLI on PATH: detection is its data folder
// (~/.zcode, wherever the user moved it), like magpie's directory check.
async function checkZcodeInstalled(paths) {
  try {
    await fs.access(paths.dir);
    return true;
  } catch {
    return false;
  }
}

// GET - Check ZCode's data folder and read current wiring
export async function GET() {
  try {
    const paths = await zcodeConfigPaths();
    const installed = await checkZcodeInstalled(paths);
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        has9Router: false,
        configPath: paths.rulesPath,
        zcode: null,
        message: "ZCode data folder not found",
      });
    }

    const [rulesRaw, configRaw] = await Promise.all([
      readZcodeFile(paths.rulesPath),
      readZcodeFile(paths.configPath),
    ]);
    // provider_config.json is what ZCode's own settings write (3.14+); it is
    // the file surfaced here. config.json backs older ZCode versions.
    let rulesDoc = null;
    try {
      rulesDoc = rulesRaw != null ? JSON.parse(rulesRaw) : null;
    } catch {
      return NextResponse.json(
        { error: "provider_config.json is not valid JSON — fix or remove it, then retry" },
        { status: 409 },
      );
    }
    let configDoc = null;
    try {
      configDoc = configRaw != null ? JSON.parse(configRaw) : null;
    } catch {
      return NextResponse.json(
        { error: "config.json is not valid JSON — fix or remove it, then retry" },
        { status: 409 },
      );
    }

    const format = currentFormat(rulesDoc, configDoc);
    const entry = configDoc?.provider?.["9router"] || null;
    const rule = rulesDoc?.config?.providerConfigRules?.providerRules?.find((r) => r?.providerId === "9router") || null;

    return NextResponse.json({
      installed: true,
      config: rulesDoc || configDoc || {},
      has9Router: isWired(configDoc, rulesDoc),
      configPath: paths.rulesPath,
      zcode: {
        format,
        baseURL: rule?.config?.api?.baseUrl || entry?.options?.baseURL || null,
        models: rule?.config?.personalModelIds || Object.keys(entry?.models || {}),
        dataBaseDir: paths.dataBaseDir,
      },
    });
  } catch (error) {
    console.log("Error checking zcode settings:", error);
    return NextResponse.json({ error: "Failed to check zcode settings" }, { status: 500 });
  }
}

// POST - Apply 9Router as a ZCode provider (writes both config files)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, format } = await request.json();

    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }
    const apiFormat = format && ZCODE_KINDS[format] ? format : null;
    if (format && !apiFormat) {
      return NextResponse.json(
        { error: "format must be one of: " + Object.keys(ZCODE_KINDS).join(", ") },
        { status: 400 },
      );
    }

    const { getCapabilitiesForModel } = await import("open-sse/providers/capabilities.js");

    // UI model values are "alias/model-id" ("glm/glm-5.3"); the same string
    // stays the model id on the wire, so the gateway resolves the prefix.
    const seen = new Set();
    const modelEntries = [];
    for (const value of modelsArray) {
      if (!value || typeof value !== "string" || seen.has(value)) continue;
      seen.add(value);
      const slashAt = value.indexOf("/");
      const provider = slashAt > 0 ? value.slice(0, slashAt) : "";
      const modelId = slashAt > 0 ? value.slice(slashAt + 1) : value;
      const caps = getCapabilitiesForModel(provider, modelId);
      modelEntries.push({
        id: value,
        name: modelId,
        vision: !!caps.vision,
        contextWindow: Number.isFinite(caps.contextWindow) ? caps.contextWindow : 0,
        maxOutput: Number.isFinite(caps.maxOutput) ? caps.maxOutput : 0,
        reasoning: !!caps.reasoning,
      });
    }

    const paths = await zcodeConfigPaths();
    await fs.mkdir(paths.dir, { recursive: true });

    const [rulesRaw, configRaw] = await Promise.all([
      readZcodeFile(paths.rulesPath),
      readZcodeFile(paths.configPath),
    ]);
    let rulesDoc = null;
    let configDoc = null;
    try {
      rulesDoc = rulesRaw != null ? JSON.parse(rulesRaw) : null;
      configDoc = configRaw != null ? JSON.parse(configRaw) : null;
    } catch {
      return NextResponse.json(
        { error: "A ZCode config file is not valid JSON — fix or remove it, then retry" },
        { status: 409 },
      );
    }

    // The user's choice in ZCode's own settings is kept unless they changed
    // the format here; a provider 9router adds new starts on Anthropic
    // Messages, which every 9router model answers.
    const effectiveFormat = apiFormat || currentFormat(rulesDoc, configDoc);
    const keyToUse = await resolveCliApiKey(apiKey);
    const rootUrl = zcodeBaseUrl(baseUrl);

    const { rulesDoc: nextRules } = buildRuleDocs({
      rulesDoc,
      format: effectiveFormat,
      baseUrl: rootUrl,
      apiKey: keyToUse,
      models: modelEntries,
    });
    const nextConfig = buildConfigEntry({
      format: effectiveFormat,
      baseUrl: rootUrl,
      apiKey: keyToUse,
      models: modelEntries,
      existing: configDoc?.provider?.["9router"],
    });
    const mergedConfig = { ...(configDoc || {}), provider: { ...(configDoc?.provider || {}), "9router": nextConfig } };

    await writeAtomic(paths.rulesPath, JSON.stringify(nextRules, null, 2));
    await writeAtomic(paths.configPath, JSON.stringify(mergedConfig, null, 2));

    return NextResponse.json({
      success: true,
      message: "ZCode settings applied successfully! Restart ZCode to see 9router's models in its picker.",
      configPath: paths.rulesPath,
    });
  } catch (error) {
    console.log("Error applying zcode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// DELETE - Remove the 9Router provider (or one model) from both config files
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const paths = await zcodeConfigPaths();

    const [rulesRaw, configRaw] = await Promise.all([
      readZcodeFile(paths.rulesPath),
      readZcodeFile(paths.configPath),
    ]);
    if (rulesRaw == null && configRaw == null) {
      return NextResponse.json({ success: true, message: "No ZCode config files to reset" });
    }

    let rulesDoc = null;
    let configDoc = null;
    try {
      rulesDoc = rulesRaw != null ? JSON.parse(rulesRaw) : null;
      configDoc = configRaw != null ? JSON.parse(configRaw) : null;
    } catch {
      return NextResponse.json(
        { error: "A ZCode config file is not valid JSON — fix or remove it, then retry" },
        { status: 409 },
      );
    }

    let remaining = null;
    let keptRule = null;
    if (modelToRemove && rulesDoc) {
      keptRule = rulesDoc?.config?.providerConfigRules?.providerRules?.find((r) => r?.providerId === "9router") || null;
      const ids = keptRule?.config?.personalModelIds || [];
      remaining = ids.filter((id) => id !== modelToRemove);
      if (remaining.length === ids.length) {
        return NextResponse.json({ success: true, message: 'Model "' + modelToRemove + '" was not configured' });
      }
    }

    if (remaining && remaining.length > 0) {
      // Remove just that model from both files, like the other tool routes.
      const entry = configDoc?.provider?.["9router"];
      const { rulesDoc: nextRules } = buildRuleDocs({
        rulesDoc,
        format: currentFormat(rulesDoc, configDoc),
        baseUrl: keptRule?.config?.api?.baseUrl || "http://127.0.0.1:20128",
        apiKey: keptRule?.config?.access?.apiKey || "",
        models: remaining.map((id) => ({ id, name: id, vision: false, contextWindow: 0, maxOutput: 0, reasoning: false })),
      });
      // Rebuild drops the deleted model's rule; config.json keeps the rest.
      const nextConfig = buildConfigEntry({
        format: currentFormat(rulesDoc, configDoc),
        baseUrl: keptRule?.config?.api?.baseUrl || "http://127.0.0.1:20128",
        apiKey: keptRule?.config?.access?.apiKey || "",
        models: remaining.map((id) => {
          const m = entry?.models?.[id] || {};
          return {
            id,
            name: m.name || id,
            vision: (m.modalities?.input || []).includes("image"),
            contextWindow: m.limit?.context || 0,
            maxOutput: m.limit?.output || 0,
            reasoning: !!m.reasoning,
          };
        }),
        existing: entry,
        enabled: entry?.enabled,
      });
      const merged = { ...(configDoc || {}), provider: { ...(configDoc?.provider || {}), "9router": nextConfig } };
      await writeAtomic(paths.rulesPath, JSON.stringify(nextRules, null, 2));
      await writeAtomic(paths.configPath, JSON.stringify(merged, null, 2));
      return NextResponse.json({ success: true, message: 'Model "' + modelToRemove + '" removed' });
    }

    // Full disconnect: drop the rule and its model rules, and the entry.
    const { rulesDoc: cleanedRules } = buildRuleDocs({ rulesDoc, models: null, format: DEFAULT_FORMAT, baseUrl: "", apiKey: "" });
    let nextConfig = removeConfigEntry(configDoc);
    const writes = [];
    if (rulesDoc && hasProviderRule(rulesDoc)) {
      writes.push(writeAtomic(paths.rulesPath, JSON.stringify(cleanedRules, null, 2)));
    }
    if (nextConfig && nextConfig !== configDoc) {
      writes.push(writeAtomic(paths.configPath, JSON.stringify(nextConfig, null, 2)));
    }
    await Promise.all(writes);

    return NextResponse.json({
      success: true,
      message: "9Router settings removed from ZCode. Restart ZCode to reload its picker.",
    });
  } catch (error) {
    console.log("Error resetting zcode settings:", error);
    return NextResponse.json({ error: "Failed to reset settings" }, { status: 500 });
  }
}
