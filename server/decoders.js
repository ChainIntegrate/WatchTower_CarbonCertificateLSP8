// server/decoders.js
import { ethers } from "ethers";

const { defaultAbiCoder } = ethers.utils;

/**
 * Watchtower decoder — BatteryCarbonCertificateLSP8_Rev2 ONLY
 *
 * Output contract:
 * - This watchtower expects decoded.schema === "bcc_rev2"
 * - applyDecoded() in normalizer will map fields into evt.*
 */

// -------------------------
// Helpers
// -------------------------
function topicToAddress(t) {
  if (!t) return null;
  const hex = String(t);
  if (!hex.startsWith("0x") || hex.length !== 66) return null;
  return "0x" + hex.slice(26);
}

function topicToBytes32(t) {
  if (!t) return null;
  const hex = String(t);
  if (!hex.startsWith("0x") || hex.length !== 66) return null;
  return hex.toLowerCase();
}

function asString(x) {
  try {
    if (typeof x === "string") return x;
    return String(x);
  } catch {
    return null;
  }
}

function asNumber(x) {
  try {
    // ethers v5 uint8 decode returns a BigNumber-like in some cases
    if (x?.toNumber) return x.toNumber();
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function bccRoleName(n) {
  const x = Number(n);
  if (x === 0) return "ISSUER";
  if (x === 1) return "CAM";
  if (x === 2) return "CELLS";
  if (x === 3) return "LOGISTICS";
  return `ROLE_${x}`;
}

function bccStatusName(n) {
  const x = Number(n);
  if (x === 0) return "Collecting";
  if (x === 1) return "Frozen";
  if (x === 2) return "Revoked";
  return `STATUS_${x}`;
}

// -------------------------
// Topics (topic0)
// -------------------------

// Standard Transfer topic0 (ERC20/ERC721 share topic0; for LSP8 we expect 4 topics)
const TOPIC_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Custom events (signatures EXACT as in Solidity)
const TOPIC_ISSUER_ALLOWANCE_UPDATED = ethers.utils.id(
  "IssuerAllowanceUpdated(address,bool)"
);
const TOPIC_CERTIFICATE_MINTED = ethers.utils.id(
  "CertificateMinted(bytes32,address,string,string)"
);
const TOPIC_CERTIFICATE_STATUS_CHANGED = ethers.utils.id(
  "CertificateStatusChanged(bytes32,uint8)"
);
const TOPIC_ACTOR_AUTHORIZED = ethers.utils.id(
  "ActorAuthorized(bytes32,uint8,address)"
);
const TOPIC_CONTRIBUTION_SUBMITTED = ethers.utils.id(
  "ContributionSubmitted(bytes32,uint8,address,bytes32,string)"
);
const TOPIC_CONTRIBUTION_FROZEN = ethers.utils.id(
  "ContributionFrozen(bytes32,uint8,address)"
);
const TOPIC_AGGREGATE_PUBLISHED = ethers.utils.id(
  "AggregatePublished(bytes32,bytes32,string)"
);
const TOPIC_TOKENURI_UPDATED = ethers.utils.id(
  "TokenURIMetadataUpdated(bytes32,string)"
);
const TOPIC_TOKENURI_FROZEN = ethers.utils.id(
  "TokenURIMetadataFrozen(bytes32)"
);

// -------------------------
// Main decoder
// -------------------------
export function tryDecodeBCC(log) {
  const topic0 = (log?.topics?.[0] || log?.topic0 || "").toLowerCase();
  const topics = log?.topics || [];
  const data = log?.data || "0x";

  // -------------------------
  // Transfer (ERC721/LSP8 style)
  // topics: [sig, from, to, tokenId(bytes32)]
  // -------------------------
  if (topic0 === TOPIC_TRANSFER) {
    if (topics.length >= 4) {
      const from = topicToAddress(topics[1]);
      const to = topicToAddress(topics[2]);
      const tokenIdTopic = topicToBytes32(topics[3]);

      return {
        name: "Transfer",
        schema: "erc721", // applyDecoded supports "erc721" for Transfer
        from,
        to,

        // important for LSP8 hash tokenId
        tokenIdTopic,     // bytes32 hex, what we want
        tokenId: tokenIdTopic // compat (some UIs still look at tokenId)
      };
    }
    return null;
  }

  // -------------------------
  // IssuerAllowanceUpdated(address indexed issuer, bool allowed)
  // topics: [sig, issuer]
  // data: allowed (bool)
  // -------------------------
  if (topic0 === TOPIC_ISSUER_ALLOWANCE_UPDATED.toLowerCase()) {
    const issuer = topicToAddress(topics[1]);

    let allowed = null;
    try {
      const [a] = defaultAbiCoder.decode(["bool"], data);
      allowed = Boolean(a);
    } catch {}

    return {
      name: "IssuerAllowanceUpdated",
      schema: "bcc_rev2",
      issuer,
      allowed
    };
  }

  // -------------------------
  // CertificateMinted(bytes32 indexed tokenId, address indexed issuer, string lotCode, string tokenURI)
  // topics: [sig, tokenId, issuer]
  // data: (lotCode, tokenURI)
  // -------------------------
  if (topic0 === TOPIC_CERTIFICATE_MINTED.toLowerCase()) {
    const tokenId = topicToBytes32(topics[1]);
    const issuer = topicToAddress(topics[2]);

    let lotCode = null;
    let tokenURI = null;
    try {
      const [lc, uri] = defaultAbiCoder.decode(["string", "string"], data);
      lotCode = asString(lc);
      tokenURI = asString(uri);
    } catch {}

    return {
      name: "CertificateMinted",
      schema: "bcc_rev2",
      tokenId,
      issuer,
      lotCode,
      tokenURI
    };
  }

  // -------------------------
  // CertificateStatusChanged(bytes32 indexed tokenId, uint8 status)
  // topics: [sig, tokenId]
  // data: status (uint8)
  // -------------------------
  if (topic0 === TOPIC_CERTIFICATE_STATUS_CHANGED.toLowerCase()) {
    const tokenId = topicToBytes32(topics[1]);

    let status = null;
    try {
      const [st] = defaultAbiCoder.decode(["uint8"], data);
      status = asNumber(st);
    } catch {}

    return {
      name: "CertificateStatusChanged",
      schema: "bcc_rev2",
      tokenId,
      status,
      statusLabel: status == null ? null : bccStatusName(status)
    };
  }

  // -------------------------
  // ActorAuthorized(bytes32 indexed tokenId, uint8 indexed role, address indexed actor)
  // topics: [sig, tokenId, role, actor]
  // data: empty
  // -------------------------
  if (topic0 === TOPIC_ACTOR_AUTHORIZED.toLowerCase()) {
    const tokenId = topicToBytes32(topics[1]);

    let role = null;
    try {
      role = ethers.BigNumber.from(topics[2]).toNumber();
    } catch {}

    const actor = topicToAddress(topics[3]);

    return {
      name: "ActorAuthorized",
      schema: "bcc_rev2",
      tokenId,
      role,
      roleLabel: role == null ? null : bccRoleName(role),
      actor
    };
  }

  // -------------------------
  // ContributionSubmitted(bytes32 indexed tokenId, uint8 indexed role, address indexed actor, bytes32 digest, string uri)
  // topics: [sig, tokenId, role, actor]
  // data: (digest bytes32, uri string)
  // -------------------------
  if (topic0 === TOPIC_CONTRIBUTION_SUBMITTED.toLowerCase()) {
    const tokenId = topicToBytes32(topics[1]);

    let role = null;
    try {
      role = ethers.BigNumber.from(topics[2]).toNumber();
    } catch {}

    const actor = topicToAddress(topics[3]);

    let digest = null;
    let uri = null;
    try {
      const [d, u] = defaultAbiCoder.decode(["bytes32", "string"], data);
      digest = asString(d)?.toLowerCase() ?? null;
      uri = asString(u);
    } catch {}

    return {
      name: "ContributionSubmitted",
      schema: "bcc_rev2",
      tokenId,
      role,
      roleLabel: role == null ? null : bccRoleName(role),
      actor,
      digest,
      uri
    };
  }

  // -------------------------
  // ContributionFrozen(bytes32 indexed tokenId, uint8 indexed role, address indexed actor)
  // topics: [sig, tokenId, role, actor]
  // data: empty
  // -------------------------
  if (topic0 === TOPIC_CONTRIBUTION_FROZEN.toLowerCase()) {
    const tokenId = topicToBytes32(topics[1]);

    let role = null;
    try {
      role = ethers.BigNumber.from(topics[2]).toNumber();
    } catch {}

    const actor = topicToAddress(topics[3]);

    return {
      name: "ContributionFrozen",
      schema: "bcc_rev2",
      tokenId,
      role,
      roleLabel: role == null ? null : bccRoleName(role),
      actor
    };
  }

  // -------------------------
  // AggregatePublished(bytes32 indexed tokenId, bytes32 digest, string uri)
  // topics: [sig, tokenId]
  // data: (digest bytes32, uri string)
  // -------------------------
  if (topic0 === TOPIC_AGGREGATE_PUBLISHED.toLowerCase()) {
    const tokenId = topicToBytes32(topics[1]);

    let digest = null;
    let uri = null;
    try {
      const [d, u] = defaultAbiCoder.decode(["bytes32", "string"], data);
      digest = asString(d)?.toLowerCase() ?? null;
      uri = asString(u);
    } catch {}

    return {
      name: "AggregatePublished",
      schema: "bcc_rev2",
      tokenId,
      digest,
      uri
    };
  }

  // -------------------------
  // TokenURIMetadataUpdated(bytes32 indexed tokenId, string newURI)
  // topics: [sig, tokenId]
  // data: (newURI string)
  // IMPORTANT: normalizer expects tokenURI (or uri) for metadata updates
  // -------------------------
  if (topic0 === TOPIC_TOKENURI_UPDATED.toLowerCase()) {
    const tokenId = topicToBytes32(topics[1]);

    let tokenURI = null;
    try {
      const [u] = defaultAbiCoder.decode(["string"], data);
      tokenURI = asString(u);
    } catch {}

    return {
      name: "TokenURIMetadataUpdated",
      schema: "bcc_rev2",
      tokenId,
      tokenURI
    };
  }

  // -------------------------
  // TokenURIMetadataFrozen(bytes32 indexed tokenId)
  // topics: [sig, tokenId]
  // data: empty
  // -------------------------
  if (topic0 === TOPIC_TOKENURI_FROZEN.toLowerCase()) {
    const tokenId = topicToBytes32(topics[1]);
    return {
      name: "TokenURIMetadataFrozen",
      schema: "bcc_rev2",
      tokenId
    };
  }

  return null;
}

// Backward compat (se qualche pezzo chiama ancora questo)
export function tryDecodeStandardTransfer(log) {
  return tryDecodeBCC(log);
}