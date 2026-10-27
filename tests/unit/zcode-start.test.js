import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  buildStartBody,
  fetchStartBalance,
  parseStartBalance,
  resolveGlmPlanMode,
  startPlanConfig,
  zcodeSourceHeaders,
  zcodeSessionId,
} from "../../open-sse/services/zcodeStart.js";
import { GlmExecutor } from "../../open-sse/executors/glm.js";
import { getGlmUsage } from "../../open-sse/services/usage/glm.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const prompt = JSON.parse(readFileSync(new URL("../../open-sse/config/zcode-prompt.json", import.meta.url), "utf8"));
const START_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
let credentialSequence = 0;

function jwt(exp = Math.floor(Date.now() / 1000) + 3600) {
  return "header." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".signature";
}

function credentials(token = jwt()) {
  credentialSequence += 1;
  return {
    accessToken: "test-key-" + credentialSequence,
    providerSpecificData: { zcodeJwtToken: token },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function giftBalance() {
  return {
    server_time: 1000,
    plans: [{
      user_plan_id: "u1",
      plan_id: "zcode-v3-start-plan",
      name: "ZCode Start Plan",
      status: "active",
      ends_at: 2000,
      entitlements: [{ entitlement_id: "e1", period: "daily" }],
    }],
    balances: [{
      user_plan_id: "u1",
      plan_id: "zcode-v3-start-plan",
      entitlement_id: "e1",
      show_name: "GLM-5.3",
      capabilities: ["model:glm-5.3"],
      total_units: 3000000,
      used_units: 300000,
      remaining_units: 2700000,
      expires_at: 1900,
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ZCode Start Plan request shape", () => {
  it("uses the 0.1.32 plugin's app version and exact source-header allowlist", () => {
    const headers = zcodeSourceHeaders("glm", "11111111-1111-4111-8111-111111111111");
    expect(startPlanConfig("glm").appVersion).toBe("3.16.3");
    expect(headers["User-Agent"]).toBe("ZCode/3.16.3");
    expect(headers["X-ZCode-App-Version"]).toBe("3.16.3");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["X-Client-Language"]).toBe("unknown");
    expect(headers["X-Client-Timezone"]).toBe("unknown");
    expect(headers["x-session-id"]).toBe("11111111-1111-4111-8111-111111111111");
    for (const name of ["anthropic-beta", "X-Device-Mid", "X-Request-Id", "X-ZCode-Trace-Id", "X-ZCode-Agent", "X-Title", "HTTP-Referer"]) {
      expect(headers).not.toHaveProperty(name);
    }
  });

  it("preserves client session UUIDs and derives v3 UUIDs for other seeds", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(zcodeSessionId(id)).toBe(id);
    expect(zcodeSessionId(id.toUpperCase() + "-7")).toBe(id);
    expect(zcodeSessionId("conversation-seed")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(zcodeSessionId("conversation-seed")).toBe(zcodeSessionId("conversation-seed"));
  });

  it("adds three cached ZCode blocks, the date turn, and one final cache mark", () => {
    const body = {
      model: "GLM-5.3",
      system: [{
        type: "text",
        text: "Agent rules\nPrimary working directory: /tmp/project\n - Is a git repository: false",
        cache_control: { type: "ephemeral" },
      }],
      messages: [
        { role: "user", content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two", cache_control: { type: "ephemeral" } }] },
      ],
      tools: [{ name: "Bash", cache_control: { type: "ephemeral" } }],
      metadata: { existing: true },
    };
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const result = buildStartBody(body, "zai-api", body.model, { now: new Date(2026, 9, 27, 12), sessionId });

    expect(result.system).toHaveLength(3);
    expect(result.system[0].text).toBe(prompt.prefix);
    expect(result.system[1].text).toBe(prompt.stable + "\n\n" + prompt.desktop);
    expect(result.system[2].text).toContain("Primary working directory: /tmp/project");
    expect(result.system[2].text).toContain("Is a git repository: no");
    expect(result.system[2].text).toContain("zai-api/GLM-5.3");
    expect(result.system.every((block) => block.cache_control?.type === "ephemeral")).toBe(true);
    expect(result.system[2].text).toContain("Agent rules");
    expect(result.system[2].text.indexOf("Agent rules")).toBeLessThan(result.system[2].text.indexOf("# Context management"));

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content[0].text).toContain("<system-reminder>");
    expect(result.messages[0].content[0].text).toContain("Today's date is 2026-10-27.");
    expect(result.messages[0].content[0].cache_control).toBeUndefined();
    expect(result.messages[1].content[0].cache_control).toBeUndefined();
    expect(result.messages[2].content[0].cache_control).toBeUndefined();
    expect(result.messages[2].content[1].cache_control).toEqual({ type: "ephemeral" });
    expect(result.tools[0].cache_control).toBeUndefined();
    expect(result.metadata.existing).toBe(true);
    const userId = JSON.parse(result.metadata.user_id);
    expect(userId.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(userId.account_uuid).toBe("");
    expect(userId.session_id).toBe(sessionId);
  });

  it("reads Codex cwd/git markers and leaves already-shaped bodies untouched", () => {
    const codex = buildStartBody({
      model: "glm-5.3",
      system: "<cwd>/tmp/codex</cwd>\nIs directory a git repo: yes",
      messages: [],
    }, "zai-api", "glm-5.3");
    expect(codex.system[2].text).toContain("Primary working directory: /tmp/codex");
    expect(codex.system[2].text).toContain("Is a git repository: yes");

    const shaped = { system: [{ type: "text", text: prompt.prefix }], messages: [] };
    expect(buildStartBody(shaped, "zai-api", "glm-5.3")).toBe(shaped);
    const notAnthropic = { input: [] };
    expect(buildStartBody(notAnthropic, "zai-api", "glm-5.3")).toBe(notAnthropic);
  });

  it("keeps the paid Coding Plan executor behavior and switches only flagged accounts", () => {
    const executor = new GlmExecutor();
    const paid = { accessToken: "paid-key", providerSpecificData: {} };
    expect(executor.buildUrl("glm-5.3", false, 0, paid)).toBe("https://api.z.ai/api/anthropic/v1/messages?beta=true");
    const paidHeaders = executor.buildHeaders(paid, false);
    expect(paidHeaders["x-api-key"]).toBe("paid-key");
    expect(paidHeaders.Authorization).toBeUndefined();

    const start = credentials();
    start.zcodeStartPlan = true;
    expect(executor.buildUrl("glm-5.3", false, 0, start)).toBe(START_URL);
    const headers = executor.buildHeaders(start, false);
    expect(headers.Authorization).toBe("Bearer " + start.providerSpecificData.zcodeJwtToken);
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(executor.transformRequest("glm-5.3", { model: "glm-5.3", messages: [] }, false, start).system).toHaveLength(3);
  });

  it("returns a re-login response for an expired Start Plan session", async () => {
    const executor = new GlmExecutor();
    const start = credentials(jwt(1));
    start.zcodeStartPlan = true;
    const result = await executor.execute({ model: "glm-5.3", body: { messages: [] }, stream: false, credentials: start });
    expect(result.response.status).toBe(401);
    expect(await result.response.text()).toContain("sign in to ZCode again");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("retries 3008/3009 concurrency responses with the same request up to the busy cap", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const executor = new GlmExecutor();
      const start = credentials();
      start.zcodeStartPlan = true;
      proxyAwareFetch.mockImplementation(async () => jsonResponse({ code: 3009, msg: "model concurrency limit exceeded" }, 429));
      const pending = executor.execute({ model: "glm-5.3", body: { model: "glm-5.3", messages: [] }, stream: false, credentials: start });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(proxyAwareFetch).toHaveBeenCalledTimes(7);
      expect(result.response.status).toBe(429);
      expect(await result.response.text()).toContain("retried for about ten seconds");
      const bodies = proxyAwareFetch.mock.calls.map((call) => call[1].body);
      expect(new Set(bodies).size).toBe(1);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("renames ToolSearch both ways and keeps session, URL, and headers safe", async () => {
    const executor = new GlmExecutor();
    const start = credentials();
    start.zcodeStartPlan = true;
    const sse = "event: content_block_start\ndata: " + JSON.stringify({
      type: "content_block_start",
      content_block: { type: "tool_use", name: "ToolSearchTool" },
    }) + "\n\n";
    proxyAwareFetch.mockResolvedValueOnce(new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    const result = await executor.execute({
      model: "glm-5.3",
      body: {
        model: "glm-5.3",
        messages: [],
        tools: [{ name: "ToolSearch", defer_loading: true }],
        tool_choice: { type: "tool", name: "ToolSearch" },
      },
      stream: true,
      credentials: start,
      providerSessionId: "test-conversation",
      providerOverrides: {
        baseUrl: "https://invalid.example",
        headers: { "x-api-key": "must-not-leak", "anthropic-beta": "tools", "x-app": "cli", Accept: "text/event-stream" },
      },
    });
    const [url, init] = proxyAwareFetch.mock.calls[0];
    const sent = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    const userId = JSON.parse(sent.metadata.user_id);
    expect(url).toBe(START_URL);
    expect(sent.tools[0]).toEqual({ name: "ToolSearchTool" });
    expect(sent.tool_choice.name).toBe("ToolSearchTool");
    expect(userId.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get("x-session-id")).toBe(userId.session_id);
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.has("anthropic-beta")).toBe(false);
    expect(headers.has("x-app")).toBe(false);
    const answer = await result.response.text();
    expect(answer).toContain('"name":"ToolSearch"');
    expect(answer).not.toContain("ToolSearchTool");
  });
});

describe("ZCode gift balance parsing", () => {
  it("parses Start/referral buckets, daily_night, alternatives, and expired plans", () => {
    const balance = {
      server_time: 1000,
      plans: [
        { user_plan_id: "u1", plan_id: "start-plan", name: "ZCode Start Plan", status: "active", ends_at: 2000, entitlements: [{ entitlement_id: "e1", period: "daily" }] },
        { user_plan_id: "u2", plan_id: "start-plan-referral", name: "ZCode Referral Global", status: "active", ends_at: 3000, entitlements: [{ entitlement_id: "e2", period: "daily_night" }] },
        { user_plan_id: "u3", plan_id: "start-plan-weekend", name: "Weekend Bonus", status: "active", ends_at: 900, entitlements: [{ entitlement_id: "e3", period: "weekly" }] },
      ],
      balances: [
        { user_plan_id: "u1", plan_id: "start-plan", entitlement_id: "e1", show_name: "GLM-5.3", capabilities: ["model:glm-5.3"], total_units: "1000", used_units: "250", remaining_units: "750", expires_at: "1900" },
        { user_plan_id: "u2", plan_id: "start-plan-referral", entitlement_id: "e2", show_name: "GLM-5.3 Referral", capabilities: ["model:GLM-5.3"], total_units: 1000, used_units: 0, remaining_units: 1000, expires_at: 2000 },
        { user_plan_id: "u3", plan_id: "start-plan-weekend", entitlement_id: "e3", show_name: "Expired", total_units: 100, used_units: 0, remaining_units: 100 },
      ],
    };
    const { active, buckets } = parseStartBalance(balance);
    expect(active.name).toBe("ZCode Start Plan");
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ period: "daily", used: 25, usedUnits: 250, totalUnits: 1000, remainingUnits: 750, planName: "ZCode Start Plan", aside: true });
    expect(buckets[0].resetsAt).toBe(new Date(1900 * 1000).toISOString());
    expect(buckets[1]).toMatchObject({ period: "daily", periodSeconds: 86400, planName: "ZCode Referral Global", aside: false });
  });

  it("derives a weekly span from period_start/end when entitlement period is unknown", () => {
    const { buckets } = parseStartBalance({
      server_time: 1000,
      plans: [{ user_plan_id: "u1", plan_id: "start-plan", status: "active", ends_at: 2000, entitlements: [{ entitlement_id: "e1", period: "custom" }] }],
      balances: [{ user_plan_id: "u1", plan_id: "start-plan", entitlement_id: "e1", total_units: 10, used_units: 1, remaining_units: 9, period_start: 0, period_end: 604800 }],
    });
    expect(buckets[0].period).toBe("weekly");
    expect(buckets[0].periodSeconds).toBe(604800);
  });
});

describe("ZCode plan decision and usage", () => {
  it("uses a bare API key for subscription/list and keeps paid accounts on Coding Plan", async () => {
    const account = credentials();
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ status: "VALID", productName: "GLM Coding Plan" }] }));
    expect((await resolveGlmPlanMode("glm", account)).start).toBe(false);
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe(account.accessToken);
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization.startsWith("Bearer")).toBe(false);
  });

  it("routes an account with no valid subscription to Start Plan and caches the decision", async () => {
    const account = credentials();
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: [] }));
    expect((await resolveGlmPlanMode("glm", account)).start).toBe(true);
    expect((await resolveGlmPlanMode("glm", account)).start).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("uses an active gift balance when subscription/list fails", async () => {
    const account = credentials();
    proxyAwareFetch.mockRejectedValueOnce(new Error("subscription unavailable"));
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: giftBalance() }));
    expect((await resolveGlmPlanMode("glm", account)).start).toBe(true);
    expect(proxyAwareFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer " + account.providerSpecificData.zcodeJwtToken);
  });

  it("fails back to Coding Plan when both plan checks are inconclusive", async () => {
    const account = credentials();
    proxyAwareFetch.mockRejectedValueOnce(new Error("subscription unavailable"));
    proxyAwareFetch.mockRejectedValueOnce(new Error("balance unavailable"));
    expect((await resolveGlmPlanMode("glm", account)).start).toBe(false);
  });

  it("uses Start Plan with JWT alone, even when that JWT needs renewal", async () => {
    const account = credentials(jwt(1));
    account.accessToken = "";
    expect((await resolveGlmPlanMode("glm", account)).start).toBe(true);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("unwraps the balance envelope and rejects an expired JWT before fetching", async () => {
    const token = jwt();
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: giftBalance() }));
    expect((await fetchStartBalance("glm", token)).plans).toHaveLength(1);
    expect(proxyAwareFetch.mock.calls[0][0]).toContain("app_version=3.16.3");
    await expect(fetchStartBalance("glm", jwt(1))).rejects.toThrow("sign in to ZCode again");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("exposes gift buckets through the existing GLM usage schema", async () => {
    const account = credentials();
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: [] }));
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: giftBalance() }));
    const usage = await getGlmUsage(account.accessToken, "glm", null, account.providerSpecificData);
    expect(usage.plan).toBe("ZCode Start Plan");
    expect(usage.quotas["ZCode Start Plan · GLM-5.3"]).toMatchObject({
      used: 10,
      total: 100,
      remaining: 90,
      remainingPercentage: 90,
      period: "daily",
      usedUnits: 300000,
      totalUnits: 3000000,
      remainingUnits: 2700000,
    });
  });

  it("retains the generic 1113 hint and adds the Start Plan risk-control hint", async () => {
    const executor = new GlmExecutor();
    const insufficient = await parseUpstreamError(jsonResponse({ error: { code: 1113, message: "Insufficient balance or no resource package" } }, 429), executor);
    expect(insufficient.message).toContain("ZCode OAuth");
    const refused = await parseUpstreamError(jsonResponse({ code: 3012, msg: "request has been blocked due to unusual activity" }, 405), executor);
    expect(refused.message).toContain("risk control");
  });
});
