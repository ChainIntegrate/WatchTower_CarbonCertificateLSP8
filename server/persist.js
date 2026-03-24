// server/persist.js
import fs from "fs";
import path from "path";

const DEFAULT_STATE_PATH = "/opt/apps/wr_cfp/state.json";

// ✅ stato univoco per app (evita collisioni tra watchtower)
const STATE_PATH = process.env.WT_STATE_PATH
  ? path.resolve(process.env.WT_STATE_PATH)
  : DEFAULT_STATE_PATH;

const STATE_DIR = path.dirname(STATE_PATH);

if (process.env.DEBUG_PERSIST === "1") {
  console.log("[persist] PID =", process.pid);
  console.log("[persist] CWD =", process.cwd());
  console.log("[persist] STATE_PATH =", STATE_PATH);
}

let writeLock = false;

function ensureDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

function safeJsonParse(raw) {
  try {
    const j = JSON.parse(raw);
    return (j && typeof j === "object") ? j : {};
  } catch {
    return {};
  }
}

function readRaw() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    return safeJsonParse(raw);
  } catch {
    return {};
  }
}

function normBlock(n) {
  if (n === null || n === undefined) return null;
  if (typeof n === "string" && n.trim() === "") return null;

  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v < 0) return 0;
  return Math.floor(v);
}

function atomicWriteJson(filePath, obj) {
  ensureDir();
  const tmp = filePath + ".tmp";
  const data = JSON.stringify(obj, null, 2);
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, filePath);
}

// ✅ Solo checkpoint
export function loadState() {
  const j = readRaw();
  const out = {
    lastBlock: normBlock(j?.lastBlock),
    savedAt: Number(j?.savedAt) || null
  };

  if (process.env.DEBUG_PERSIST === "1") {
    console.log("[persist] loadState ->", out);
  }
  return out;
}

/**
 * Merge + write atomica.
 * Patch supportata: { lastBlock }
 */
export function saveStateAtomic(patch = {}) {
  if (writeLock) {
    setTimeout(() => {
      try { saveStateAtomic(patch); } catch {}
    }, 25);
    return;
  }

  writeLock = true;
  try {
    const cur = readRaw();
    const next = { ...cur, ...patch };

    // ⚠️ IMPORTANT: non sovrascrivere con null/undefined
    if ("lastBlock" in patch) {
      const nb = normBlock(patch.lastBlock);
      if (nb != null) next.lastBlock = nb;
      else next.lastBlock = normBlock(cur?.lastBlock); // conserva
    } else {
      next.lastBlock = normBlock(cur?.lastBlock);
    }

    next.savedAt = Date.now();

    delete next.watcherWanted;
    delete next.watcherStartBlock;

    atomicWriteJson(STATE_PATH, next);

    if (process.env.DEBUG_PERSIST === "1") {
      console.log("[persist] saveStateAtomic wrote ->", { lastBlock: next.lastBlock, savedAt: next.savedAt });
    }
  } finally {
    writeLock = false;
  }
}