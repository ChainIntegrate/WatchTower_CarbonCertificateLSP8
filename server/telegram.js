// server/telegram.js
// Telegram notifier (BCC Rev2) - messaggi "umani" per eventi BCC Rev2
// parse_mode HTML

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------
// helpers output / format
// -------------------------
function safeText(s, max = 3500) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function shortHex(h, left = 10, right = 8) {
  const s = String(h || "");
  if (!s.startsWith("0x")) return s;
  if (s.length <= left + right + 2) return s;
  return s.slice(0, left) + "…" + s.slice(-right);
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function link(url, label) {
  if (!url) return escHtml(label);
  return `<a href="${escHtml(url)}">${escHtml(label)}</a>`;
}

function fmtUtcFromSec(sec) {
  const n = Number(sec || 0);
  if (!n) return "—";
  return new Date(n * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function fmtTokenId(tokenId) {
  if (!tokenId) return "—";
  return `<code>${escHtml(shortHex(String(tokenId), 14, 10))}</code>`;
}

function fmtAddr(a, labelsMap = null) {
  if (!a) return "—";
  const lc = String(a).toLowerCase();
  const label = labelsMap?.[lc]?.label || labelsMap?.[lc] || null;
  if (label) return `${escHtml(label)} <code>${escHtml(shortHex(lc, 10, 8))}</code>`;
  return `<code>${escHtml(shortHex(lc, 14, 10))}</code>`;
}

function pickEvtTs(evt) {
  const t = evt?.ts ?? evt?.timestamp ?? evt?.blockTimestampSec;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- Nr umano: PACK-75-0428 -> 0428
function humanNrFromLot(lotCode) {
  const s = String(lotCode || "").trim();
  if (!s) return null;
  const m = s.match(/-([A-Za-z0-9]+)$/);
  return m ? m[1] : null;
}

function pushLotLines(lines, evt) {
  const lot = evt?.lotCode ? String(evt.lotCode) : "";
  if (!lot) return;
  const human = humanNrFromLot(lot);
  lines.push(`Lot: <b>${escHtml(lot)}</b>${human ? ` — Nr: <b>${escHtml(human)}</b>` : ""}`);
}

// -------------------------
// main factory
// -------------------------
export function createTelegramNotifier({
  token,
  chatId,
  enabled = true,
  minIntervalMs = 1200,
  maxQueue = 200,

  allowKinds = null,      // Set([...]) oppure null
  allowContracts = null,  // Set([...]) oppure null
  allowSchemas = null,    // Set([...]) oppure null

  explorerTxBase = null,
  explorerBlockBase = null,

  showContractLine = true,
  showDigest = true,
  showUri = true,
} = {}) {
  const on = enabled && token && chatId;
  const api = token ? `https://api.telegram.org/bot${token}` : null;

  let q = [];
  let busy = false;

  function pass(evt) {
    if (!evt) return false;

    const kind = String(evt.kind || "").toUpperCase();
    const caddr = String(evt.contract?.address || evt.address || "").toLowerCase();
    const schema = String(evt.schema || evt.decoded?.schema || "").toLowerCase();

    if (allowKinds && allowKinds.size && !allowKinds.has(kind)) return false;
    if (allowContracts && allowContracts.size && !allowContracts.has(caddr)) return false;
    if (allowSchemas && allowSchemas.size && !allowSchemas.has(schema)) return false;

    return true;
  }

  function txLink(txHash) {
    if (!txHash) return "—";
    if (!explorerTxBase) return `<code>${escHtml(shortHex(txHash, 14, 10))}</code>`;
    return link(`${explorerTxBase}${txHash}`, shortHex(txHash, 14, 10));
  }

  function blockLink(bn) {
    if (bn == null || bn === "—") return "—";
    if (!explorerBlockBase) return `<code>${escHtml(String(bn))}</code>`;
    return link(`${explorerBlockBase}${bn}`, `#${bn}`);
  }

  function roleBadge(roleLabel) {
    const r = String(roleLabel || "").toUpperCase();
    if (r === "CAM") return "🏭 CAM";
    if (r === "CELLS") return "🔋 CELLS";
    if (r === "LOGISTICS") return "🚚 LOGISTICS";
    if (r === "ISSUER") return "🧾 ISSUER";
    if (r) return `👤 ${escHtml(r)}`;
    return "👤 ROLE";
  }

  function statusBadge(statusLabel) {
    const s = String(statusLabel || "");
    if (s === "Collecting") return "🟡 Collecting";
    if (s === "Frozen") return "🔒 Frozen";
    if (s === "Revoked") return "⛔ Revoked";
    if (s) return `❓ ${escHtml(s)}`;
    return "❓ —";
  }

  async function format(evt) {
    const kind = String(evt?.kind || "LOG").toUpperCase();
    const schema = String(evt?.schema || "").toLowerCase();
    const name = String(evt?.event || "");

    const label = evt?.contract?.label || "Contract";
    const caddr = String(evt?.contract?.address || evt?.address || "").toLowerCase();

    const bn = evt?.blockNumber ?? "—";
    const tsSec = pickEvtTs(evt);
    const ts = tsSec ? fmtUtcFromSec(tsSec) : "—";

    const labelsMap = null;

    if (schema === "bcc_rev2") {
      const lines = [];

      if (name === "IssuerAllowanceUpdated") {
        const allowed = evt?.allowed === true ? "✅ allowed" : "⛔ not allowed";
        lines.push(`<b>🛡️ Issuer allowlist aggiornata</b> — ${escHtml(label)}`);
        lines.push(`Issuer: ${fmtAddr(evt?.issuer || evt?.actor || evt?.from || null, labelsMap)}`);
        lines.push(`Stato: <b>${escHtml(allowed)}</b>`);
      }

      else if (name === "CertificateMinted") {
        lines.push(`<b>🚀 Certificato mintato</b> — ${escHtml(label)}`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        if (evt?.issuer) lines.push(`Issuer: ${fmtAddr(evt.issuer, labelsMap)}`);
        if (showUri && evt?.uri) lines.push(`TokenURI: ${link(evt.uri, "apri")}`);
      }

      else if (name === "CertificateStatusChanged") {
        lines.push(`<b>🚨 Stato certificato cambiato</b> — ${escHtml(label)}`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        if (evt?.statusLabel) lines.push(`Nuovo stato: <b>${statusBadge(evt.statusLabel)}</b>`);
      }

      else if (name === "ActorAuthorized") {
        lines.push(`<b>✅ Attore autorizzato</b> — ${escHtml(label)}`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        lines.push(`Ruolo: <b>${roleBadge(evt?.roleLabel)}</b>`);
        if (evt?.actor) lines.push(`Actor: ${fmtAddr(evt.actor, labelsMap)}`);
        if (evt?.issuer) lines.push(`Issuer: ${fmtAddr(evt.issuer, labelsMap)}`);
      }

      else if (name === "ContributionSubmitted") {
        lines.push(`<b>📩 Contribution submitted</b> — ${escHtml(label)}`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        lines.push(`Ruolo: <b>${roleBadge(evt?.roleLabel)}</b>`);
        if (evt?.actor) lines.push(`Actor: ${fmtAddr(evt.actor, labelsMap)}`);
        if (showUri && evt?.uri) lines.push(`URI: ${link(evt.uri, "apri")}`);
        if (showDigest && evt?.digest) lines.push(`Digest: <code>${escHtml(shortHex(evt.digest, 14, 10))}</code>`);
      }

      else if (name === "ContributionFrozen") {
        lines.push(`<b>🔒 Contribution frozen</b> — ${escHtml(label)}`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        lines.push(`Ruolo: <b>${roleBadge(evt?.roleLabel)}</b>`);
        if (evt?.actor) lines.push(`Actor: ${fmtAddr(evt.actor, labelsMap)}`);
      }

      else if (name === "AggregatePublished") {
        lines.push(`<b>📦 Aggregate pubblicato</b> — ${escHtml(label)}`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        if (showUri && evt?.uri) lines.push(`URI: ${link(evt.uri, "apri")}`);
        if (showDigest && evt?.digest) lines.push(`Digest: <code>${escHtml(shortHex(evt.digest, 14, 10))}</code>`);
        if (evt?.issuer) lines.push(`Issuer: ${fmtAddr(evt.issuer, labelsMap)}`);
      }

      else if (name === "TokenURIMetadataUpdated") {
        lines.push(`<b>📝 TokenURI aggiornato</b> — ${escHtml(label)}`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        if (showUri && evt?.uri) lines.push(`Nuovo URI: ${link(evt.uri, "apri")}`);
        if (evt?.issuer) lines.push(`Issuer: ${fmtAddr(evt.issuer, labelsMap)}`);
      }

      else if (name === "TokenURIMetadataFrozen") {
        lines.push(`<b>🧊 Metadata congelata</b> — ${escHtml(label)}`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        if (evt?.issuer) lines.push(`Issuer: ${fmtAddr(evt.issuer, labelsMap)}`);
      }

      else {
        lines.push(`<b>🔔 ${escHtml(kind)}</b> — ${escHtml(label)}`);
        if (name) lines.push(`Evento: <b>${escHtml(name)}</b>`);
        pushLotLines(lines, evt);
        if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
        if (evt?.roleLabel) lines.push(`Ruolo: <b>${roleBadge(evt.roleLabel)}</b>`);
        if (evt?.statusLabel) lines.push(`Stato: <b>${statusBadge(evt.statusLabel)}</b>`);
      }

      lines.push(``);
      lines.push(`⛓️ Blocco: ${blockLink(bn)} — ${escHtml(ts)}`);
      if (showContractLine) lines.push(`📦 Contratto: <code>${escHtml(shortHex(caddr))}</code>`);
      if (evt?.txHash) lines.push(`🧷 Tx: ${txLink(evt.txHash)}`);

      return safeText(lines.join("\n"));
    }

    // Transfer/Mint/Burn generico
    if (kind === "MINT" || kind === "BURN" || kind === "TRANSFER") {
      const lines = [];
      if (kind === "MINT") lines.push(`<b>🚀 Mint</b> — ${escHtml(label)}`);
      else if (kind === "BURN") lines.push(`<b>🔥 Burn</b> — ${escHtml(label)}`);
      else lines.push(`<b>🔁 Transfer</b> — ${escHtml(label)}`);

      if (evt?.from) lines.push(`Da: ${fmtAddr(evt.from, labelsMap)}`);
      if (evt?.to) lines.push(`A:  ${fmtAddr(evt.to, labelsMap)}`);
      if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);

      lines.push(``);
      lines.push(`⛓️ Blocco: ${blockLink(bn)} — ${escHtml(ts)}`);
      if (showContractLine) lines.push(`📦 Contratto: <code>${escHtml(shortHex(caddr))}</code>`);
      if (evt?.txHash) lines.push(`🧷 Tx: ${txLink(evt.txHash)}`);

      return safeText(lines.join("\n"));
    }

    // fallback
    const lines = [];
    lines.push(`<b>🔔 ${escHtml(kind)}</b> — ${escHtml(label)}`);
    if (evt?.event) lines.push(`Evento: <b>${escHtml(String(evt.event))}</b>`);
    if (evt?.tokenId) lines.push(`TokenId: ${fmtTokenId(evt.tokenId)}`);
    lines.push(`⛓️ Blocco: ${blockLink(bn)} — ${escHtml(ts)}`);
    if (showContractLine) lines.push(`📦 Contratto: <code>${escHtml(shortHex(caddr))}</code>`);
    if (evt?.txHash) lines.push(`🧷 Tx: ${txLink(evt.txHash)}`);
    return safeText(lines.join("\n"));
  }

  async function send(text) {
    if (!on) return;

    const res = await fetch(`${api}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) {
      const desc = j?.description || `HTTP ${res.status}`;
      throw new Error(`Telegram sendMessage failed: ${desc}`);
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (q.length) {
        const evt = q.shift();
        try {
          const text = await format(evt);
          await send(text);
        } catch (e) {
          console.warn("[tg] send failed:", e?.message || e);
        }
        await sleep(minIntervalMs);
      }
    } finally {
      busy = false;
    }
  }

  return {
    isEnabled: () => !!on,
    enqueue: (evt) => {
      if (!on) return;
      if (!pass(evt)) return;

      if (q.length >= maxQueue) q.shift();
      q.push(evt);
      pump();
    }
  };
}