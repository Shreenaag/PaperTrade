import { useState, type FormEvent } from "react";
import { api, errorOf, type Instrument, type Portfolio, type Side } from "../api.js";
import { inr, price } from "../format.js";

export function OrderTicket({
  instrument,
  portfolio,
  onPlaced,
  initialSide = "BUY",
  marketClosed = false,
}: {
  instrument: Instrument | null;
  portfolio: Portfolio | null;
  onPlaced: () => void;
  initialSide?: Side;
  marketClosed?: boolean; // the pause between days: no new orders
}) {
  const [side, setSide] = useState<Side>(initialSide);
  const [type, setType] = useState<"MARKET" | "LIMIT">("LIMIT");
  const [quantity, setQuantity] = useState("1");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  if (!instrument) return <section className="panel ticket empty">Pick a stock from the market to trade it.</section>;

  const qty = Number(quantity);
  const unit = type === "LIMIT" ? Number(limit || instrument.lastPrice) : Number(instrument.lastPrice);
  const estimate = qty > 0 ? unit * qty : 0;
  const held = portfolio?.holdings.find((h) => h.symbol === instrument.symbol);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", "/orders", {
        symbol: instrument.symbol,
        side,
        type,
        quantity: qty,
        ...(type === "LIMIT" && { limitPrice: limit }),
        clientOrderId: crypto.randomUUID(), // a double-click places one order, not two
      });
      setMessage({ text: `${side === "BUY" ? "Buy" : "Sell"} order placed for ${qty} ${instrument.symbol}.`, error: false });
      onPlaced();
    } catch (err) {
      setMessage({ text: errorOf(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel ticket" aria-label="Order ticket">
      <h2>
        {instrument.symbol} <span className="ticket-last">{price(instrument.lastPrice)}</span>
      </h2>
      <form onSubmit={submit}>
        <div className="toggle" role="radiogroup" aria-label="Side">
          {(["BUY", "SELL"] as const).map((s) => (
            <button type="button" key={s} role="radio" aria-checked={side === s} className={side === s ? `on ${s.toLowerCase()}` : ""} onClick={() => setSide(s)}>
              {s === "BUY" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <div className="toggle" role="radiogroup" aria-label="Order type">
          {(["LIMIT", "MARKET"] as const).map((t) => (
            <button type="button" key={t} role="radio" aria-checked={type === t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
              {t === "LIMIT" ? "Limit" : "Market"}
            </button>
          ))}
        </div>
        <label>
          Quantity
          <input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))} required />
        </label>
        {type === "LIMIT" && (
          <label>
            Limit price
            <input inputMode="decimal" placeholder={price(instrument.lastPrice)} value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} required />
          </label>
        )}
        <dl className="ticket-facts">
          <dt>{type === "MARKET" ? "Approx. value" : "Order value"}</dt>
          <dd>{inr(estimate)}</dd>
          {side === "BUY" ? (
            <>
              <dt>Available cash</dt>
              <dd>{portfolio ? inr(portfolio.availableCash) : "—"}</dd>
            </>
          ) : (
            <>
              <dt>Shares you can sell</dt>
              <dd>{held ? held.quantity - held.reservedQuantity : 0}</dd>
            </>
          )}
        </dl>
        {message && (
          <p className={`notice${message.error ? " error" : ""}`} role={message.error ? "alert" : "status"}>
            {message.text}
          </p>
        )}
        <button className={`button primary ${side.toLowerCase()}`} disabled={busy || qty < 1 || marketClosed}>
          {marketClosed ? "Market closed" : busy ? "Placing…" : `${side === "BUY" ? "Buy" : "Sell"} ${qty || ""} ${instrument.symbol}`}
        </button>
      </form>
    </section>
  );
}
