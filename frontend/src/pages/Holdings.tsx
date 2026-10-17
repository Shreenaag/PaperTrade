import type { Instrument, Portfolio } from "../api.js";
import { direction, inr, pct, price, signedInr } from "../format.js";

// Everything you own, valued at live prices: what you paid, what it's worth now, and how much of your money it is.
export function Holdings({ portfolio, instruments, onTrade }: { portfolio: Portfolio | null; instruments: Instrument[]; onTrade: (symbol: string, side: "BUY" | "SELL") => void }) {
  if (!portfolio)
    return (
      <main className="page holdings">
        <h1>Holdings</h1>
      </main>
    );
  const t = portfolio.totals;
  const invested = portfolio.holdings.reduce((s, h) => s + Number(h.avgCost) * h.quantity, 0);
  const value = Number(t.holdingsValue);
  const name = (symbol: string) => instruments.find((i) => i.symbol === symbol);

  return (
    <main className="page holdings">
      <h1>Holdings</h1>

      <section className="summary holdings-summary" aria-label="Holdings totals">
        <div className="stat lead">
          <span className="stat-label">Current value</span>
          <span className="stat-value">{inr(t.holdingsValue)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Invested</span>
          <span className="stat-value">{inr(invested)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Unrealised P&amp;L</span>
          <span className={`stat-value ${direction(t.unrealizedPnl)}`}>
            {pct(invested ? (Number(t.unrealizedPnl) / invested) * 100 : 0)} <small>{signedInr(t.unrealizedPnl)}</small>
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Realised P&amp;L</span>
          <span className={`stat-value ${direction(t.realizedPnl)}`}>{signedInr(t.realizedPnl)}</span>
        </div>
      </section>

      <section className="panel">
        {portfolio.holdings.length ? (
          <table>
            <thead>
              <tr>
                <th>Stock</th>
                <th className="num">Qty</th>
                <th className="num">Avg cost</th>
                <th className="num">Last</th>
                <th className="num">Today</th>
                <th className="num">Invested</th>
                <th className="num">Value</th>
                <th className="num">P&amp;L</th>
                <th>Allocation</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {portfolio.holdings.map((h) => {
                const i = name(h.symbol);
                const share = value ? (Number(h.marketValue) / value) * 100 : 0;
                const free = h.quantity - h.reservedQuantity;
                return (
                  <tr key={h.symbol}>
                    <td>
                      <span className="symbol">{h.symbol}</span>
                      {i && <span className="name">{i.name}</span>}
                    </td>
                    <td className="num">
                      {h.quantity}
                      {h.reservedQuantity > 0 && <span className="name">{h.reservedQuantity} in sell orders</span>}
                    </td>
                    <td className="num">{price(h.avgCost)}</td>
                    <td className="num">{price(h.lastPrice)}</td>
                    <td className={`num ${direction(i?.changePct ?? 0)}`}>{i ? pct(i.changePct) : "—"}</td>
                    <td className="num">{inr(Number(h.avgCost) * h.quantity)}</td>
                    <td className="num">{inr(h.marketValue)}</td>
                    <td className={`num ${direction(h.unrealizedPnl)}`}>
                      {signedInr(h.unrealizedPnl)}
                      <span className={`chip ${direction(h.unrealizedPct)}`}>{pct(h.unrealizedPct)}</span>
                    </td>
                    <td>
                      <span className="share" aria-label={`${share.toFixed(1)}% of your shares by value`}>
                        <span className="share-bar" style={{ width: `${Math.min(share, 100)}%` }} />
                      </span>
                      <span className="share-pct">{share.toFixed(1)}%</span>
                    </td>
                    <td className="num actions">
                      <button className="link" onClick={() => onTrade(h.symbol, "BUY")}>
                        Buy
                      </button>
                      <button className="link sell-link" onClick={() => onTrade(h.symbol, "SELL")} disabled={free < 1}>
                        Sell
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="empty">You don't own any shares yet. Buy from the market and they'll show up here.</p>
        )}
      </section>
      <p className="muted">
        Cash not in shares: {inr(portfolio.cash)}, of which {inr(portfolio.availableCash)} is free to trade.
      </p>
    </main>
  );
}
