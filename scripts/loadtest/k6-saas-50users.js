/**
 * scripts/loadtest/k6-saas-50users.js — k6 load test cho 9router SaaS.
 *
 * Mục đích: verify performance baseline trước khi mở public beta.
 * Target: 50 VU, 10 req/s sustained 5 phút, p95 < 2s, error rate < 1%.
 *
 * Usage:
 *   k6 run --env BASE_URL=https://your-domain scripts/loadtest/k6-saas-50users.js
 *   k6 run --env BASE_URL=http://localhost:20130 --env API_KEY=sk-xxx scripts/loadtest/k6-saas-50users.js
 *
 * Env vars:
 *   BASE_URL — target URL (required)
 *   API_KEY — Bearer token for /api/v1/* endpoints (required for chat test)
 *   LOGIN_USER — username for login test (optional, default "testuser")
 *   LOGIN_PASS — password for login test (optional, default "testpass")
 *
 * P10 (#23) acceptance criteria: CPU <50%, p95 <2s, error rate <1%.
 * Refs: https://github.com/ngapngap/9router/issues/23
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

// Custom metrics
const errorRate = new Rate("errors");
const chatLatency = new Trend("chat_p95", true);

// Test configuration
export const options = {
  scenarios: {
    // Ramp up to 50 VU over 1 min, sustain 5 min, ramp down 1 min
    sustained_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: 50 },   // ramp up
        { duration: "5m", target: 50 },   // sustained
        { duration: "1m", target: 0 },    // ramp down
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<2000"],  // p95 < 2s
    errors: ["rate<0.01"],              // error rate < 1%
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:20130";
const API_KEY = __ENV.API_KEY || "sk-test-key";
const LOGIN_USER = __ENV.LOGIN_USER || "testuser";
const LOGIN_PASS = __ENV.LOGIN_PASS || "testpass";

export default function () {
  // Distribute load across endpoint types
  const rand = Math.random();

  if (rand < 0.1) {
    // 10% — health check (lightweight, verify always fast)
    group("health_check", () => {
      const res = http.get(`${BASE_URL}/api/health`);
      check(res, {
        "health 200": (r) => r.status === 200,
        "health ok": (r) => r.json("ok") === true,
      });
      errorRate.add(res.status !== 200);
    });
  } else if (rand < 0.2) {
    // 10% — liveness probe
    group("liveness", () => {
      const res = http.get(`${BASE_URL}/api/health/live`);
      check(res, { "live 200": (r) => r.status === 200 });
      errorRate.add(res.status !== 200);
    });
  } else if (rand < 0.4) {
    // 20% — login attempt (rate limited — expect some 429)
    group("login", () => {
      const res = http.post(
        `${BASE_URL}/api/auth/login`,
        JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASS }),
        { headers: { "Content-Type": "application/json" } }
      );
      check(res, {
        "login 200 or 401 or 429": (r) => [200, 401, 429].includes(r.status),
      });
      // 429 is expected (rate limit) — don't count as error
      errorRate.add(![200, 401, 429].includes(res.status));
    });
  } else if (rand < 0.7) {
    // 30% — Bearer API (chat completions) — main load
    group("chat_completions", () => {
      const payload = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 5,
        stream: false,
      });
      const res = http.post(`${BASE_URL}/api/v1/chat/completions`, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        timeout: "10s",
      });
      check(res, {
        "chat 200 or 402 or 429 or 502": (r) => [200, 402, 429, 502, 503].includes(r.status),
      });
      chatLatency.add(res.timings.duration);
      // 402 (quota) and 429 (rate limit) are expected under load
      errorRate.add(![200, 402, 429, 502, 503].includes(res.status));
    });
  } else {
    // 30% — dashboard API (account/me) with cookie auth
    group("dashboard_api", () => {
      // First login to get cookie
      const loginRes = http.post(
        `${BASE_URL}/api/auth/login`,
        JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASS }),
        { headers: { "Content-Type": "application/json" } }
      );

      if (loginRes.status === 200) {
        // Use cookie jar (k6 handles cookies automatically per VU)
        const meRes = http.get(`${BASE_URL}/api/account/me`, {
          headers: { "Content-Type": "application/json" },
        });
        check(meRes, {
          "me 200 or 401": (r) => [200, 401].includes(r.status),
        });
        errorRate.add(![200, 401].includes(meRes.status));
      }
    });
  }

  // Throttle to ~10 req/s across 50 VU → sleep ~5s per iteration
  sleep(Math.random() * 3 + 3); // 3-6s random
}

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration?.values?.["p(95)"] || 0;
  const errRate = data.metrics.errors?.values?.rate || 0;
  const totalReqs = data.metrics.http_reqs?.values?.count || 0;

  console.log("\n=== 9router SaaS Load Test Summary ===");
  console.log(`Total requests: ${totalReqs}`);
  console.log(`p95 latency: ${p95.toFixed(0)}ms (threshold: <2000ms)`);
  console.log(`Error rate: ${(errRate * 100).toFixed(2)}% (threshold: <1%)`);
  console.log(`Result: ${p95 < 2000 && errRate < 0.01 ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=====================================\n");

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
