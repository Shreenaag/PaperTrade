import type { Portfolio } from "../api.js";
import { direction, inr, mmss, pct, type Clock } from "../format.js";

// The turn of the day, announced instead of sprung on the player. Each step has its own countdown:
//   last minute of OPEN -> closes in, POST_CLOSE -> closing session ends in, CLOSED -> pre-open starts in,
//   PRE_OPEN -> market opens in.
// Text only, no animation: the banner appears, changes its words and goes.
const HEADS_UP_SECONDS = 60;

const STEPS = {
  OPEN: { title: "The market closes soon", count: "Closes in" },
  POST_CLOSE: { title: "Market closed for the day", count: "Closing session ends in" },
  CLOSED: { title: "Market closed", count: "Pre-open starts in" },
  PRE_OPEN: { title: "A new day is about to start", count: "Market opens in" },
} as const;

export function DayBanner({ c, portfolio }: { c: Clock; portfolio: Portfolio | null }) {
  if (c.phase === "OPEN" && c.secondsLeft > HEADS_UP_SECONDS) return null;
  const step = STEPS[c.phase];
  const t = portfolio?.totals;
  const result = t && (
    <>
      You {c.phase === "POST_CLOSE" ? "end" : "ended"} the day at <strong>{inr(t.equity)}</strong>,{" "}
      <strong className={direction(t.returnPct)}>{pct(t.returnPct)}</strong> overall.
    </>
  );

  return (
    <section className="daynote" role="status">
      <div>
        <p className="daynote-title">{step.title}</p>
        <p className="daynote-body">
          {c.phase === "OPEN" && "Open limit orders carry over to the next day. You can still modify or cancel them."}
          {c.phase === "POST_CLOSE" && <>Orders placed now fill only at today's closing price. {result}</>}
          {c.phase === "CLOSED" && <>Trading is paused until the next day's pre-open; you can still cancel orders. {result}</>}
          {c.phase === "PRE_OPEN" && <>Orders placed now join the opening auction. {result}</>}
        </p>
      </div>
      <p className="daynote-count" aria-label={`${step.count} ${mmss(c.secondsLeft)}`}>
        <span>{step.count}</span>
        <strong>{mmss(c.secondsLeft)}</strong>
      </p>
    </section>
  );
}
