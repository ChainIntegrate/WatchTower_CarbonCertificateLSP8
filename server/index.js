import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { ethers } from "ethers";
import { createHistoryWriter, loadTailEvents } from "./history.js";
import fs from "fs";
import { createTelegramNotifier } from "./telegram.js";

import {
  APP_NAME, PORT, RPC_URL,
  BUFFER_MAX, POLL_INTERVAL_MS, CONFIRMATIONS, START_BLOCK,
  WATCH_CONTRACTS, DEPOSIT_ADDRESSES, USER_WALLET_MAP, BLOCKSCOUT_BASE,
  TG_ENABLED, TG_BOT_TOKEN, TG_CHAT_ID, TG_MIN_INTERVAL_MS,
  TG_ALLOW_SCHEMAS, TG_ALLOW_KINDS, TG_ALLOW_CONTRACTS
} from "./config.js";

import { RingStore } from "./store.js";
import { startWatcher } from "./watcher.js";
import { loadState, saveStateAtomic } from "./persist.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
  // ✅ path dedicato a questa watchtower
  path: "/socket.io/",
});

// --------------------
// Store + Persist
// --------------------
const store = new RingStore(BUFFER_MAX);
const HARD_MAX_EVENTS = 5000;

// --------------------
// History persistence (NDJSON)
// --------------------
const DATA_DIR = path.join(process.cwd(), "data"); // es: /opt/apps/watchtower/data
const history = createHistoryWriter({ dir: DATA_DIR, filename: "events.ndjson" });

// --------------------
// Address book (labels)
// --------------------
const ADDRESS_BOOK_PATH = path.join(DATA_DIR, "address-book.json");

let ADDRESS_BOOK = {};
try {
  ADDRESS_BOOK = JSON.parse(fs.readFileSync(ADDRESS_BOOK_PATH, "utf8")) || {};
  console.log(`[watchtower] loaded address book: ${Object.keys(ADDRESS_BOOK).length} entries`);
} catch (e) {
  console.warn("[watchtower] address-book.json missing/invalid:", e?.message || e);
}

function resolveLabel(addr) {
  if (!addr) return null;
  const a = String(addr).toLowerCase();
  const hit = ADDRESS_BOOK[a];
  if (!hit) return null;
  if (typeof hit === "string") return { label: hit, type: "custom" };
  return hit;
}

function enrichEvent(e) {
  const contractAddr = e?.contract?.address || e?.address || null;
  return {
    ...e,
    labels: {
      from: resolveLabel(e?.from),
      to: resolveLabel(e?.to),
      operator: resolveLabel(e?.operator),
      address: resolveLabel(e?.address),
      contract: resolveLabel(contractAddr)
    }
  };
}

// --------------------
// Preload history tail
// --------------------
try {
  const tail = loadTailEvents(history.filePath, BUFFER_MAX);
  for (const ev of tail.reverse()) store.push(ev);
  console.log(`[watchtower] loaded ${tail.length} events from history tail`);
} catch (e) {
  console.warn("[watchtower] history tail load failed:", e?.message || e);
}

// --------------------
// Restore persisted state
// --------------------
const persisted = loadState() || {};

console.log(`[watchtower] PID=${process.pid}`);
console.log(`[watchtower] persisted state: lastBlock=${persisted.lastBlock} savedAt=${persisted.savedAt}`);

if (persisted.lastBlock != null) {
  store.lastBlock = persisted.lastBlock;
  console.log(`[watchtower] restored lastBlock from state.json: ${store.lastBlock}`);
} else {
  console.log(`[watchtower] no persisted lastBlock found (state.json missing or empty)`);
}


// --------------------
// Provider
// --------------------
const provider = new ethers.providers.StaticJsonRpcProvider(
  RPC_URL,
  { name: "lukso-testnet", chainId: 4201 }
);

// --------------------
// Telegram notifier (solo eventi, NO expiry monitor)
// --------------------
const allowKinds = TG_ALLOW_KINDS
  ? new Set(String(TG_ALLOW_KINDS).split(",").map(s => s.trim().toUpperCase()).filter(Boolean))
  : null;

const allowSchemas = TG_ALLOW_SCHEMAS
  ? new Set(String(TG_ALLOW_SCHEMAS).split(",").map(s => s.trim().toLowerCase()).filter(Boolean))
  : null;

