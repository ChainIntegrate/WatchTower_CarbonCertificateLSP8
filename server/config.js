// server/config.js

export const APP_NAME = "ChainIntegrate WT — BatteryCarbon Rev2";
export const PORT = process.env.PORT ? Number(process.env.PORT) : 3032;

// LUKSO Testnet RPC (HTTP)
export const RPC_URL =
  process.env.RPC_URL || "https://rpc.testnet.lukso.network";

// Buffer eventi in RAM
export const BUFFER_MAX = process.env.BUFFER_MAX ? Number(process.env.BUFFER_MAX) : 5000;

// Polling
export const POLL_INTERVAL_MS = process.env.POLL_INTERVAL_MS ? Number(process.env.POLL_INTERVAL_MS) : 2500;
export const CONFIRMATIONS = process.env.CONFIRMATIONS ? Number(process.env.CONFIRMATIONS) : 0; // 0 realtime

// Start block: default quello che mi hai dato (override con env START_BLOCK)
export const START_BLOCK =
  process.env.START_BLOCK ? Number(process.env.START_BLOCK) : 7111600;

const a = (x) => String(x || "").toLowerCase();

/* ===== Watch contracts (solo questo smart contract) ===== */
export const WATCH_CONTRACTS = [
  {
    key: "bcc_rev2",
    label: "BatteryCarbonCertificateLSP8_Rev2",
    address: a("0xE0F24982fA686fEAD94f6b32C532B545c3cEB6CC")
  }
];

// (opzionale) deposit targets (non usati in questa watchtower)
export const DEPOSIT_ADDRESSES = new Set([]);

/**
 * Label/ruoli sugli address.
 * Qui ti conviene mettere:
 * - issuer UP
 * - attori CAM/CELLS/LOGISTICS
 * - eventuali admin/up manager se ti serve leggerli nei log
 *
 * Nota: questi address sono quelli che mi hai dato nei JSON contributi.
 */
export const USER_WALLET_MAP = {
  [a("0x4BE6502A3Ad8ce1ab5127A042C678918F07Af351")]: { label: "Supplier CAM S.p.A.", role: "CAM" },
  [a("0xeE1256Cc436c847D774BB6D686f98f41A2D4CF08")]: { label: "Cells Manufacturer S.r.l.", role: "CELLS" },
  [a("0xC014c2cAd97F3D5d5fdBD6E09DA1e856E0659927")]: { label: "Logistics Partner S.p.A.", role: "LOGISTICS" },

  // Se vuoi, aggiungi qui l'issuer UP reale quando lo confermi:
  // [a("0x...")]: { label: "ACME Battery Systems S.p.A.", role: "ISSUER" },
};

export const BLOCKSCOUT_BASE =
  process.env.BLOCKSCOUT_BASE ||
  "https://explorer.execution.testnet.lukso.network";

// --- Telegram (optional) ---
let local = {};
try {
  // import dinamico per non rompere se il file non esiste
  local = await import("./secrets.local.js");
} catch {}

export const TG_ENABLED =
  (process.env.TG_ENABLED ? String(process.env.TG_ENABLED).toLowerCase() === "true" : null)
  ?? (local.TG_ENABLED ?? false);

export const TG_BOT_TOKEN =
  process.env.TG_BOT_TOKEN
  ?? local.TG_BOT_TOKEN
  ?? "";

export const TG_CHAT_ID =
  process.env.TG_CHAT_ID
  ?? local.TG_CHAT_ID
  ?? "";

export const TG_MIN_INTERVAL_MS =
  process.env.TG_MIN_INTERVAL_MS ? Number(process.env.TG_MIN_INTERVAL_MS) : 1500;

// filtri opzionali (per futuro)
export const TG_ALLOW_SCHEMAS = process.env.TG_ALLOW_SCHEMAS || "";
export const TG_ALLOW_KINDS = process.env.TG_ALLOW_KINDS || "";
export const TG_ALLOW_CONTRACTS = process.env.TG_ALLOW_CONTRACTS || "";