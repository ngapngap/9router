import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) {
    const dir = defaultDir();
    console.log(`[DATA_DIR] using default → ${dir}`);
    return dir;
  }
  try {
    fs.mkdirSync(configured, { recursive: true });
    console.log(`[DATA_DIR] using configured → ${configured}`);
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      const fallback = defaultDir();
      console.warn(`[DATA_DIR] configured "${configured}" not writable (${e.code}) → fallback ${fallback}`);
      return fallback;
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
