import { SignJWT, jwtVerify } from "jose";

// P12 (#24) HIGH-1: Throw nếu JWT_SECRET missing trong production.
// Fallback hardcode "9router-default-secret-change-me" cho dev mode only.
const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW && process.env.NODE_ENV === "production") {
  throw new Error(
    "[SECURITY] JWT_SECRET env is required in production. " +
    "Set a strong random secret (>= 32 chars). " +
    "Refs: https://github.com/ngapngap/9router/issues/24"
  );
}
if (!JWT_SECRET_RAW) {
  console.warn("[SECURITY] JWT_SECRET not set — using insecure default. DO NOT use in production.");
}
const SECRET = new TextEncoder().encode(JWT_SECRET_RAW || "9router-default-secret-change-me");

// P12 (#24) MED-4: bind issuer/audience để chống cross-instance reuse.
const JWT_ISSUER = "9router-saas";
const JWT_AUDIENCE = process.env.SAAS_JWT_AUDIENCE || "9router-dashboard";

function getJwtExpirationTime() {
  if (process.env.SAAS_ENABLED === "true") {
    const raw = process.env.SAAS_JWT_EXPIRES_IN?.trim();
    if (raw) return raw;
  }
  return "24h";
}

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(getJwtExpirationTime())
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}
