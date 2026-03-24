// client.js (watchtower BCC Rev2) — UI Watchtower
const SOCKET_PATH = "/wr_cfp/socket.io"; // <<< DEVE combaciare col server
const socket = io({ path: SOCKET_PATH });

const $ = (id) => document.getElementById(id);

// 🔒 UI read-only: watchtower always-on gestita dal server (auto-start)
const READ_ONLY_UI = true;

function lockControls() {
  const bStart = $("btnStart");
  const bStop  = $("btnStop");
  const inSb   = $("inStartBlock");

  if (bStart) {
    bStart.disabled = true;
    bStart.textContent = "START (auto)";
    bStart.title = "Gestito dal server (auto-start al boot)";
  }
  if (bStop) {
    bStop.disabled = true;
    bStop.textContent = "STOP (locked)";
    bStop.title = "Disabilitato per sicurezza (always-on)";
  }
  if (inSb) {
    inSb.disabled = true;
    inSb.placeholder = "Gestito dal server";
    inSb.title = "Start block gestito dal server";
  }
}

// ----------------------
// Mint index (optional enrichment)
// ----------------------
const MINT_INDEX_URL = "https://www.chainintegrate.it/develop/data/mint_index.json";
const MINT_INDEX_REFRESH_MS = 5 * 60 * 1000;

// Se il mint_index del BCC usa altri codici, qui mappa come vuoi.
// (Il tuo mint_index TRC2 usava 0/1/2 Valid/Revoked/Superseded)
const STATUS_LABEL = {
  0: "Collecting",
  1: "Frozen",
  2: "Revoked",
};

let mintIndex = {
  updatedAt: null,
  byToken: {}, // tokenId(lowercase) -> item
  byCert: {},  // certificateId(uppercase) -> item
};

const MAX_UI_EVENTS = 800;
const UI_VERSION = "watchtower-ui/2.0.0";
const UI_BUILD = "2026-02-25 18:00";

let maxRender = 250;
const RENDER_STEP = 250;
const RENDER_MAX = 5000;

let historyMode = false;

const state = {
  contracts: [],
  events: [],
  filtered: [],
  selected: null,
  head: null,

  totalReceived: 0,
  dropped: 0,
};

let pendingStartBlock = null;

let currentLimit = 500;
const LIMIT_STEP = 500;
const LIMIT_MAX = 5000;

function normAddr(a) { return String(a || "").toLowerCase(); }
function normTok(t) { return String(t || "").toLowerCase(); }
function normCert(c) { return String(c || "").trim().toUpperCase(); }

