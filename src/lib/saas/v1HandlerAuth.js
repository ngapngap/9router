/**
 * Thứ tự SaaS: validate Bearer (Postgres + tenant ALS) trước khi getSettings() đọc SQLite đúng user.
 * Local: giữ requireApiKey từ settings.
 */

/**
 * @param {Request} request
 * @param {{
 *   extractApiKey: (r: Request) => string | null,
 *   isValidApiKey: (k: string) => Promise<boolean>,
 *   getSettings: () => Promise<object>,
 *   errorResponse: (code: number, msg: string) => Response,
 *   HTTP_STATUS: { UNAUTHORIZED: number },
 *   log: { warn: (tag: string, msg: string) => void },
 *   tag: string,
 * }} deps
 * @returns {Promise<{ error?: Response, settings?: object, apiKey?: string | null }>}
 */
export async function loadSettingsAfterV1Auth(request, deps) {
  const {
    extractApiKey,
    isValidApiKey,
    getSettings,
    errorResponse,
    HTTP_STATUS,
    log,
    tag,
  } = deps;
  const apiKey = extractApiKey(request);

  // [DEBUG-401] mode + key presence
  const saasOn = process.env.SAAS_ENABLED === "true";
  const masked = apiKey ? (apiKey.length > 12 ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : "(short)") : "(none)";
  console.log(`[DEBUG-401] loadSettingsAfterV1Auth | SAAS_ENABLED=${saasOn} | apiKey=${masked} | len=${apiKey?.length || 0}`);

  if (saasOn) {
    if (!apiKey) {
      console.warn(`[DEBUG-401] SAAS branch: missing API key`);
      log.warn(tag, "Missing API key (SaaS)");
      return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key") };
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      console.warn(`[DEBUG-401] SAAS branch: isValidApiKey=false for ${masked}`);
      log.warn(tag, "Invalid API key (SaaS)");
      return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key") };
    }
  }

  const settings = await getSettings();

  if (!saasOn && settings.requireApiKey) {
    console.log(`[DEBUG-401] local + requireApiKey=true branch active`);
    if (!apiKey) {
      console.warn(`[DEBUG-401] local: missing API key`);
      log.warn(tag, "Missing API key (requireApiKey=true)");
      return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key") };
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      console.warn(`[DEBUG-401] local: isValidApiKey=false for ${masked}`);
      log.warn(tag, "Invalid API key (requireApiKey=true)");
      return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key") };
    }
  }

  return { settings, apiKey };
}
