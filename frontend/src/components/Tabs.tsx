import { useState, type KeyboardEvent } from "react";
import type { Order, Portfolio } from "../api.js";
import { direction, inr, pct, price, signedInr, time } from "../format.js";

const STATUS: Record<string, string> = {
  OPEN: "Open",
  PARTIALLY_FILLED: "Part filled",
  FILLED: "Filled",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REJECTED: "Rejected",
};

const sideWord = (o: Order) => (o.side === "BUY" ? "Buy" : "Sell");
const statusOf = (o: Order) => (o.rejectReason === "MODIFIED" ? "Modified" : (STATUS[o.status] ?? o.status));

export interface Change {
  quantity: number;
  limitPrice: string;
}

export function Tabs(props: {
  portfolio: Portfolio | null;
  orders: Order[];
  history: Order[];
  onCancel: (id: string) => void;
  onModify: (id: string, change: Change) => Promise<boolean>;
}) {
  const { portfolio, orders, history, onCancel, onModify } = props;
  const [tab, setTab] = useState<"positions" | "orders" | "history">("positions");
  // The open order being modified, edited in place: its open quantity and limit price.
  const [edit, setEdit] = useState<{ id: string; quantity: string; limitPrice: string; busy: boolean } | null>(null);
  const editedOrder = edit && orders.find((o) => o.id === edit.id);
  const editing = editedOrder ? edit : null; // it filled or closed meanwhile: drop the edit
  // A modify costs the order its place in the queue, so only a real change can be saved.
  const canSave =
    !!editing &&
    !!editedOrder &&
    !editing.busy &&
    Number(editing.quantity) > 0 &&
    Number(editing.limitPrice) > 0 &&
    (Number(editing.quantity) !== editedOrder.quantity - editedOrder.filledQuantity || Number(editing.limitPrice) !== Number(editedOrder.limitPrice));

  const save = async () => {
    if (!editing || !canSave) return;
    setEdit({ ...editing, busy: true });
    const ok = await onModify(editing.id, { quantity: Number(editing.quantity), limitPrice: editing.limitPrice });
    setEdit(ok ? null : { ...editing, busy: false });
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") setEdit(null);
  };
  const tabs = [
    ["positions", "Positions", portfolio?.holdings.length ?? 0],
    ["orders", "Open orders", orders.length],
    ["history", "History", null],
  ] as const;

  return (
    <section className="panel tabs">
      <div role="tablist">
        {tabs.map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
            {count !== null && <span className="count">{count}</span>}
          </button>
        ))}
      </div>

      {tab === "positions" &&
        (portfolio && portfolio.holdings.length ? (
          <table>
            <thead>
              <tr>
                <th>Stock</th>
                <th className="num">Qty</th>
                <th className="num">Avg cost</th>
                <th className="num">Last</th>
                <th className="num">Value</th>
                <th className="num">P&amp;L</th>
                <th className="num">P&amp;L %</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.holdings.map((h) => (
                <tr key={h.symbol}>
                  <td className="symbol">{h.symbol}</td>
                  <td className="num">{h.quantity}</td>
                  <td className="num">{price(h.avgCost)}</td>
                  <td className="num">{price(h.lastPrice)}</td>
                  <td className="num">{inr(h.marketValue)}</td>
                  <td className={`num ${direction(h.unrealizedPnl)}`}>{signedInr(h.unrealizedPnl)}</td>
                  <td className="num">
                    <span className={`chip ${direction(h.unrealizedPct)}`}>{pct(h.unrealizedPct)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  Realised so far <span className={direction(portfolio.totals.realizedPnl)}>{signedInr(portfolio.totals.realizedPnl)}</span>
                </td>
                <td className="num">{inr(portfolio.totals.holdingsValue)}</td>
                <td className={`num ${direction(portfolio.totals.unrealizedPnl)}`}>{signedInr(portfolio.totals.unrealizedPnl)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        ) : (
          <p className="empty">You don't own any shares yet. Pick a stock above and place a buy order.</p>
        ))}

      {tab === "orders" &&
        (orders.length ? (
          <table>
            <thead>
              <tr>
                <th>Placed</th>
                <th>Stock</th>
                <th>Side</th>
                <th className="num">Filled / qty</th>
                <th className="num">Limit</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) =>
                editing?.id === o.id ? (
                  <tr key={o.id} className="editing">
                    <td className="muted">{time(o.createdAt)}</td>
                    <td className="symbol">{o.symbol}</td>
                    <td className={o.side === "BUY" ? "up" : "down"}>{sideWord(o)}</td>
                    <td className="num">
                      <input
                        className="cell-input"
                        aria-label="Open quantity"
                        inputMode="numeric"
                        value={editing.quantity}
                        onChange={(e) => setEdit({ ...editing, quantity: e.target.value.replace(/\D/g, "") })}
                        onKeyDown={keys}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="cell-input"
                        aria-label="Limit price"
                        inputMode="decimal"
                        value={editing.limitPrice}
                        onChange={(e) => setEdit({ ...editing, limitPrice: e.target.value.replace(/[^\d.]/g, "") })}
                        onKeyDown={keys}
                        autoFocus
                      />
                    </td>
                    <td className="muted">Goes to the back of the queue</td>
                    <td className="num actions">
                      <button className="link" onClick={save} disabled={!canSave}>
                        {editing.busy ? "Saving…" : "Save"}
                      </button>
                      <button className="link quiet-link" onClick={() => setEdit(null)}>
                        Back
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={o.id}>
                    <td className="muted">{time(o.createdAt)}</td>
                    <td className="symbol">{o.symbol}</td>
                    <td className={o.side === "BUY" ? "up" : "down"}>{sideWord(o)}</td>
                    <td className="num">
                      {o.filledQuantity} / {o.quantity}
                    </td>
                    <td className="num">{o.limitPrice ? price(o.limitPrice) : "Market"}</td>
                    <td>{STATUS[o.status] ?? o.status}</td>
                    <td className="num actions">
                      {o.type === "LIMIT" && (
                        <button
                          className="link"
                          onClick={() => setEdit({ id: o.id, quantity: String(o.quantity - o.filledQuantity), limitPrice: Number(o.limitPrice).toFixed(2), busy: false })}
                        >
                          Modify
                        </button>
                      )}
                      <button className="link" onClick={() => onCancel(o.id)}>
                        Cancel
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        ) : (
          <p className="empty">No open orders. Limit orders wait here until they fill; you can modify or cancel them meanwhile.</p>
        ))}

      {tab === "history" &&
        (history.length ? (
          <table>
              <thead>
                <tr>
                  <th>Placed</th>
                  <th>Stock</th>
                  <th>Side</th>
                  <th>Type</th>
                  <th className="num">Filled / qty</th>
                  <th className="num">Avg price</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((o) => (
                  <tr key={o.id}>
                    <td className="muted">{time(o.createdAt)}</td>
                    <td className="symbol">{o.symbol}</td>
                    <td className={o.side === "BUY" ? "up" : "down"}>{sideWord(o)}</td>
                    <td>{o.limitPrice ? `Limit ${price(o.limitPrice)}` : "Market"}</td>
                    <td className="num">
                      {o.filledQuantity} / {o.quantity}
                    </td>
                    <td className="num">{o.avgFillPrice ? price(o.avgFillPrice) : "—"}</td>
                    <td>
                      <span className={`status status-${o.status}`}>{statusOf(o)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        ) : (
          <p className="empty">Filled, cancelled and expired orders will show up here.</p>
        ))}
    </section>
  );
}
