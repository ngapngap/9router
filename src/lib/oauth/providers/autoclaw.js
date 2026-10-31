import { AUTOCLAW_CONFIG } from "../constants/autoclaw.js";
import { createHash, randomBytes } from "node:crypto";

// AutoClaw (Zhipu autoglm) sign-in. The overseas web OAuth (Google/z.ai)
// needs a local-callback port and an Aliyun captcha in the browser; the
// server can't host either, so sign-in accepts a token pasted from the
// official client instead (exchange validates the JWT).
const APP_ID = AUTOCLAW_CONFIG.appId;
const APP_KEY = AUTOCLAW_CONFIG.appKey;
const PRODUCT = AUTOCLAW_CONFIG.product;

function md5Hex(input) {
  return createHash("md5").update(input).digest("hex");
}

function bizHeaders(accessToken, version) {
  const ts = String(Math.floor(Date.now() / 1000));
  const h = {
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent": "AutoClaw/" + version + " (linux-x64)",
    "X-Version": version,
    "X-Tm": "linux-x64",
    "X-Product": PRODUCT,
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": md5Hex(APP_ID + "&" + ts + "&" + APP_KEY),
    "X-Trace-Id": randomBytes(8).toString("hex"),
    "X-Lang": "zh-CN",
  };
  if (accessToken) h["Authorization"] = "Bearer " + accessToken;
  return h;
}

function bareToken(v) {
  let t = String(v ?? "").trim();
  while (t.toLowerCase().startsWith("bearer ")) t = t.slice(7).trim();
  return t;
}

function jwtClaim(token, key) {
  const part = bareToken(token).split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))[key];
  } catch {
    return undefined;
  }
}

async function envelope(path, body, base, version, accessToken) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: bizHeaders(accessToken, version),
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  if (!parsed) {
    const err = new Error("AutoClaw non-envelope response (HTTP " + res.status + "): " + text.slice(0, 200));
    if (res.status === 401 || res.status === 403) err.signIn = "expired";
    throw err;
  }
  return parsed;
}

// token response -> magpie credential fields. The JWT's exp is the truth
// (about 24h); expires_in is often missing and would spin refreshes that
// risk the rotation revoking the token.
function tokenFields(data) {
  const access = bareToken(data.access_token);
  if (!access) throw new Error("AutoClaw token response contained no access_token");
  const refresh = bareToken(data.refresh_token ?? "");
  let expiresAt;
  const exp = jwtClaim(access, "exp");
  if (typeof exp === "number" && exp > 0) expiresAt = exp * 1000 - 10 * 60 * 1000;
  else expiresAt = Date.now() + ((data.expires_in > 0 ? data.expires_in : 5 * 3600) * 1000) - 10 * 60 * 1000;
  return { access, refresh, expiresAt };
}

// Overseas: the web OAuth flow (Google/z.ai) runs through a localhost
// callback and an Aliyun captcha the server can't host, so a token pasted
// from the official client (a JWT whose exp/refresh ride along) signs in.
export function validatePastedToken(token, refreshToken = "") {
  const access = bareToken(token);
  if (!access || access.split(".").length < 2) {
    throw new Error("AutoClaw token must be the client's access JWT");
  }
  const refresh = bareToken(refreshToken);
  const exp = jwtClaim(access, "exp");
  const expiresAt = typeof exp === "number" && exp > 0 ? exp * 1000 - 10 * 60 * 1000 : Date.now() + 5 * 3600 * 1000;
  // The gateway export names the account by its email/jti claim, not sub.
  const name = jwtClaim(access, "jti") || jwtClaim(access, "sub") || "AutoClaw account";
  return { access, refresh, expiresAt, accountId: String(name), email: null, uid: jwtClaim(access, "user_id") !== undefined ? String(jwtClaim(access, "user_id")) : undefined };
}

export async function refreshAutoClawToken(refreshToken, log, isCn) {
  if (!refreshToken) return null;
  const deviceId = jwtClaim(refreshToken, "device_id") ?? "";
  const body = { source_id: PRODUCT, device_id: deviceId, refresh_token: refreshToken };
  const isSms = /^agent/i.test(String(jwtClaim(refreshToken, "source_id") ?? ""));
  const ordered = isSms
    ? [AUTOCLAW_CONFIG.cnBaseUrl, AUTOCLAW_CONFIG.baseUrl]
    : [AUTOCLAW_CONFIG.baseUrl, AUTOCLAW_CONFIG.cnBaseUrl];
  let last = null;
  for (const base of ordered) {
    try {
      let r = await envelope("/userapi/v1/refresh", body, base, isCn ? AUTOCLAW_CONFIG.cnClientVersion : AUTOCLAW_CONFIG.clientVersion);
      if (r.code === 400002) {
        r = await envelope("/userapi/v1/agent-refresh", body, base, isCn ? AUTOCLAW_CONFIG.cnClientVersion : AUTOCLAW_CONFIG.clientVersion);
      }
      if (r.code === 0 && r.data?.access_token) {
        const t = tokenFields(r.data);
        return { accessToken: t.access, refreshToken: t.refresh || refreshToken, expiresAt: t.expiresAt };
      }
      last = new Error("AutoClaw refresh: " + (r.msg ?? "code " + r.code));
      if (r.code !== 400000) break;
    } catch (e) {
      last = e;
    }
  }
  log?.error?.("TOKEN_REFRESH", "AutoClaw token refresh failed", { error: last?.message });
  return null;
}

const autoclawProvider = {
  config: AUTOCLAW_CONFIG,
  flowType: "autoclaw_paste",
};

export default autoclawProvider;
