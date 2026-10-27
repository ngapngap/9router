"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import fs from "fs/promises";
import {
  WORKBUDDY_BUILDS,
  workbuddyPaths,
  workbuddyRead,
  workbuddyWired,
  ourEntries,
  writeWorkbuddyModels,
} from "@/lib/workbuddyConfig.js";

// WorkBuddy is a desktop app, not a CLI on PATH: detection is its data
// folder (~/.workbuddy / ~/.workbuddy-ai, or WORKBUDDY_CONFIG_DIR for the
// Chinese build), as magpie's directory check does off a Mac.
async function buildStatus(build) {
  const paths = workbuddyPaths(build);
  let installed = false;
  try {
    await fs.access(paths.dir);
    installed = true;
  } catch {
    installed = false;
  }
  if (!installed) {
    return { build, installed: false, has9Router: false, configPath: paths.modelsPath, workbuddy: null };
  }
  const doc = await workbuddyRead(paths.modelsPath);
  const ours = ourEntries(doc);
  return {
    build,
    installed: true,
    has9Router: ours.length > 0 || (await workbuddyWired(build)),
    configPath: paths.modelsPath,
    workbuddy: {
      baseURL: ours[0]?.url || null,
      models: ours.map((e) => e.id),
      disabled: ours.filter((e) => e.disabled === true).map((e) => e.id),
    },
  };
}

// GET - both builds' folders and current wiring
export async function GET() {
  try {
    const builds = Object.keys(WORKBUDDY_BUILDS);
    const statuses = {};
    for (const build of builds) {
      statuses[build] = await buildStatus(build);
    }
    return NextResponse.json({
      installed: Object.values(statuses).some((s) => s.installed),
      has9Router: Object.values(statuses).some((s) => s.has9Router),
      builds: statuses,
    });
  } catch (error) {
    if (error?.status === 409) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error checking workbuddy settings:", error);
    return NextResponse.json({ error: "Failed to check workbuddy settings" }, { status: 500 });
  }
}

// POST - put 9router's models into one build's models.json
export async function POST(request) {
  try {
    const { build, baseUrl, apiKey, models } = await request.json();
    const site = WORKBUDDY_BUILDS[build];
    if (!site) {
      return NextResponse.json({ error: "build must be one of: " + Object.keys(WORKBUDDY_BUILDS).join(", ") }, { status: 400 });
    }
    const list = Array.isArray(models) ? models : [];
    if (!baseUrl || list.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const { getCapabilitiesForModel } = await import("open-sse/providers/capabilities.js");
    const seen = new Set();
    const modelEntries = [];
    for (const value of list) {
      if (!value || typeof value !== "string" || seen.has(value)) continue;
      seen.add(value);
      const slashAt = value.indexOf("/");
      const provider = slashAt > 0 ? value.slice(0, slashAt) : "";
      const modelId = slashAt > 0 ? value.slice(0, slashAt) === value ? value : value.slice(slashAt + 1) : value;
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
    if (modelEntries.length === 0) {
      return NextResponse.json({ error: "at least one model is required" }, { status: 400 });
    }

    const keyToUse = await resolveCliApiKey(apiKey);
    const url = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/chat/completions";
    const result = await writeWorkbuddyModels({ build, url, apiKey: keyToUse, models: modelEntries });

    return NextResponse.json({
      success: true,
      message: site.name + " settings applied! Restart " + site.name + " if it is running, then pick the models in its model picker.",
      configPath: result.modelsPath,
    });
  } catch (error) {
    if (error?.status === 409) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error applying workbuddy settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// DELETE - take 9router's models (or one model) out of one build's models.json
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const build = searchParams.get("build");
    const site = WORKBUDDY_BUILDS[build];
    if (!site) {
      return NextResponse.json({ error: "build must be one of: " + Object.keys(WORKBUDDY_BUILDS).join(", ") }, { status: 400 });
    }
    const modelToRemove = searchParams.get("model");
    const paths = workbuddyPaths(build);
    const doc = await workbuddyRead(paths.modelsPath);
    const ours = ourEntries(doc);
    if (ours.length === 0) {
      return NextResponse.json({ success: true, message: "No 9router models in " + site.name + "'s models.json" });
    }

    if (modelToRemove) {
      const keep = ours.filter((e) => e.id !== modelToRemove);
      if (keep.length === ours.length) {
        return NextResponse.json({ success: true, message: 'Model "' + modelToRemove + '" was not configured' });
      }
      await writeWorkbuddyModels({
        build,
        url: ours[0]?.url || "",
        apiKey: ours.find((e) => e.id !== modelToRemove)?.apiKey || ours[0]?.apiKey || "",
        models: keep.map((e) => ({
          id: e.id,
          name: e.name,
          vision: !!e.supportsImages,
          contextWindow: Number(e.maxInputTokens) || 0,
          maxOutput: Number(e.maxOutputTokens) || 0,
          reasoning: !!e.supportsReasoning,
        })),
      });
      return NextResponse.json({ success: true, message: 'Model "' + modelToRemove + '" removed' });
    }

    await writeWorkbuddyModels({ build, url: "", apiKey: "", models: null });
    return NextResponse.json({
      success: true,
      message: "9router's models removed from " + site.name + ". Restart it to reload its picker.",
    });
  } catch (error) {
    if (error?.status === 409) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error resetting workbuddy settings:", error);
    return NextResponse.json({ error: "Failed to reset settings" }, { status: 500 });
  }
}
