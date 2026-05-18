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

  if (process.env.SAAS_ENABLED === "true") {
    if (!apiKey) {
      log.warn(tag, "Missing API key (SaaS)");
      return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key") };
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn(tag, "Invalid API key (SaaS)");
      return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key") };
    }
  }

  const settings = await getSettings();

  if (process.env.SAAS_ENABLED !== "true" && settings.requireApiKey) {
    if (!apiKey) {
      log.warn(tag, "Missing API key (requireApiKey=true)");
      return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key") };
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn(tag, "Invalid API key (requireApiKey=true)");
      return { error: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key") };
    }
  }

  return { settings, apiKey };
}