async function loadMintIndex() {
  try {
    const r = await fetch(MINT_INDEX_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();

    const items = Array.isArray(j?.items) ? j.items : [];
    const byToken = {};
    const byCert = {};

    for (const it of items) {
      const tok = normTok(it.tokenId);
      if (tok) byToken[tok] = it;

      const cert = normCert(it.certificateId);
      if (cert) byCert[cert] = it;
    }

    mintIndex = {
      updatedAt: j?.updatedAt || null,
      byToken,
      byCert,
    };
  } catch (e) {
    console.warn("mint_index load failed", e);
    mintIndex = { updatedAt: null, byToken: {}, byCert: {} };
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function shortAddr(a) {
  const s = String(a || "");
  if (!s.startsWith("0x") || s.length < 12) return s;
  return s.slice(0, 6) + "…" + s.slice(-4);
}

function tokenHuman(tokenId, e = null) {
  const tok = normTok(tokenId);
  if (!tok) return "—";

  // 1) fonte primaria: mint_index
  const it = mintIndex.byToken[tok];
  if (it?.certificateId) return `${it.certificateId} (${shortAddr(tok)})`;

  // 2) fallback: lotCode dal log (BCC)
  const lot = e?.lotCode ? String(e.lotCode).trim() : "";
  if (lot) return `${lot} (${shortAddr(tok)})`;

  return shortAddr(tok);
}

function tokenMeta(tokenId) {
  const tok = normTok(tokenId);
  const it = mintIndex.byToken[tok];
  if (!it) return null;
  return {
    cert: it.certificateId || "",
    status: STATUS_LABEL[it.status] || String(it.status ?? ""),
    ts: it.ts || "",
    contract: normAddr(it.contract || ""),
  };
}

function labelOf(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object" && x.label) return String(x.label);
  return "";
}

function fmtAddr(addr, labelObj) {
  const a = String(addr || "");
  if (!a) return "—";
  const lbl = labelOf(labelObj);
  return lbl ? `${lbl} (${shortAddr(a)})` : shortAddr(a);
}

function fmtContract(e) {
  const addr = String(e?.contract?.address || e?.address || "");
  const lbl = labelOf(e?.labels?.contract) || (e?.contract?.label || "");
  if (!addr) return "—";
  return lbl ? `${lbl}` : shortAddr(addr);
}

function buildHay(x) {
  const tok = String(x.tokenId || "");
  const meta = tok ? tokenMeta(tok) : null;

  return [
    x.txHash,
    x.contract?.address,
    x.address,
    x.contract?.label,

    x.from,
    x.to,
    x.operator,
    x.issuer,
    x.actor,

    // labels
    x.labels?.from?.label,
    x.labels?.to?.label,
    x.labels?.contract?.label,
    x.labels?.issuer,
    x.labels?.actor,

    x.kind,
    x.event,
    x.schema,

    x.tokenId,
    x.lotCode,
    x.uri,
    x.digest,

    meta?.cert,
    meta?.status,

    x.raw?.topic0,
  ]
  .map((v) => String(v || "").toLowerCase())
  .join(" ");
}

// ---------- BADGES (BCC Rev2) ----------
function badgeAcronym(e){
  const kind = String(e?.kind || "").toUpperCase();
  const ev   = String(e?.event || "").trim();

  // BCC Rev2
  if (kind === "MINT_CERT") return "MINT";
  if (kind === "STATUS") return "STS";
  if (kind === "AUTHORIZE") return "AUTH";
  if (kind === "SUBMIT") return "SUB";
  if (kind === "FREEZE") return "FRZ";
  if (kind === "AGGREGATE") return "AGG";
  if (kind === "METADATA") return "URI";
  if (kind === "METADATA_FREEZE") return "URF";
  if (kind === "ADMIN") return "ADM";

  // Transfer family
  if (kind === "MINT") return "MINT";
  if (kind === "TRANSFER") return "TRF";
  if (kind === "BURN") return "BRN";

  // LOG generico ma decodificato
  if (ev) return "EVT";
  return kind || "LOG";
}

function kindBadgeClass(kind, eventName = "", e = null) {
  const k = String(kind || "").toUpperCase();
  const ev = String(eventName || "").trim();

  // StatusChanged: colore per statusLabel
  if (ev === "CertificateStatusChanged" || k === "STATUS") {
    const st = (e?.status != null) ? Number(e.status) : null;
    if (st === 0) return "ok";    // Collecting
    if (st === 1) return "warn";  // Frozen
    if (st === 2) return "err";   // Revoked
    return "warn";
  }

  if (k === "MINT_CERT") return "ok";
  if (k === "AUTHORIZE") return "ok";
  if (k === "SUBMIT") return "ok";
  if (k === "FREEZE") return "warn";
  if (k === "AGGREGATE") return "ok";
  if (k === "METADATA" || k === "METADATA_FREEZE") return "ok";
  if (k === "ADMIN") return "warn";

  if (k === "TRANSFER") return "ok";
  if (k === "MINT") return "ok";
  if (k === "BURN") return "err";

  if (k === "LOG" && ev) return "ok";
  return "";
}

/* ===========================
   Render throttling
   =========================== */
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function rebuildHayAll() {
  for (const ev of state.events) ev._hay = buildHay(ev);
}

/* ===========================
   Fetch storico (server-side) + filtri client-side
   =========================== */
async function fetchFilteredFromServer() {
  const typeRaw = $("fType").value.trim();
  const type = typeRaw.toUpperCase();

  const contract = $("fContract").value.trim().toLowerCase();
  const q = $("fQ").value.trim().toLowerCase();
  const from = $("fFrom")?.value?.trim() || "";
  const to = $("fTo")?.value?.trim() || "";

  const params = new URLSearchParams();
  params.set("limit", String(currentLimit));

  // backend understands ONLY these types: TRANSFER/MINT/BURN/LOG (+ your app kinds if you decide)
  const SERVER_TYPES = new Set(["TRANSFER","MINT","BURN","LOG"]);
  if (type && SERVER_TYPES.has(type)) params.set("type", type);

  if (contract) params.set("contract", contract);
  if (q) params.set("q", q);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  state.filtered = [];
  state.events = [];
  state.selected = null;
  scheduleRender();
  setBuf(0);

  const r = await fetch("./api/events?" + params.toString(), { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);

  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "api/events failed");

  const arr = Array.isArray(j.events) ? j.events : [];

  for (const ev of arr) {
    ev._addr = String(ev.contract?.address || ev.address || "").toLowerCase();
    ev._kind = String(ev.kind || "").toUpperCase();
    ev._hay = buildHay(ev);
  }

  state.events = arr;

  let filtered = arr;

  // ---- BCC domain filtering (client-side) ----
  if (type.startsWith("BCC:")) {
    const want = type.split(":")[1]; // es: "STATUS" | "SUBMIT"
    filtered = filtered.filter(ev => String(ev.kind || "").toUpperCase() === want);
  }

  // ---- solo filtri base (no token/cert box) ----
  state.filtered = filtered;

  if (historyMode) {
    maxRender = Math.min(maxRender, state.filtered.length, RENDER_MAX);
  }

  scheduleRender();
  setBuf(arr.length);
  state.totalReceived = arr.length;
  state.dropped = 0;
}

/* ===========================
   Render list
   =========================== */
function render() {
  const list = $("list");
  list.innerHTML = "";

  const fType = $("fType").value.trim();
  const fContract = $("fContract").value.trim();
  const q = $("fQ").value.trim();
  const hasUserFilters = !!(fType || fContract || q);

  const limitByUi = historyMode ? true : hasUserFilters;

  const toShow = limitByUi
    ? state.filtered.slice(0, maxRender)
    : state.filtered;

  for (const e of toShow) {
    const row = document.createElement("div");
    row.className = "row";
    row.onclick = () => selectEvent(e);

    const kind = String(e.kind || "LOG").toUpperCase();
    const evName = String(e.event || "").trim();
    const badgeText = badgeAcronym(e);

    const contractLabel = fmtContract(e);

    const fromTo = (e.from && e.to)
      ? `${fmtAddr(e.from, e.labels?.from)} → ${fmtAddr(e.to, e.labels?.to)}`
      : `log: ${fmtAddr(e.contract?.address, e.labels?.contract)}`;

    const extra =
      (e.lotCode ? `lot=${e.lotCode}` : "") ||
      (e.digest ? `digest=${shortAddr(e.digest)}` : "") ||
      (e.tokenId ? `token=${tokenHuman(e.tokenId, e)}` : "") ||
      (e.uri ? `uri=${e.uri}` : "");

    const when = e.ts ? new Date(e.ts * 1000).toLocaleString() : `block ${e.blockNumber}`;

    row.innerHTML = `
      <span class="badge ${kindBadgeClass(kind, evName, e)}" title="${esc(evName || kind)}">${esc(badgeText)}</span>
      <div class="small"><b>${esc(contractLabel)}</b><div class="small">${esc(fromTo)}</div></div>
      <div class="small">${esc(extra || "—")}</div>
      <div class="small">${esc(when)}</div>
    `;

    list.appendChild(row);
  }

  const btn = $("btnShowMore");
  if (btn) btn.disabled = (state.filtered.length <= maxRender);

  if (limitByUi && !state.selected) {
    const shown = toShow.length;
    const total = state.filtered.length;

    if (total === 0) $("detail").textContent = "0 risultati (filtri attivi).";
    else if (shown < total) $("detail").textContent = `Mostrati ${shown} di ${total} risultati. Usa "Mostra altri" per vedere oltre.`;
    else $("detail").textContent = `Mostrati ${shown} di ${total} risultati.`;
  }
}

function fmtWhen(e) {
  if (e?.ts) return new Date(Number(e.ts) * 1000).toLocaleString();
  if (e?.blockNumber != null) return `block ${e.blockNumber}`;
  return "—";
}

/* ===========================
   Detail
   =========================== */
function renderEventDetailCompact(e) {
  const kind = String(e?.kind || "LOG").toUpperCase();
  const evName = String(e?.event || "").trim();
  const badgeText = evName ? evName : kind;

  const contractAddr = String(e?.contract?.address || e?.address || "");
  const contractLabel = fmtContract(e);
  const tx = String(e?.txHash || "");
  const when = fmtWhen(e);

  const fromTo = (e?.from && e?.to)
    ? `${fmtAddr(e.from, e.labels?.from)} → ${fmtAddr(e.to, e.labels?.to)}`
    : "—";

  const tokenIdRaw = (e?.tokenId != null && e?.tokenId !== "") ? String(e.tokenId) : "";
  const tokenId = tokenIdRaw ? tokenHuman(tokenIdRaw, e) : "—";

  const meta = tokenIdRaw ? tokenMeta(tokenIdRaw) : null;
  const metaLine = meta
    ? `${meta.status}${meta.cert ? ` • ${meta.cert}` : ""}${meta.ts ? ` • ${new Date(meta.ts).toLocaleString("it-IT")}` : ""}`
    : "";

  const logIndex = (e?.logIndex != null) ? String(e.logIndex) : "—";
  const schema = (e?.schema != null && e?.schema !== "") ? String(e.schema) : "—";

  const el = $("detail");

  el.innerHTML = `
<div class="mono" style="white-space:normal">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
    <span class="badge ${kindBadgeClass(kind, evName, e)}">${esc(badgeText)}</span>
    <b>${esc(contractLabel)}</b>
    <span class="small">${esc(shortAddr(contractAddr))}</span>
  </div>

  <div class="small"><b>When:</b> ${esc(when)}</div>
  ${metaLine ? `<div class="small"><b>MintIndex:</b> ${esc(metaLine)}</div>` : ``}
  <div class="small"><b>Schema:</b> ${esc(schema)} &nbsp; <b>Event:</b> ${esc(evName || "—")}</div>

  <div class="small"><b>From→To:</b> ${esc(fromTo)}</div>
  <div class="small"><b>Token:</b> ${esc(tokenId)} &nbsp; <b>logIndex:</b> ${esc(logIndex)}</div>

  ${e?.lotCode ? `<div class="small" style="overflow-wrap:anywhere"><b>lotCode:</b> ${esc(e.lotCode)}</div>` : ``}
  ${e?.roleLabel ? `<div class="small"><b>role:</b> ${esc(e.roleLabel)}</div>` : ``}
  ${e?.statusLabel ? `<div class="small"><b>status:</b> ${esc(e.statusLabel)}</div>` : ``}
  ${e?.digest ? `<div class="small" style="overflow-wrap:anywhere"><b>digest:</b> ${esc(e.digest)}</div>` : ``}
  ${e?.uri ? `<div class="small" style="overflow-wrap:anywhere"><b>uri:</b> ${esc(e.uri)}</div>` : ``}

  <div class="small" style="overflow-wrap:anywhere"><b>Tx:</b> ${esc(tx || "—")}</div>

  <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
    <button class="btn secondary" id="btnTxLogs" ${tx ? "" : "disabled"}>Mostra log della TX</button>
    <button class="btn secondary" id="btnCopyTx" ${tx ? "" : "disabled"}>Copia txHash</button>
    <button class="btn" id="btnVerify" ${(tx && (e?.logIndex != null) && contractAddr) ? "" : "disabled"}>
      Verifica on-chain
    </button>
  </div>

  <div id="verifyBox" style="margin-top:12px;display:none"></div>
  <div id="txLogsBox" style="margin-top:12px;display:none"></div>

  <pre style="margin-top:12px;white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(e, null, 2))}</pre>
</div>
`;

  const btnCopy = document.getElementById("btnCopyTx");
  if (btnCopy && tx) {
    btnCopy.onclick = async () => {
      try { await navigator.clipboard.writeText(tx); } catch {}
    };
  }

  const btnTx = document.getElementById("btnTxLogs");
  if (btnTx && tx) btnTx.onclick = () => toggleTxLogs(tx, e);

  const btnVerify = document.getElementById("btnVerify");
  if (btnVerify && tx && (e?.logIndex != null) && contractAddr) btnVerify.onclick = () => verifyOnChain(e);
}

let txLogsCache = new Map();

async function toggleTxLogs(txHash, clickedEvent) {
  const box = document.getElementById("txLogsBox");
  if (!box) return;

  const isOpen = box.style.display !== "none";
  if (isOpen) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  box.style.display = "block";
  box.innerHTML = `<div class="small">Carico log della TX…</div>`;

  try {
    let events = txLogsCache.get(txHash);

    if (!events) {
      const r = await fetch(`./api/events/${encodeURIComponent(txHash)}`, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "api/events/:txHash failed");

      events = Array.isArray(j.events) ? j.events : [];
      events.sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0));
      for (const ev of events) ev._hay = buildHay(ev);

      txLogsCache.set(txHash, events);
    }

    const rows = events.map((ev) => {
      const k = String(ev.kind || "LOG").toUpperCase();
      const evName = String(ev.event || "").trim();
      const badgeText = evName ? evName : k;

      const addr = String(ev.contract?.address || ev.address || "");
      const li = (ev.logIndex ?? "—");
      const isThis = (clickedEvent?.logIndex != null && ev.logIndex === clickedEvent.logIndex);

      const extra =
        (ev.lotCode ? `lot=${ev.lotCode}` : "") ||
        (ev.tokenId ? `token=${tokenHuman(ev.tokenId, ev)}` : "") ||
        (ev.digest ? `digest=${shortAddr(ev.digest)}` : "");

      return `
<div class="row" style="grid-template-columns:110px 1fr;cursor:pointer;opacity:${isThis ? "1" : "0.95"}"
     data-li="${esc(li)}">
  <div><span class="badge ${kindBadgeClass(k, evName, ev)}">${esc(badgeText)}</span></div>
  <div class="small">
    <b>${esc(fmtContract(ev))}</b>
    <div class="small">logIndex: ${esc(li)} • ${esc(fmtAddr(addr, ev.labels?.contract))}</div>
    ${extra ? `<div class="small">${esc(extra)}</div>` : ``}
  </div>
</div>`;
    }).join("");

    box.innerHTML = `
<div class="small" style="margin-bottom:8px"><b>TX logs:</b> ${events.length} eventi</div>
<div class="list">${rows}</div>
<div class="small" style="margin-top:10px;color:var(--muted)">Tip: clicca una riga per vedere il JSON completo di quel log.</div>
`;

    box.querySelectorAll(".row").forEach((el) => {
      el.addEventListener("click", () => {
        const li = el.getAttribute("data-li");
        const ev = events.find(x => String(x.logIndex ?? "—") === String(li));
        if (!ev) return;

        const detail = $("detail");
        const pre = detail.querySelector("pre");
        if (pre) pre.textContent = JSON.stringify(ev, null, 2);
      });
    });

  } catch (err) {
    box.innerHTML = `<div class="small">Errore: ${esc(err?.message || String(err))}</div>`;
  }
}

async function verifyOnChain(e) {
  const box = document.getElementById("verifyBox");
  if (!box) return;

  const isOpen = box.style.display !== "none";
  if (isOpen) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  const txHash = String(e?.txHash || "").toLowerCase();
  const logIndex = Number(e?.logIndex);
  const address = String(e?.raw?.address || e?.contract?.address || "").toLowerCase();

  const topic0 = String(e?.raw?.topic0 || "").toLowerCase();
  const topics = Array.isArray(e?.raw?.topics) ? e.raw.topics.map(t => String(t).toLowerCase()) : [];
  const data = String(e?.raw?.data || "0x").toLowerCase();

  box.style.display = "block";
  box.innerHTML = `<div class="small">Verifico on-chain…</div>`;

  try {
    const params = new URLSearchParams();
    params.set("txHash", txHash);
    params.set("logIndex", String(logIndex));
    params.set("address", address);
    params.set("topic0", topic0);
    params.set("topics", topics.join(","));
    params.set("data", data);

    const r = await fetch(`./api/verify-log?${params.toString()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);

    const j = await r.json();
    if (!j.ok) {
      box.innerHTML = `
        <div class="small">
          <b style="color:var(--err)">✗ Verifica fallita</b><br/>
          <span class="mono">${esc(j.status || "error")}</span> — ${esc(j.reason || j.error || "unknown")}
        </div>
      `;
      return;
    }

    box.innerHTML = `
      <div class="small">
        <b style="color:var(--ok)">✓ Verificato</b> — il log corrisponde alla chain.
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="small"><b style="color:var(--err)">✗ Errore</b> — ${esc(err?.message || String(err))}</div>`;
  }
}

async function selectEvent(e) {
  state.selected = e;
  renderEventDetailCompact(e);
  try { $("detail").scrollIntoView({ behavior: "smooth", block: "start" }); } catch {}
}

let filterTimer = null;
function applyFilters() {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(async () => {
    filterTimer = null;
    try {
      await fetchFilteredFromServer();
    } catch (e) {
      console.warn("filter fetch failed", e);
    }
  }, 220);
}

async function loadContracts() {
  const r = await fetch("./api/contracts", { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);

  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "api/contracts failed");

  state.contracts = Array.isArray(j.contracts) ? j.contracts : [];

  const sel = $("fContract");
  const prev = sel.value;
  sel.innerHTML = `<option value="">Tutti</option>`;

  for (const c of state.contracts) {
    const addr = String(c?.address || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;

    const opt = document.createElement("option");
    opt.value = addr;
    opt.textContent = `${c.label || shortAddr(addr)} — ${shortAddr(addr)}`;
    sel.appendChild(opt);
  }

  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function setRpcStatus(ok, txt) {
  $("dotRpc").className = "dot" + (ok ? " ok" : " err");
  $("txtRpc").textContent = txt;
}

function setRunStatus(running, txt) {
  $("dotRun").className = "dot" + (running ? " ok" : " warn");
  $("txtRun").textContent = txt;

  if (READ_ONLY_UI) {
    lockControls();
    return;
  }

  $("btnStart").disabled = !!running;
  $("btnStop").disabled = !running;
}

function setHead(head, lastProcessed) {
  $("txtHead").textContent = `Head: ${head} • last: ${lastProcessed}`;
}

function setBuf(n) {
  const total = state.totalReceived || 0;
  const dropped = state.dropped || 0;

  if (historyMode) {
    const loaded = n;
    const shown = Math.min(loaded, maxRender);
    $("txtBuf").textContent = `Storico: ${loaded}/${currentLimit} • mostrati ${shown}/${loaded}`;
    return;
  }

  $("txtBuf").textContent =
    `Buffer: ${n}/${MAX_UI_EVENTS} • total: ${total}` +
    (dropped ? ` • dropped: ${dropped}` : "");
}

// ---------------- UI throttle head/progress ----------------
let lastHeadUiAt = 0;
let pendingHeadUi = null;

let lastProgUiAt = 0;
let pendingProgUi = null;

let scanningUntil = 0;
function isScanningNow() { return Date.now() < scanningUntil; }

function scheduleHeadUi(updateObj) {
  pendingHeadUi = updateObj;
  if (isScanningNow()) return;

  const now = Date.now();
  if (now - lastHeadUiAt < 350) return;
  lastHeadUiAt = now;

  const u = pendingHeadUi;
  pendingHeadUi = null;
  if (u) setHead(u.head, u.lastProcessed);
}

function scheduleProgressUi(p) {
  pendingProgUi = p;
  scanningUntil = Date.now() + 1200;

  const now = Date.now();
  if (now - lastProgUiAt < 200) return;
  lastProgUiAt = now;

  const u = pendingProgUi;
  pendingProgUi = null;
  if (!u) return;

  const status = u?.status || "—";
  const safe = u?.safeHead ?? "—";
  const last = u?.lastProcessed ?? "—";

  if (status === "idle") {
    $("txtHead").textContent = `Head: ${safe} (safe) • last: ${last} • idle`;
    return;
  }

  const from = u?.fromBlock ?? "—";
  const to = u?.toBlock ?? "—";
  $("txtHead").textContent = `Head: ${safe} (safe) • scan: ${from}→${to} • last: ${last}`;
}

// --------- UI events ---------
$("fType").addEventListener("change", applyFilters);
$("fContract").addEventListener("change", applyFilters);
$("fFrom")?.addEventListener("change", applyFilters);
$("fTo")?.addEventListener("change", applyFilters);

let qTimer = null;

$("fQ").addEventListener("input", () => {
  if (qTimer) clearTimeout(qTimer);
  qTimer = setTimeout(() => { qTimer = null; applyFilters(); }, 180);
});

$("btnMore").addEventListener("click", () => {
  historyMode = true;
  currentLimit = Math.min(currentLimit + LIMIT_STEP, LIMIT_MAX);
  applyFilters();
});

$("btnStart").addEventListener("click", () => {
  if (READ_ONLY_UI) {
    alert("Comandi START/STOP disabilitati: watchtower always-on gestita dal server.");
    return;
  }

  const raw = $("inStartBlock").value;
  const startBlock = raw !== "" ? parseInt(raw, 10) : null;
  pendingStartBlock = startBlock;

  socket.emit("watch:start", { startBlock });
  setRunStatus(true, "Watch: starting…");
});

$("btnStop").addEventListener("click", () => {
  if (READ_ONLY_UI) {
    alert("Comandi START/STOP disabilitati: watchtower always-on gestita dal server.");
    return;
  }

  socket.emit("watch:stop");
  setRunStatus(false, "Watch: stopping…");
});

$("btnShowMore").addEventListener("click", () => {
  const total = state.filtered.length;
  maxRender = Math.min(maxRender + RENDER_STEP, total, RENDER_MAX);
  scheduleRender();
  if (historyMode) setBuf(state.events.length);
});

$("btnClear").addEventListener("click", () => {
  historyMode = false;
  currentLimit = 500;
  maxRender = 250;
  $("fType").value = "";
  $("fContract").value = "";
  $("fQ").value = "";
  state.selected = null;
  $("detail").textContent = "—";
  if ($("fFrom")) $("fFrom").value = "";
  if ($("fTo")) $("fTo").value = "";
  applyFilters();
});

const btnTop = $("btnTop");
function updateTopBtn() { btnTop.style.display = (window.scrollY > 350) ? "block" : "none"; }
window.addEventListener("scroll", updateTopBtn, { passive: true });
updateTopBtn();
btnTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

// --------- Socket.IO ---------
socket.on("watch:status", (st) => {
  const phase = String(st?.phase || "");
  const running = !!st?.running;
  const msg = st?.message ? ` • ${st.message}` : "";

  if (phase === "confirm") {
    setRunStatus(false, "Watch: idle • serve conferma");

    const ok = confirm(
      st?.message ||
      "ATTENZIONE: startBlock precedente all'ultimo blocco salvato. Rischi duplicati nello storico. Confermi?"
    );

    if (ok) {
      socket.emit("watch:start", { startBlock: pendingStartBlock, force: true });
      setRunStatus(true, "Watch: starting… • confermato");
    } else {
      setRunStatus(false, "Watch: idle");
    }
    return;
  }

  if (phase === "starting") {
    setRunStatus(true, "Watch: starting…" + msg);
    return;
  }

  setRunStatus(running, running ? "Watch: running" + msg : "Watch: idle" + msg);

  if (running) {
    socket.emit("snapshot", { limit: 500 });
  } else {
    state.events = [];
    state.filtered = [];
    state.totalReceived = 0;
    state.dropped = 0;
    state.selected = null;
    setBuf(0);
    scheduleRender();
  }
});

socket.on("hello", () => {
  setRpcStatus(true, "RPC: connected");
  setRunStatus(false, "Watch: idle");
  socket.emit("snapshot", { limit: 500 });
  if (READ_ONLY_UI) lockControls();
});

socket.on("snapshot", (events) => {
  state.events = Array.isArray(events) ? events : [];
  for (const ev of state.events) {
    ev._addr = String(ev.contract?.address || ev.address || "").toLowerCase();
    ev._kind = String(ev.kind || "").toUpperCase();
    ev._hay = buildHay(ev);
  }

  state.totalReceived = Math.max(state.totalReceived || 0, state.events.length);

  if (state.events.length > MAX_UI_EVENTS) {
    const overflow = state.events.length - MAX_UI_EVENTS;
    state.events.length = MAX_UI_EVENTS;
    state.dropped = (state.dropped || 0) + overflow;
  }

  setBuf(state.events.length);
  applyFilters();
});

socket.on("event", (evt) => {
  state.totalReceived = (state.totalReceived || 0) + 1;

  evt._addr = String(evt.contract?.address || evt.address || "").toLowerCase();
  evt._kind = String(evt.kind || "").toUpperCase();
  evt._hay = buildHay(evt);

  state.events.unshift(evt);

  if (state.events.length > MAX_UI_EVENTS) {
    const overflow = state.events.length - MAX_UI_EVENTS;
    state.events.length = MAX_UI_EVENTS;
    state.dropped = (state.dropped || 0) + overflow;
  }

  applyFilters();
  setBuf(state.events.length);
});

socket.on("head", (h) => {
  scheduleHeadUi({
    head: h?.head ?? "—",
    lastProcessed: h?.lastProcessed ?? "—",
  });
});

socket.on("scan:progress", (p) => {
  scheduleProgressUi(p);
});

socket.on("error", (e) => {
  const msg = String(e?.message || "");
  const isRateLimit = /rate-limited|backoff|reducing chunk|unstable/i.test(msg);

  if (isRateLimit) {
    setRpcStatus(false, "RPC: slow (backoff)");
    console.warn("watchtower rpc backoff", e);
    return;
  }

  setRpcStatus(false, "RPC: error");
  console.warn("watchtower error", e);
  if (e?.stack) console.warn("stack:\n" + e.stack);
});

// boot
(async function init() {
  try {
    const elV = $("uiVersion");
    const elB = $("uiBuild");
    if (elV) elV.textContent = UI_VERSION;
    if (elB) elB.textContent = UI_BUILD;
  } catch {}

  try {
    await loadContracts();
  } catch (e) {
    console.warn("contracts load failed", e);
  }

  await loadMintIndex();

  if (state.events.length) {
    rebuildHayAll();
    scheduleRender();
  }

  if (MINT_INDEX_REFRESH_MS > 0) {
    setInterval(async () => {
      const prevUpdatedAt = mintIndex.updatedAt;
      await loadMintIndex();

      if (mintIndex.updatedAt && mintIndex.updatedAt !== prevUpdatedAt) {
        rebuildHayAll();
        scheduleRender();
      }
    }, MINT_INDEX_REFRESH_MS);
  }

  if (READ_ONLY_UI) lockControls();
})();