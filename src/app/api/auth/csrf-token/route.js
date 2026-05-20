/**
 * /api/auth/csrf-token — Generate CSRF token cho SPA client.
 *
 * Client gọi GET endpoint này, nhận token trong response body + cookie.
 * Sau đó gửi token qua header X-CSRF-Token cho mọi POST/PUT/DELETE.
 *
 * P12 (#24) MED-3. Refs: https://github.com/ngapngap/9router/issues/24
 */
import { NextResponse } from "next/server";
import { generateCsrfToken } from "@/lib/security/csrfToken.js";

export async function GET() {
  const token = generateCsrfToken();
  const response = NextResponse.json({ csrfToken: token });
  // Set cookie (non-HttpOnly so JS can read it for double-submit)
  response.cookies.set("csrf-token", token, {
    httpOnly: false,
    sameSite: "strict",
    path: "/",
    secure: process.env.AUTH_COOKIE_SECURE === "true",
    maxAge: 60 * 60 * 24, // 24h
  });
  return response;
}
