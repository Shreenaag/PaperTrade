import type { ReactNode } from "react";
import type { Me } from "../api.js";
import { mmss, PHASES, type Clock } from "../format.js";
import type { LiveStatus } from "../live.js";
import { linkProps } from "../nav.js";
import { Avatar } from "./Avatar.js";

// The day bar: the trading day as a track (pre-open, open, closing) with a marker at "now".
function DayBar({ c }: { c: Clock }) {
  return (
    <div className="daybar" aria-label={`${c.label}, ${mmss(c.secondsLeft)} left`}>
      <div className="daybar-head">
        <span className={`phase phase-${c.phase}`}>{c.phase === "OPEN" ? "Market open" : c.label}</span>
        <span className="daybar-left">{mmss(c.secondsLeft)} left</span>
      </div>
      <div className="daybar-track" aria-hidden>
        {PHASES.map((p) => (
          <span key={p.phase} className={`daybar-seg seg-${p.phase}${p.phase === c.phase ? " now" : ""}`} style={{ flexGrow: p.seconds }} />
        ))}
        <span className="daybar-marker" style={{ left: `${c.dayProgress * 100}%` }} />
      </div>
    </div>
  );
}

const LINKS = [
  ["/", "Market"],
  ["/holdings", "Holdings"],
  ["/account", "Account"],
] as const;

// `children` hang below the bar (the day banner), pinned with it and drawn over the page.
export function TopBar({ me, path, c, live, children }: { me: Me; path: string; c: Clock; live: LiveStatus; children?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="wordmark" {...linkProps("/")}>
        PaperTrade
      </a>
      <nav className="topnav" aria-label="Main">
        {LINKS.map(([to, label]) => (
          <a key={to} {...linkProps(to)} aria-current={path === to ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <DayBar c={c} />
      <div className="topbar-end">
        {live !== "live" && <span className="badge">{live === "connecting" ? "Connecting…" : "Reconnecting…"}</span>}
        <a className="me-link" {...linkProps("/account")} title="Your account">
          <Avatar me={me} />
          <span className="me-name">{me.handle ? `@${me.handle}` : me.displayName}</span>
        </a>
      </div>
      {children}
    </header>
  );
}
