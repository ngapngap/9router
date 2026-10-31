import { WORKBUDDY_AI_CONFIG } from "../constants/oauth.js";

// WorkBuddy (Tencent's CodeBuddy desktop app) - Browser OAuth Polling Flow,
// the same endpoints as CodeBuddy with the app's own platform and User-Agent.
// 1. POST stateUrl?platform=workbuddy -> { state, authUrl }
// 2. Open authUrl in browser
// 3. Poll tokenUrl with state until success (code 0) or timeout
const workbuddyAi = {
  config: WORKBUDDY_AI_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(`${config.stateUrl}?platform=${config.platform}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": new URL(config.baseUrl).host,
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`WorkBuddy AI state request failed: ${await response.text()}`);
    const data = await response.json();
    if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
      throw new Error(`WorkBuddy AI state error: ${data.msg || "missing state/authUrl"}`);
    }
    return {
      device_code: data.data.state,
      verification_uri: data.data.authUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
      _isCodeBuddy: true,
    };
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(`${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": new URL(config.baseUrl).host,
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "SaaS",
      },
    });
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const data = await response.json();
    if (data.code === 0 && data.data?.accessToken) {
      let uid = data.data.uid || "";
      // The token response names no account: the desktop app asks the account
      // endpoint with the fresh token (plugin browserSignIn) and sends that
      // uid as X-User-Id on every chat.
      if (!uid) {
        try {
          const who = await fetch(`${config.baseUrl}/v2/plugin/login/account?state=${encodeURIComponent(deviceCode)}`, {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${data.data.accessToken}`,
              "User-Agent": config.userAgent,
              "X-Domain": new URL(config.baseUrl).host,
              "X-No-User-Id": "true",
              "X-No-Enterprise-Id": "true",
            },
          });
          if (who.ok) {
            const w = await who.json();
            if (w.code === 0) uid = w.data?.uid || "";
          }
        } catch {}
      }
      return {
        ok: true,
        data: {
          access_token: data.data.accessToken,
          refresh_token: data.data.refreshToken || "",
          token_type: data.data.tokenType || "Bearer",
          expires_in: data.data.expiresIn,
          uid: data.data.uid || data.data.userId || "",
        },
      };
    }
    if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: false, data: { error: data.msg || "unknown_error" } };
  },
  refreshToken: null,
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in || 86400,
    providerSpecificData: tokens.uid ? { uid: tokens.uid } : {},
  }),
};

export default workbuddyAi;