const allowContracts = TG_ALLOW_CONTRACTS
  ? new Set(String(TG_ALLOW_CONTRACTS).split(",").map(s => s.trim().toLowerCase()).filter(Boolean))
  : null;

const tg = createTelegramNotifier({
  enabled: TG_ENABLED,
  token: TG_BOT_TOKEN,
  chatId: TG_CHAT_ID,
  minIntervalMs: TG_MIN_INTERVAL_MS,
  allowKinds,
  allowSchemas,
  allowContracts,

  // link explorer
  explorerTxBase: BLOCKSCOUT_BASE ? `${BLOCKSCOUT_BASE}/tx/` : null,
  explorerBlockBase: BLOCKSCOUT_BASE ? `${BLOCKSCOUT_BASE}/block/` : null,

  // ❌ niente scadenze TRC2 in questa WT
  expiryEnabled: false
});

console.log(`[tg] enabled=${tg.isEnabled()} minIntervalMs=${TG_MIN_INTERVAL_MS}`);

// --------------------
// Static UI
// --------------------
const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR));

// --------------------
// API
// --------------------

// --- Verify a single log vs blockchain truth ---
app.get("/api/verify-log", async (req, res) => {
  try {
    const txHash = String(req.query.txHash || "").trim().toLowerCase();
    const logIndex = Number(req.query.logIndex);
    const address = String(req.query.address || "").trim().toLowerCase();

    const isTx = /^0x[a-f0-9]{64}$/.test(txHash);
    const isAddr = /^0x[a-f0-9]{40}$/.test(address);
    if (!isTx || !Number.isFinite(logIndex) || logIndex < 0 || !isAddr) {
      return res.status(400).json({ ok: false, error: "bad params (txHash/logIndex/address)" });
    }

    const rcpt = await provider.getTransactionReceipt(txHash);
    if (!rcpt) {
      return res.json({ ok: false, status: "not_found", reason: "receipt not found (pending/pruned?)" });
    }

    const logs = Array.isArray(rcpt.logs) ? rcpt.logs : [];

    const hit = logs.find(l =>
      Number(l?.logIndex) === logIndex &&
      String(l?.address || "").toLowerCase() === address
    );

    if (!hit) {
      return res.json({
        ok: false,
        status: "missing_onchain",
        reason: "log not present in receipt for given logIndex+address",
        onchainLogsCount: logs.length
      });
    }

    const onTopic0 = String(hit.topics?.[0] || "").toLowerCase();
    const onTopics = (hit.topics || []).map(t => String(t).toLowerCase());
    const onData = String(hit.data || "0x").toLowerCase();

    const ndTopic0 = String(req.query.topic0 || "").toLowerCase();
    const ndTopics = String(req.query.topics || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const ndData = String(req.query.data || "0x").toLowerCase();

    const same =
      onTopic0 === ndTopic0 &&
      onData === ndData &&
      onTopics.length === ndTopics.length &&
      onTopics.every((t, i) => t === ndTopics[i]);

    return res.json({
      ok: same,
      status: same ? "match" : "mismatch",
      txHash,
      logIndex,
      address,
      diff: same ? null : {
        onchain: { topic0: onTopic0, topics: onTopics, data: onData },
        ui:     { topic0: ndTopic0, topics: ndTopics, data: ndData }
      }
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/api/health", async (req, res) => {
  let head = null;
  try { head = await provider.getBlockNumber(); } catch {}
  res.json({
    ok: true,
    name: APP_NAME,
    rpc: RPC_URL,
    stats: store.stats(),
    head,
    confirmations: CONFIRMATIONS,
    pollIntervalMs: POLL_INTERVAL_MS,
    startBlockDefault: START_BLOCK,
    persistedLastBlock: store.lastBlock ?? null
  });
});

app.get("/api/contracts", (req, res) => {
  res.json({
    ok: true,
    blockscout: BLOCKSCOUT_BASE,
    contracts: WATCH_CONTRACTS
  });
});

// serve alla UI per popolare filtri/label
app.get("/api/address-book", (req, res) => {
  res.json({ ok: true, book: ADDRESS_BOOK });
});

app.get("/api/events", (req, res) => {
  const limit = Math.max(1, Math.min(HARD_MAX_EVENTS, Number(req.query.limit) || 200));
  const type = req.query.type ? String(req.query.type) : null;
  const contract = req.query.contract ? String(req.query.contract) : null;
  const q = req.query.q ? String(req.query.q) : null;

  const client = req.query.client ? String(req.query.client).toLowerCase() : null;

  const from = req.query.from ? String(req.query.from) : null; // YYYY-MM-DD
  const to   = req.query.to   ? String(req.query.to)   : null; // YYYY-MM-DD

  // pool grande quando c'è filtro "costoso" (data o client)
  const poolLimit = (from || to || client) ? HARD_MAX_EVENTS : limit;

  let events = store.list({ limit: poolLimit, type, contract, q });

  // filtro cliente (from/to/operator)
  if (client) {
    events = events.filter((e) => {
      const f = String(e?.from || "").toLowerCase();
      const t = String(e?.to || "").toLowerCase();
      const op = String(e?.operator || "").toLowerCase();
      return (f === client || t === client || op === client);
    });
  }

  // filtro data su ts (seconds), interpretando le date come giorni interi in UTC
  if (from || to) {
    const parseDayUTC = (yyyy_mm_dd, endExclusive) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyy_mm_dd || "");
      if (!m) return null;
      const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);

      if (!endExclusive) {
        return Math.floor(Date.UTC(y, mo, d, 0, 0, 0) / 1000); // inclusive
      }
      return Math.floor(Date.UTC(y, mo, d + 1, 0, 0, 0) / 1000); // exclusive
    };

    const fromTs = from ? parseDayUTC(from, false) : null;
    const toExcl = to   ? parseDayUTC(to, true)    : null;

    events = events.filter((e) => {
      const ts = Number(e?.ts);
      if (!Number.isFinite(ts)) return false;
      if (fromTs != null && ts < fromTs) return false;
      if (toExcl != null && ts >= toExcl) return false;
      return true;
    });
  }

  // dopo tutti i filtri, rispetta il limit richiesto
  events = events.slice(0, limit);

  // arricchisci prima di rispondere
  events = events.map(enrichEvent);

  res.json({ ok: true, limit, from, to, client, events });
});

app.get("/api/events/:txHash", (req, res) => {
  const txHash = String(req.params.txHash || "").toLowerCase();

  const pool = store.list({ limit: HARD_MAX_EVENTS });

  const out = pool
    .filter(e => String(e.txHash || "").toLowerCase() === txHash)
    .map(enrichEvent);

  res.json({ ok: true, txHash, events: out });
});

// --------------------
// Watcher control
// --------------------
let watcherCtrl = null;

// autosave lastBlock
let saveTimer = null;

function startAutoSave() {
  if (saveTimer) return;
  saveTimer = setInterval(() => {
    try {
      if (store.lastBlock != null) saveStateAtomic({ lastBlock: store.lastBlock });
    } catch (e) {
      console.warn("[watchtower] autosave failed:", e?.message || e);
    }
  }, 5000);
}

function stopAutoSave() {
  if (saveTimer) clearInterval(saveTimer);
  saveTimer = null;
}

function saveNow() {
  try {
    if (store.lastBlock != null) saveStateAtomic({ lastBlock: store.lastBlock });
  } catch (e) {
    console.warn("[watchtower] saveNow failed:", e?.message || e);
  }
}

/**
 * start/stop “watchtower”
 */
async function startWatchtower({ startBlockOverride = null, force = false, reason = "ui" } = {}) {
  if (watcherCtrl?.isRunning?.()) {
    return { ok: true, alreadyRunning: true };
  }
console.log(`[watchtower] startWatchtower args: startBlockOverride=(${typeof startBlockOverride}) ${JSON.stringify(startBlockOverride)} force=${force} reason=${reason}`);
  

  const ob = Number(startBlockOverride);
  const hasOverride = Number.isFinite(ob) && ob > 0;

  const lb = Number(store.lastBlock);
  const hasLast = Number.isFinite(lb) && lb > 0;

  const startBlock = hasOverride ? ob : (hasLast ? lb : START_BLOCK);

  const persistedLast = Number(store.lastBlock);

    console.log(`[watchtower] startWatchtower: using startBlock=${startBlock} (reason=${reason})`);
  console.log(`[watchtower] startWatchtower: persistedLast=${persistedLast} store.lastBlock=${store.lastBlock}`);

  // Se startBlock < lastBlock persistito: UI chiede confirm, boot forza ripartenza “sicura”
  if (
    !force &&
    Number.isFinite(persistedLast) &&
    Number.isFinite(startBlock) &&
    startBlock < persistedLast
  ) {
    if (reason === "boot") {
      console.log(
        `[watchtower] boot: startBlock(${startBlock}) < persistedLast(${persistedLast}). ` +
        `Using persistedLast to avoid duplicates.`
      );
      return startWatchtower({ startBlockOverride: persistedLast, force: true, reason });
    }

    return {
      ok: false,
      needsConfirm: true,
      startBlock,
      persistedLastBlock: persistedLast,
      message:
        `ATTENZIONE: startBlock (${startBlock}) è precedente all'ultimo blocco salvato (${persistedLast}). ` +
        `Così rischi di DUPLICARE eventi nello storico (events.ndjson). ` +
        `Conferma per proseguire (backfill).`
    };
  }

  const head = await provider.getBlockNumber();

    console.log(`[watchtower] startWatchtower: head=${head} confirmations=${CONFIRMATIONS}`);

  watcherCtrl = await startWatcher({
    provider,
    store,
    io,
    contracts: WATCH_CONTRACTS,
    depositSet: DEPOSIT_ADDRESSES,
    userWalletMap: USER_WALLET_MAP,
    pollIntervalMs: POLL_INTERVAL_MS,
    confirmations: CONFIRMATIONS,
    startBlock,
    history,
    tg
  });

  startAutoSave();
  saveNow();

  io.emit("watch:status", {
    running: true,
    phase: "running",
    message: "Watchtower in esecuzione",
    head,
    startBlock,
    reason
  });

  return { ok: true, startBlock, head };
}

function stopWatchtower({ reason = "ui" } = {}) {
  try {
    if (watcherCtrl?.stop) watcherCtrl.stop();
  } catch {}
  watcherCtrl = null;

  stopAutoSave();
  saveNow();

  io.emit("watch:status", {
    running: false,
    phase: "idle",
    message: "Watchtower fermata",
    reason
  });

  return { ok: true };
}

// --------------------
// Socket.IO
// --------------------
io.on("connection", (socket) => {
  socket.emit("hello", {
    name: APP_NAME,
    stats: store.stats(),
    persistedLastBlock: store.lastBlock ?? null
  });

  socket.on("snapshot", (opts) => {
    const limit = Math.max(1, Math.min(500, Number(opts?.limit || 150)));
    const raw = store.list({ limit });
    socket.emit("snapshot", raw.map(enrichEvent));
  });

  // 🔒 UI read-only: START/STOP disabilitati (watchtower always-on lato server)
  socket.on("watch:start", () => {
    socket.emit("watch:status", {
      running: watcherCtrl?.isRunning?.() ? true : false,
      phase: "locked",
      message: "START/STOP disabilitati: watchtower always-on (server-controlled)."
    });
  });

  socket.on("watch:stop", () => {
    socket.emit("watch:status", {
      running: watcherCtrl?.isRunning?.() ? true : false,
      phase: "locked",
      message: "START/STOP disabilitati: watchtower always-on (server-controlled)."
    });
  });
});

// --------------------
// test telegram (solo eventi)
// --------------------
app.get("/api/tg/test", (req, res) => {
  try {
    tg.enqueue({
      kind: "TEST",
      schema: "bcc_rev2",
      event: "telegram_connection_ok",
      ts: Math.floor(Date.now() / 1000),
      blockNumber: "-",
      contract: { label: APP_NAME, address: "-" },
      txHash: "-"
    });
    res.json({ ok: true, enabled: tg.isEnabled() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// --------------------
// Start server
// --------------------
server.listen(PORT, () => {
  console.log(`[watchtower] listening on :${PORT}`);
  console.log(`[watchtower] rpc: ${RPC_URL}`);
  console.log(`[watchtower] contracts: ${WATCH_CONTRACTS.length}`);
  console.log(`[watchtower] lastBlock(persisted): ${store.lastBlock ?? "—"}`);
  console.log(`[watchtower] START_BLOCK(config): ${START_BLOCK}`);

  console.log("[watchtower] always-on: auto-start at boot (no UI control).");
  startWatchtower({

   
    startBlockOverride: null, // => lastBlock se c'è, altrimenti START_BLOCK
    force: true,
    reason: "boot"
  }).catch((e) => {
    console.error("[watchtower] auto-start failed:", e?.message || e);
  });
});