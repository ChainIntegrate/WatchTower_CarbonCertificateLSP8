// server/state.js
import fs from "fs";
import path from "path";

/**
 * UI/Runtime state (NON usare lo stesso file di persist.js!)
 * Default: ./ui_state.json
 *
 * Env:
 *  - WT_UI_STATE_PATH=/opt/apps/wr_bcc/ui_state.json
 */
const STATE_PATH = process.env.WT_UI_STATE_PATH
  ? path.resolve(process.env.WT_UI_STATE_PATH)
  : path.join(process.cwd(), "ui_state.json");

const DEFAULT_STATE = {
  scanning: false,
  mode: "live",        // "live" | "range"
  startBlock: null,    // number | null (solo se mode="range")
  lastStartAt: null,   // ISO string
  lastStopAt: null,    // ISO string
  lastReason: null     // "ui" | "boot" | "crash" | ...
};

function ensureDirForFile(p) {
  const dir = path.dirname(p);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function safeJsonParse(raw) {
  try {
    const j = JSON.parse(raw);
    return (j && typeof j === "object") ? j : {};
  } catch {
    return {};
  }
}

function normBool(x) {
  if (typeof x === "boolean") return x;
  if (x == null) return false;
  const s = String(x).toLowerCase().trim();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return false;
}

function normMode(x) {
  const m = String(x || "").toLowerCase().trim();
  return (m === "range") ? "range" : "live";
}

function normBlock(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  if (v < 0) return 0;
  return Math.floor(v);
}

function normIso(x) {
  if (!x) return null;
  const d = new Date(String(x));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function sanitizeState(s) {
  const out = { ...DEFAULT_STATE, ...(s || {}) };

  out.scanning = normBool(out.scanning);
  out.mode = normMode(out.mode);

  // startBlock è valido solo in mode=range
  const sb = normBlock(out.startBlock);
  out.startBlock = (out.mode === "range") ? sb : null;

  out.lastStartAt = normIso(out.lastStartAt);
  out.lastStopAt  = normIso(out.lastStopAt);

  out.lastReason = out.lastReason != null ? String(out.lastReason) : null;

  return out;
}

function atomicWriteJson(filePath, obj) {
  ensureDirForFile(filePath);
  const tmp = filePath + ".tmp";
  const data = JSON.stringify(obj, null, 2);

  fs.writeFileSync(tmp, data, "utf-8");

  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // fallback
    try {
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);
    } catch {
      throw e;
    }
  }
}

export function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const s = safeJsonParse(raw);
    return sanitizeState(s);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(next) {
  const sanitized = sanitizeState(next);
  atomicWriteJson(STATE_PATH, sanitized);
  return sanitized;
}

export function patchState(patch = {}) {
  const cur = loadState();
  const merged = { ...cur, ...(patch || {}) };
  return saveState(merged);
}

export function getStatePath() {
  return STATE_PATH;
}