import { type Db, now } from './db.ts';

export class SpendCapError extends Error {
  readonly statusCode = 402;
}

/**
 * Tracks paid spend and refuses work that would exceed the cap.
 * "Committed" = money already recorded plus estimates for animations still in flight,
 * so two quick clicks can't both slip under the cap.
 */
export class CostGuard {
  readonly db: Db;
  readonly capUsd: number;

  constructor(db: Db, capUsd: number) {
    this.db = db;
    this.capUsd = capUsd;
  }

  spentUsd(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM cost_ledger').get() as { total: number };
    return round(row.total);
  }

  inFlightUsd(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM animations WHERE status IN ('pending', 'running')")
      .get() as { total: number };
    return round(row.total);
  }

  assertCanSpend(estimateUsd: number, what: string): void {
    if (estimateUsd <= 0) return;
    const committed = this.spentUsd() + this.inFlightUsd();
    if (committed + estimateUsd > this.capUsd + 1e-9) {
      throw new SpendCapError(
        `${what} would cost about $${estimateUsd.toFixed(2)}, but only $${Math.max(0, this.capUsd - committed).toFixed(2)} ` +
          `of the $${this.capUsd.toFixed(2)} spend cap is left. Raise SPEND_CAP_USD to continue.`,
      );
    }
  }

  record(entry: { provider: string; operation: string; usd: number; refType: string; refId: number }): void {
    if (entry.usd <= 0) return;
    this.db
      .prepare('INSERT INTO cost_ledger (at, provider, operation, usd, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now(), entry.provider, entry.operation, entry.usd, entry.refType, entry.refId);
  }

  summary(): { spentUsd: number; inFlightUsd: number; capUsd: number } {
    return { spentUsd: this.spentUsd(), inFlightUsd: this.inFlightUsd(), capUsd: this.capUsd };
  }
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
