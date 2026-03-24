// server/history.js
import fs from "fs";
import path from "path";

function safeJsonParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Valida minima di un evento (evitiamo di caricare roba sporcata)
 */
function isValidEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  // minimi indispensabili per UI
  if (ev.txHash && typeof ev.txHash !== "string") return false;
  if (ev.blockNumber != null && !Number.isFinite(Number(ev.blockNumber))) return false;
  // ok anche se mancano campi: è tail loader, non schema enforcer
  return true;
}

/**
 * Legge "la coda" di un file grande, senza caricarlo tutto.
 * Prende gli ultimi `maxLines` JSON (NDJSON).
 */
export function loadTailEvents(filePath, maxLines = 800) {
  if (!fs.existsSync(filePath)) return [];

  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (!size) return [];

    const CHUNK = 1024 * 256; // 256KB
    let pos = size;
    let buf = "";
    let lines = [];

    while (pos > 0 && lines.length <= maxLines + 50) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;

      const b = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, b, 0, readSize, pos);

      // prepend chunk
      buf = b.toString("utf8") + buf;

      // split
      lines = buf.split("\n");
    }

    // Prendi le ultime righe non vuote
    const tail = lines
      .map((s) => String(s || "").replace(/^\uFEFF/, "").trim()) // BOM + trim
      .filter(Boolean)
      .slice(-maxLines);

    const out = [];
    for (const ln of tail) {
      const ev = safeJsonParse(ln);
      if (ev && isValidEvent(ev)) out.push(ev);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writer NDJSON con stream e backpressure handling.
 * - append(event): enqueue di una riga
 * - appendMany(events): enqueue batch
 * - flush(): Promise che risolve quando la coda è scaricata
 * - stop(): chiude lo stream
 */
export function createHistoryWriter({ dir, filename = "events.ndjson" }) {
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, filename);
  const stream = fs.createWriteStream(filePath, { flags: "a" });

  let closed = false;

  // coda di promesse per gestire drain
  let pending = 0;
  let lastDrainPromise = null;

  function writeLine(line) {
    if (closed) return;

    pending++;
    const ok = stream.write(line, "utf8", () => {
      pending = Math.max(0, pending - 1);
    });

    // backpressure: se ok=false aspetta 'drain'
    if (!ok) {
      if (!lastDrainPromise) {
        lastDrainPromise = new Promise((resolve) => {
          stream.once("drain", () => {
            lastDrainPromise = null;
            resolve();
          });
        });
      }
    }
  }

  function append(eventObj) {
    if (closed) return;
    const line = JSON.stringify(eventObj) + "\n";
    writeLine(line);
  }

  function appendMany(events) {
    if (closed) return;
    if (!Array.isArray(events) || !events.length) return;
    for (const ev of events) append(ev);
  }

  async function flush() {
    // se c'è drain pendente, aspetta
    if (lastDrainPromise) await lastDrainPromise;

    // aspetta che le callback write abbiano scaricato pending
    // (non è perfetto al 100% ma è sufficiente per "shutdown pulito")
    const start = Date.now();
    while (pending > 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function stop() {
    if (closed) return;
    closed = true;
    try { stream.end(); } catch {}
  }

  // se stream va in errore, loggare è responsabilità del chiamante,
  // ma almeno evitiamo crash silenziosi
  stream.on("error", (e) => {
    // non throw: se no muore il processo
    console.warn("[history] stream error:", e?.message || e);
  });

  return { filePath, append, appendMany, flush, stop };
}