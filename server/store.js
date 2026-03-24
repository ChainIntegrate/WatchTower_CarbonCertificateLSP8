// server/store.js

export class RingStore {
  constructor(max = 5000) {
    this.max = Math.max(100, Number(max) || 5000);
    this.arr = [];
    this.total = 0;
    this.lastBlock = null;   // ultimo blocco PROCESSATO (monotono)
    this.startedAt = Date.now();
  }

  /**
   * Imposta lastBlock in modo monotono (mai indietro).
   * Utile quando il watcher avanza anche se non ci sono log.
   */
  setLastBlock(bn) {
    const v = Number(bn);
    if (!Number.isFinite(v)) return;
    const n = Math.max(0, Math.floor(v));
    if (this.lastBlock == null || n > this.lastBlock) this.lastBlock = n;
  }

  push(evt) {
    this.total++;
    this.arr.push(evt);
    if (this.arr.length > this.max) this.arr.shift();

    // monotono: non permettere regressioni
    const bn = Number(evt?.blockNumber);
    if (Number.isFinite(bn)) this.setLastBlock(bn);
  }

  list({ limit = 200, type = null, contract = null, q = null } = {}) {
    let out = this.arr.slice().reverse();

    if (type) {
      const T = String(type).toUpperCase();
      out = out.filter((x) => String(x.kind || "").toUpperCase() === T);
    }

    if (contract) {
      const C = String(contract).toLowerCase();
      out = out.filter(
        (x) => String(x.contract?.address || "").toLowerCase() === C
      );
    }

    if (q) {
      const s = String(q).toLowerCase();
      out = out.filter((x) => {
        const hay = [
          x.txHash,
          x.blockNumber,
          x.contract?.address,
          x.contract?.label,
          x.schema,
          x.event,
          x.kind,

          x.from,
          x.to,
          x.operator,

          x.tokenId,

          // BCC fields
          x.issuer,
          x.actor,
          x.roleLabel,
          x.statusLabel,
          x.lotCode,
          x.uri,
          x.digest,

          // raw
          x.raw?.topic0,
          ...(Array.isArray(x.raw?.topics) ? x.raw.topics : []),
          x.raw?.data
        ]
          .map((v) => String(v || "").toLowerCase())
          .join(" ");

        return hay.includes(s);
      });
    }

    limit = Math.max(1, Math.min(this.max, Number(limit) || 200));
    return out.slice(0, limit);
  }

  stats() {
    const uptimeSec = Math.floor((Date.now() - this.startedAt) / 1000);
    return {
      buffered: this.arr.length,
      totalSeen: this.total,
      lastBlock: this.lastBlock,
      uptimeSec
    };
  }
}