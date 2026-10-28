
// AutoClaw credit wallet usage - the plugin (magpie-community/plugins
// packages/autoclaw) reads GET /agent-assetmgr/api/v2/wallets with the
// business WAF-signed headers and Authorization: Bearer <jwt> (NOT the
// X-Authorization the chat gateway takes). Points are a pure balance: no
// total, no used - surfaced as isCreditBalance rows like DeepSeek.
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";
import { createHash, randomBytes } from "node:crypto";

const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";

export async function getAutoClawUsage(accessToken, proxyOptions = null) {
  const token = String(accessToken || "").replace(/^bearer /i, "").trim();
  if (!token) {
    return { message: "AutoClaw credential not available." };
  }

  try {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      Accept: "*/*",
      "User-Agent": "AutoClaw/1.18.1 (linux-x64)",
      "X-Version": "1.18.1",
      "X-Tm": "linux-x64",
      "X-Product": "autoclaw",
      "X-Auth-Appid": APP_ID,
      "X-Auth-TimeStamp": ts,
      "X-Auth-Sign": createHash("md5").update(APP_ID + "&" + ts + "&" + APP_KEY).digest("hex"),
      "X-Trace-Id": randomBytes(16).toString("hex"),
      "X-Lang": "zh-CN",
      "X-Channel": "AutoClaw4",
      "X-Client-Type": "pc",
      "Origin": "http://localhost:18432",
      "Referer": "http://localhost:18432/",
      Authorization: "Bearer " + token,
    };

    const url = U("autoclaw").url || "https://autoglm-api.autoglm.ai/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw";
    const response = await proxyAwareFetch(url, {
      method: "GET",
      headers,
      redirect: "error",
    }, proxyOptions);

    if (!response.ok) {
      return { message: `AutoClaw credit API error (HTTP " + response.status + ").` };
    }
    const payload = await response.json().catch(() => null);
    if (!payload || payload.code !== 0 || !payload.data) {
      const msg = String(payload?.msg || "");
      if (payload?.code === 410000 || /\u767b\u5f55/.test(msg)) {
        return { message: "AutoClaw credential invalid or expired." };
      }
      return { message: `AutoClaw credit API error (code " + (payload?.code ?? "?") + ").` };
    }

    const data = payload.data;
    const total = Number(data.total_balance);
    if (!Number.isFinite(total)) {
      return { message: "AutoClaw credit response malformed." };
    }

    const quotas = {
      // Total across all wallets - the headline number, like the plugin shows.
      Credit: {
        used: 0,
        total,
        remainingPercentage: total > 0 ? 100 : 0,
        resetAt: null,
        unlimited: false,
        isCreditBalance: true,
        currency: "points",
      },
    };
    // Named wallets whose balance differs from the total (split wallets) -
    // cap at 3 like the plugin does, so the common single-wallet case stays
    // one clean row.
    let n = 0;
    for (const w of Array.isArray(data.wallets) ? data.wallets : []) {
      if (w?.display === false) continue;
      const balance = Number(w.balance);
      if (!Number.isFinite(balance) || balance <= 0 || Math.round(balance) === Math.round(total)) continue;
      const name = String(w.display_name || w.public_wallet_type || "Wallet");
      if (quotas[name]) continue;
      quotas[name] = {
        used: 0,
        total: balance,
        remainingPercentage: balance > 0 ? 100 : 0,
        resetAt: null,
        unlimited: false,
        isCreditBalance: true,
        currency: "points",
      };
      if (++n >= 3) break;
    }

    return { plan: "AutoClaw", quotas };
  } catch (error) {
    return { message: `AutoClaw usage error: ${error.message}` };
  }
}
