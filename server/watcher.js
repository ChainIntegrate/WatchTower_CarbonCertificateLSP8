// server/watcher.js
import { ethers } from "ethers";
import { tryDecodeBCC } from "./decoders.js";
import { normalizeLog, applyDecoded } from "./normalizer.js";

const isAddr = (a) => /^0x[a-f0-9]{40}$/.test(String(a || "").toLowerCase());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal ABI: ci basta leggere lotCode dal certificato
const BCC_REV2_MIN_ABI = [
  "function getCertificate(bytes32 tokenId) view returns (tuple(address issuer,string lotCode,string productType,string scope,string period,uint8 status,uint64 createdAt,bool metadataFrozen))"
];

export async function startWatcher({
  provider,
  store,
  io,
  contracts,
  userWalletMap,
  pollIntervalMs,
  confirmations,
  startBlock,
  history,
  tg
}) {
  // --------------------
  // Setup
  // --------------------
  const addrToMeta = new Map(
    (contracts || []).map((c) => [String(c.address || "").toLowerCase(), c])
  );

  const watchAddresses = (contracts || [])
    .map((c) => String(c.address || "").toLowerCase().trim())
    .filter(isAddr);

  let running = true;
  let timer = null;

  // evita tick sovrapposti
  let tickInProgress = false;

  // cache block timestamps
  const blockTsCache = new Map(); // bn -> ts

  async function getBlockTs(bn) {
    if (blockTsCache.has(bn)) return blockTsCache.get(bn);
    const b = await provider.getBlock(bn);
    const ts = Number(b?.timestamp) || null;
    blockTsCache.set(bn, ts);

    // cache control
    if (blockTsCache.size > 2000) {
      const keys = Array.from(blockTsCache.keys()).slice(0, 500);
      for (const k of keys) blockTsCache.delete(k);
    }
    return ts;
  }

  // --------------------
  // On-chain lotCode enrichment (BCC Rev2)
  // --------------------
  const lotCache = new Map();        // key: contract|tokenId -> lotCode
  const contractCache = new Map();   // contractAddr -> ethers.Contract

  function getBccContract(addr) {
    const a = String(addr || "").toLowerCase();
    if (!a) return null;
    if (contractCache.has(a)) return contractCache.get(a);
    const c = new ethers.Contract(a, BCC_REV2_MIN_ABI, provider);
    contractCache.set(a, c);
    return c;
  }

  async function ensureLotCode(evt) {
    // Solo per BCC Rev2, e solo se non ce l'abbiamo già
    if (!evt || evt.schema !== "bcc_rev2") return evt;
    if (!evt.tokenId) return evt;
    if (evt.lotCode) return evt;

    const caddr = String(evt.contract?.address || evt.address || "").toLowerCase();
    if (!caddr) return evt;

    const tid = String(evt.tokenId).toLowerCase();
    const key = `${caddr}|${tid}`;

    const cached = lotCache.get(key);
    if (cached) {
      evt.lotCode = cached;
      return evt;
    }

    try {
      const c = getBccContract(caddr);
      if (!c) return evt;

      const cert = await c.getCertificate(tid);
      const lot = cert?.lotCode ? String(cert.lotCode) : "";

      if (lot) {
        evt.lotCode = lot;
        lotCache.set(key, lot);

        // cache control anti-leak
        if (lotCache.size > 5000) {
          const keys = Array.from(lotCache.keys()).slice(0, 1000);
          for (const k of keys) lotCache.delete(k);
        }
      }
    } catch {
      // non blocchiamo il watcher se la call fallisce
    }

    return evt;
  }

  function getSafeHead(head) {
    // confirmations=0 => realtime, ma teniamo minLag=1 per evitare “head oscillante”
    const minLag = Math.max(1, Number(confirmations || 0));
    return Math.max(0, head - minLag);
  }

  async function getBlockNumberSafe(attempts = 5) {
    let wait = 500;
    for (let i = 0; i < attempts; i++) {
      try {
        const bn = await provider.getBlockNumber();

        // guard: su chain viva, bn troppo basso è quasi certamente glitch RPC
        if (!Number.isFinite(bn) || bn < 1000) {
          throw new Error(`RPC returned suspicious blockNumber=${bn}`);
        }
        return bn;
      } catch (e) {
        const msg = String(e?.message || e);
        io.emit("error", {
          message: `RPC getBlockNumber failed (${i + 1}/${attempts}): ${msg}`
        });
        await sleep(wait);
        wait = Math.min(8000, Math.floor(wait * 1.8));
      }
    }
    throw new Error("RPC unstable: getBlockNumber keeps failing");
  }

  function isRetryableRpcError(msg) {
    const m = String(msg || "").toLowerCase();
    return (
      m.includes("invalid block range") ||
      m.includes("invalid block range params") ||
      m.includes("limit") ||
      m.includes("too many") ||
      m.includes("rate") ||
      m.includes("429") ||
      m.includes("timeout") ||
      m.includes("server_error") ||
      m.includes("failed response") ||
      m.includes("gateway") ||
      m.includes("503") ||
      m.includes("econnreset") ||
      m.includes("etimedout")
    );
  }

  async function fetchLogsRange(fromBlock, toBlock) {
    let logs = [];

    // Query per singolo address (seriale, RPC-friendly)
    for (const addr of watchAddresses) {
      if (!running) return null;
      if (!isAddr(addr)) continue;

      try {
        const part = await provider.getLogs({ fromBlock, toBlock, address: addr });
        if (Array.isArray(part) && part.length) logs.push(...part);
      } catch (e) {
        const msg = String(e?.message || e);
        if (isRetryableRpcError(msg)) return "RETRY_RANGE";
        throw e;
      }

      await sleep(80);
    }

    logs.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    return logs;
  }

  // --------------------
  // init lastSeenBlock
  // --------------------
  const head0 = await getBlockNumberSafe();
  let lastSeenBlock = startBlock;

  if (lastSeenBlock == null || Number.isNaN(Number(lastSeenBlock))) {
    lastSeenBlock = head0;
  } else {
    lastSeenBlock = Number(lastSeenBlock);
    if (lastSeenBlock < 0) lastSeenBlock = 0;
  }

  store.lastBlock = lastSeenBlock;

  // --------------------
  // tick
  // --------------------
  async function tick() {
    if (!running) return;

    const head = await getBlockNumberSafe();
    const safeHead = getSafeHead(head);

    if (lastSeenBlock >= safeHead) {
      io.emit("scan:progress", {
        status: "idle",
        head,
        safeHead,
        lastProcessed: store.lastBlock ?? lastSeenBlock,
        fromBlock: null,
        toBlock: null
      });

      io.emit("head", {
        head: safeHead,
        lastProcessed: store.lastBlock ?? lastSeenBlock
      });
      return;
    }

    const fromBlock = lastSeenBlock + 1;
    const toBlock = safeHead;

    let chunk = 200;
    const CHUNK_MIN = 25;
    const CHUNK_MAX = 200;
    let backoff = 800;

    for (let start = fromBlock; start <= toBlock; ) {
      if (!running) return;

      const end = Math.min(toBlock, start + chunk - 1);

      io.emit("scan:progress", {
        status: "catching_up",
        head,
        safeHead,
        lastProcessed: store.lastBlock ?? lastSeenBlock,
        fromBlock: start,
        toBlock: end
      });

      const logsOrSignal = await fetchLogsRange(start, end);
      if (!running) return;

      if (logsOrSignal === "RETRY_RANGE") {
        const newChunk = Math.max(CHUNK_MIN, Math.floor(chunk / 2));
        if (newChunk !== chunk) chunk = newChunk;

        io.emit("error", {
          message: `RPC unstable/rate-limited. Reducing chunk to ${chunk}. Backoff=${backoff}ms. Retrying...`
        });

        await sleep(backoff);
        backoff = Math.min(15000, Math.floor(backoff * 1.7));
        continue;
      }

      backoff = 800;

      const logs = logsOrSignal || [];

      for (const log of logs) {
        if (!running) return;

        const meta = addrToMeta.get(String(log.address).toLowerCase()) || null;
        const ts = await getBlockTs(log.blockNumber);

        // 1) envelope
        let evt = normalizeLog({
          log,
          blockTimestampSec: ts,
          contractMeta: meta,
          userWalletMap
        });

        // 2) decode (BCC + Transfer)
        const dec = tryDecodeBCC(evt.raw);

        // 3) apply decoded
        evt = applyDecoded(evt, dec, { userWalletMap });

        // 3.5) enrich lotCode from chain (per eventi che non lo portano nel log)
        evt = await ensureLotCode(evt);

        // 4) push + persist + notify
        store.push(evt);
        try { history?.append?.(evt); } catch {}
        io.emit("event", evt);
        tg?.enqueue?.(evt);
      }

      store.lastBlock = end;
      io.emit("head", { head: safeHead, lastProcessed: store.lastBlock });

      if (chunk < CHUNK_MAX) chunk = Math.min(CHUNK_MAX, chunk + 25);
      start = end + 1;
    }

    lastSeenBlock = safeHead;
  }

  // --------------------
  // Loop
  // --------------------
  const intervalMs = Math.max(800, Number(pollIntervalMs || 2500));

  timer = setInterval(async () => {
    if (!running) return;
    if (tickInProgress) return;

    tickInProgress = true;
    try {
      await tick();
    } catch (e) {
      io.emit("error", {
        message: String(e?.message || e),
        stack: e?.stack ? String(e.stack) : null
      });
    } finally {
      tickInProgress = false;
    }
  }, intervalMs);

  // first head push
  try {
    io.emit("head", { head: await getBlockNumberSafe(), lastProcessed: lastSeenBlock });
  } catch {}

  return {
    stop: () => {
      running = false;
      if (timer) clearInterval(timer);
    },
    isRunning: () => running,
    lastProcessed: () => store.lastBlock ?? lastSeenBlock,
    getState: () => ({ watchAddresses, lastSeenBlock })
  };
}