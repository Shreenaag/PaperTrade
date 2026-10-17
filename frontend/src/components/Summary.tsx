import type { Portfolio } from "../api.js";
import { direction, inr, pct, signedInr } from "../format.js";

// The desk's headline numbers, re-valued on every price tick (see reprice in format.ts).
export function Summary({ portfolio }: { portfolio: Portfolio | null }) {
  if (!portfolio) return <section className="summary" aria-label="Your account" />;
  const t = portfolio.totals;
  const gain = Number(t.equity) - Number(t.invested);
  const cost = Number(t.holdingsValue) - Number(t.unrealizedPnl);
  const openPct = cost ? (Number(t.unrealizedPnl) / cost) * 100 : 0;

  return (
    <section className="summary" aria-label="Your account">
      <div className="stat lead">
        <span className="stat-label">Net worth</span>
        <span className="stat-value">{inr(t.equity)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Total return</span>
        <span className={`stat-value ${direction(gain)}`}>
          {pct(t.returnPct)} <small>{signedInr(gain)}</small>
        </span>
      </div>
      <div className="stat">
        <span className="stat-label">Open positions</span>
        <span className={`stat-value ${direction(t.unrealizedPnl)}`}>
          {pct(openPct)} <small>{signedInr(t.unrealizedPnl)}</small>
        </span>
      </div>
      <div className="stat">
        <span className="stat-label">Available cash</span>
        <span className="stat-value">{inr(portfolio.availableCash)}</span>
      </div>
    </section>
  );
}
