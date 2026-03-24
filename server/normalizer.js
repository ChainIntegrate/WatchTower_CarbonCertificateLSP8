// server/normalizer.js
const ZERO = "0x0000000000000000000000000000000000000000";

function lc(x){ return x == null ? "" : String(x).toLowerCase(); }

function normAddr(x){
  const s = lc(x).trim();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

// bytes32 normalizzato (0x + 64 hex)
function normBytes32(x){
  if (!x) return null;
  const s = lc(x).trim();
  return (s.startsWith("0x") && s.length === 66) ? s : null;
}

function safeHexLower(x){
  if (x == null) return null;
  // ethers can pass BytesLike / Uint8Array sometimes
  if (typeof x === "string") return lc(x).trim();
  try {
    // best-effort: Buffer / Uint8Array -> hex
    if (x instanceof Uint8Array) {
      return "0x" + Buffer.from(x).toString("hex");
    }
  } catch {}
  return lc(String(x)).trim();
}

function asBool(x){
  if (typeof x === "boolean") return x;
  if (x == null) return null;
  const s = String(x).toLowerCase().trim();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return null;
}

function roleToLabel(role){
  // Role enum: 0=ISSUER,1=CAM,2=CELLS,3=LOGISTICS
  const n = Number(role);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "ISSUER";
  if (n === 1) return "CAM";
  if (n === 2) return "CELLS";
  if (n === 3) return "LOGISTICS";
  return `ROLE_${n}`;
}

function statusToLabel(st){
  // Status enum: 0=Collecting,1=Frozen,2=Revoked
  const n = Number(st);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "Collecting";
  if (n === 1) return "Frozen";
  if (n === 2) return "Revoked";
  return `STATUS_${n}`;
}

// kind per Transfer “stile wallet”
function classifyTransfer(from, to){
  const f = lc(from);
  const t = lc(to);
  if (f === ZERO) return "MINT";
  if (t === ZERO) return "BURN";
  return "TRANSFER";
}

// kind per eventi applicativi
function classifyAppEvent(eventName){
  if (!eventName) return "EVENT";
  const n = String(eventName);

  if (n === "CertificateMinted") return "MINT_CERT";
  if (n === "CertificateStatusChanged") return "STATUS";
  if (n === "ActorAuthorized") return "AUTHORIZE";
  if (n === "ContributionSubmitted") return "SUBMIT";
  if (n === "ContributionFrozen") return "FREEZE";
  if (n === "AggregatePublished") return "AGGREGATE";
  if (n === "TokenURIMetadataUpdated") return "METADATA";
  if (n === "TokenURIMetadataFrozen") return "METADATA_FREEZE";
  if (n === "IssuerAllowanceUpdated") return "ADMIN";
  return "EVENT";
}

/**
 * normalizeLog
 * - crea envelope comune
 */
export function normalizeLog({ log, blockTimestampSec, contractMeta, userWalletMap }){
  const topic0 = lc(log?.topics?.[0] || "");

  const evt = {
    ts: blockTimestampSec || null,

    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,

    contract: {
      address: lc(contractMeta?.address || log.address || ""),
      label: contractMeta?.label || "Unknown",
      key: contractMeta?.key || null
    },

    schema: null,
    event: null,
    kind: "LOG",

    from: null,
    to: null,
    operator: null,

    tokenId: null, // bytes32

    issuer: null,
    actor: null,
    role: null,
    roleLabel: null,
    status: null,
    statusLabel: null,
    allowed: null,

    lotCode: null,
    uri: null,
    digest: null,

    raw: {
      address: lc(log.address || ""),
      topic0,
      topics: log.topics || [],
      data: log.data || "0x"
    },

    labels: {
      from: null,
      to: null,
      operator: null,
      issuer: null,
      actor: null
    },

    meta: {}
  };

  // userWalletMap labels li settiamo quando conosciamo gli indirizzi
  void(userWalletMap);

  return evt;
}

/**
 * applyDecoded
 * - prende evt + decoded (da decoders.js)
 * - riempie campi standard e kind/schema/event
 */
export function applyDecoded(evt, decoded, { userWalletMap } = {}){
  if (!evt || !decoded) return evt;

  evt.schema = decoded.schema || evt.schema;
  evt.event  = decoded.name || evt.event;

  // helper labels
  const setLabelsFor = (field, addr) => {
    if (!userWalletMap) return;
    const a = lc(addr);
    if (!a) return;
    evt.labels[field] = userWalletMap[a]?.label || null;
  };

  // -------------------------
  // Transfer (ERC721-style / fallback)
  // -------------------------
  if (decoded.name === "Transfer" && (decoded.schema === "erc721" || decoded.schema === "lsp8")) {
    evt.from = decoded.from || null;
    evt.to = decoded.to || null;
    evt.operator = decoded.operator || null;

    // tokenId bytes32 (prefer topic bytes32)
    evt.tokenId = normBytes32(decoded.tokenIdTopic) || normBytes32(decoded.tokenId) || evt.tokenId;

    setLabelsFor("from", evt.from);
    setLabelsFor("to", evt.to);
    setLabelsFor("operator", evt.operator);

    evt.kind = classifyTransfer(evt.from, evt.to);
    return evt;
  }

  // -------------------------
  // BCC REV2 events
  // -------------------------
  if (decoded.schema === "bcc_rev2") {
    evt.kind = classifyAppEvent(decoded.name);

    if (decoded.tokenId) evt.tokenId = normBytes32(decoded.tokenId) || evt.tokenId;

    // issuer / actor
    if (decoded.issuer) evt.issuer = decoded.issuer;
    if (decoded.actor) evt.actor = decoded.actor;

    // IMPORTANT: popoliamo anche from/to/operator per filtri UI
    // - per eventi admin/issuer: from = issuer
    // - per eventi actor: from = actor
    // - to rimane null (non è un transfer), ma puoi usarlo se vuoi in futuro
    if (evt.issuer) evt.from = evt.issuer;
    if (evt.actor) evt.from = evt.actor;

    if (decoded.role != null) {
      evt.role = Number(decoded.role);
      evt.roleLabel = roleToLabel(decoded.role);
    }

    if (decoded.status != null) {
      evt.status = Number(decoded.status);
      evt.statusLabel = statusToLabel(decoded.status);
    }

    if (decoded.allowed != null) evt.allowed = asBool(decoded.allowed);

    if (decoded.lotCode) evt.lotCode = String(decoded.lotCode);

    // uri/tokenURI
    if (decoded.uri) evt.uri = String(decoded.uri);
    if (decoded.tokenURI) evt.uri = String(decoded.tokenURI);

    // digest: prefer bytes32 normalizzato, altrimenti hex lower best-effort
    if (decoded.digest != null) {
      const d0 = safeHexLower(decoded.digest);
      evt.digest = normBytes32(d0) || d0 || evt.digest;
    }

    // labels
    setLabelsFor("issuer", evt.issuer);
    setLabelsFor("actor", evt.actor);
    setLabelsFor("from", evt.from);

    // meta: conserva extra non mappati
    for (const [k, v] of Object.entries(decoded)){
      if (k === "schema" || k === "name") continue;
      if (k in evt) continue;
      evt.meta[k] = v;
    }

    return evt;
  }

  // fallback
  evt.kind = evt.kind || "LOG";
  evt.schema = evt.schema || decoded.schema || null;
  evt.event = evt.event || decoded.name || null;
  evt.meta = { ...(evt.meta || {}), decoded };
  return evt;
}