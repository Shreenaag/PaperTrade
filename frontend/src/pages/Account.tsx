import type { Me, Portfolio } from "../api.js";
import { Avatar } from "../components/Avatar.js";
import { day, direction, inr, pct, signedInr } from "../format.js";
import { ProfileForm } from "./Profile.js";

export function Account({ me, portfolio, onProfileSaved, onSignOut }: { me: Me; portfolio: Portfolio | null; onProfileSaved: (me: Me) => void; onSignOut: () => void }) {
  const t = portfolio?.totals;
  const rows: [string, string, string?][] = t
    ? [
        ["Net worth", inr(t.equity)],
        ["Starting cash", inr(t.invested)],
        ["Total return", `${signedInr(Number(t.equity) - Number(t.invested))} (${pct(t.returnPct)})`, direction(t.returnPct)],
        ["Realised P&L", signedInr(t.realizedPnl), direction(t.realizedPnl)],
        ["Unrealised P&L", signedInr(t.unrealizedPnl), direction(t.unrealizedPnl)],
        ["Shares at market value", inr(t.holdingsValue)],
        ["Cash", inr(portfolio.cash)],
        ["Held for open buy orders", inr(portfolio.reservedCash)],
        ["Available to trade", inr(portfolio.availableCash)],
      ]
    : [];

  return (
    <main className="page account">
      <header className="account-head">
        <Avatar me={me} size={64} />
        <div>
          <h1>{me.displayName}</h1>
          <p className="muted">
            {me.handle && <>@{me.handle}, </>}
            {me.email}
          </p>
          <p className="muted">Trading since {day(me.createdAt)}</p>
        </div>
      </header>

      <div className="account-grid">
        <section className="panel" aria-labelledby="money-title">
          <h2 id="money-title" className="panel-title">
            Your money
          </h2>
          {t ? (
            <dl className="facts">
              {rows.map(([label, value, tone]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className={tone}>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="empty">Loading your account…</p>
          )}
        </section>

        <section className="panel" aria-labelledby="profile-title">
          <h2 id="profile-title" className="panel-title">
            Profile
          </h2>
          <div className="panel-body">
            <p className="muted">Your name and handle identify you in PaperTrade.</p>
            <ProfileForm me={me} onSaved={onProfileSaved} submitLabel="Save changes" />
          </div>
          <div className="panel-body signout">
            <button className="button" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
