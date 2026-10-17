import type { ReactNode } from "react";
import { PHASES } from "../format.js";

// Signed-out pages (sign in, signed out, first profile): the brand on the left, the one thing to do on the right.
export function Gate({ children }: { children: ReactNode }) {
  return (
    <div className="gate">
      <aside className="gate-brand">
        <span className="wordmark">PaperTrade</span>
        <div>
          <p className="gate-headline">Learn the market, one short trading day at a time.</p>
          <p className="gate-sub">Start with ₹10,00,000 of paper money. Trade against other players and the market's bots, and watch your holdings grow.</p>
        </div>
        <dl className="gate-facts">
          <div>
            <dt>{PHASES.map((p) => (p.seconds >= 60 ? `${p.seconds / 60} min` : `${p.seconds} s`)).join(" + ")}</dt>
            <dd>Pre-open, trading, close and a short break each day</dd>
          </div>
          <div>
            <dt>0.03%</dt>
            <dd>Fee on every trade</dd>
          </div>
          <div>
            <dt>Live</dt>
            <dd>Prices move with every order, yours included</dd>
          </div>
        </dl>
      </aside>
      <main className="gate-main">{children}</main>
    </div>
  );
}
