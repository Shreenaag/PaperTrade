import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DayBanner } from "../components/DayBanner.js";
import { api, errorOf, type Instrument, type Me, type Order, type Portfolio, type Session } from "../api.js";
import { MarketTable } from "../components/MarketTable.js";
import { OrderTicket } from "../components/OrderTicket.js";
import { Summary } from "../components/Summary.js";
import { Tabs, type Change } from "../components/Tabs.js";
import { Toasts, type Toast } from "../components/Toasts.js";
import { TopBar } from "../components/TopBar.js";
import { clock, inr, reprice } from "../format.js";
import { connectLive, type LiveMsg, type LiveStatus } from "../live.js";
import { navigate } from "../nav.js";
import { Account } from "./Account.js";
import { Holdings } from "./Holdings.js";

const SPARK_POINTS = 120;
const TOAST_MS = 4000;
const HISTORY_SIZE = 10;
const HISTORY_FETCH = HISTORY_SIZE + 20; // up to 20 of the newest orders can still be open (OrderLimits.open)
const OPEN = ["OPEN", "PARTIALLY_FILLED"];

const ORDER_WORDS: Record<string, [string, Toast["tone"]]> = {
  FILLED: ["filled", "up"],
  PARTIALLY_FILLED: ["partly filled", "up"],
  CANCELLED: ["cancelled", "flat"],
  EXPIRED: ["expired at the end of the day", "flat"],
  REJECTED: ["rejected", "down"],
};

// The signed-in app: header, live data and the three pages (market, holdings, account).
// All pages stay mounted and only the visible one shows: switching is instant and the market keeps its live data.
export function Trade({ me, path, onProfileSaved }: { me: Me; path: string; onProfileSaved: (me: Me) => void }) {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [ticks, setTicks] = useState<Record<string, number[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [ticketSide, setTicketSide] = useState<"BUY" | "SELL">("BUY");
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [history, setHistory] = useState<Order[]>([]);
  const [offsetMs, setOffsetMs] = useState(0);
  const [engine, setEngine] = useState<Session["engine"]>("running");
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const ordersRef = useRef(orders); // the socket handler needs the latest list without re-subscribing
  ordersRef.current = orders;

  const toast = useCallback((text: string, tone: Toast["tone"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  // History = the latest orders that are no longer open (filled, cancelled, expired, rejected), newest first.

  const refreshAccount = useCallback(async () => {
    const [p, o, all] = await Promise.all([
      api<Portfolio>("GET", "/portfolio"),
      api<{ orders: Order[] }>("GET", "/orders?open=true"),
      api<{ orders: Order[] }>("GET", `/orders?limit=${HISTORY_FETCH}`),
    ]);
    setPortfolio(p);
    setOrders(o.orders);
    setHistory(all.orders.filter((o) => !OPEN.includes(o.status)).slice(0, HISTORY_SIZE));
  }, []);

  const loadInstruments = useCallback(
    () =>
      api<{ instruments: Instrument[] }>("GET", "/market/instruments").then((r) => {
        setInstruments(r.instruments);
        setSelected((s) => s ?? r.instruments[0]?.symbol ?? null);
      }),
    [],
  );

  // One market clock for the header, the day banner and the day change, ticking every second.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const c = clock(now + offsetMs);

  // A new day (its pre-open): yesterday's close becomes the reference, so change % restarts from 0 and the
  // "Today" sparklines start empty. Waits a moment for the engine to store yesterday's closing bar.
  const dayRef = useRef(c.day);
  useEffect(() => {
    if (dayRef.current === c.day) return;
    dayRef.current = c.day;
    const t = setTimeout(() => {
      loadInstruments().catch(() => {});
      setTicks({});
      refreshAccount().catch(() => {});
    }, 3000);
    return () => clearTimeout(t);
  }, [c.day, loadInstruments, refreshAccount]);

  // First load: market, clock offset, account.
  useEffect(() => {
    loadInstruments().catch(() => {});
    api<Session>("GET", "/market/session").then((s) => setOffsetMs(new Date(s.serverTime).getTime() - Date.now()));
    refreshAccount().catch((err) => toast(errorOf(err), "down"));
  }, [loadInstruments, refreshAccount, toast]);

  // The server portfolio is refetched every 5 s (and on every fill); in between, prices re-value it on each tick.
  // The session check says whether the market engine (worker) is running, so a stopped market is never silent.
  useEffect(() => {
    const check = () => api<Session>("GET", "/market/session").then((s) => setEngine(s.engine ?? "running")).catch(() => {});
    check();
    const t = setInterval(() => {
      if (document.hidden) return;
      api<Portfolio>("GET", "/portfolio").then(setPortfolio).catch(() => {});
      check();
    }, 5000);
    return () => clearInterval(t);
  }, []);

  // Live socket: price ticks update the table; order updates toast and refresh the account.
  useEffect(() => {
    const onPrice = (m: Extract<LiveMsg, { type: "price" }>) => {
      const next = Number(m.price);
      setInstruments((list) =>
        list.map((i) => {
          if (i.symbol !== m.symbol) return i;
          const close = Number(i.prevClose);
          return { ...i, lastPrice: m.price, changePct: close ? (((next - close) / close) * 100).toFixed(2) : "0.00" };
        }),
      );
      setTicks((t) => ({ ...t, [m.symbol]: [...(t[m.symbol] ?? []), next].slice(-SPARK_POINTS) }));
    };
    const onOrder = (m: Extract<LiveMsg, { type: "order" }>) => {
      refreshAccount().catch(() => {});
      if (m.rejectReason === "MODIFIED") return; // the old half of a modify: "Order modified" was already shown
      if (m.rejectReason === "ORDER_CHANGED") return toast("Your change didn't go through: the order filled before it reached the market.", "down");
      const o = ordersRef.current.find((x) => x.id === m.orderId);
      const [word, tone] = ORDER_WORDS[m.status] ?? [m.status.toLowerCase(), "flat"];
      const what = o ? `${o.side === "BUY" ? "Buy" : "Sell"} ${o.quantity} ${o.symbol}` : "Your order";
      const at = m.avgFillPrice && (m.status === "FILLED" || m.status === "PARTIALLY_FILLED") ? ` at ${inr(m.avgFillPrice)}` : "";
      toast(`${what} ${word}${at}.`, tone);
    };
    return connectLive(
      (m) => (m.type === "price" ? onPrice(m) : onOrder(m)),
      (s) => (s === "signed-out" ? navigate("/login", true) : setLive(s)),
    );
  }, [refreshAccount, toast]);

  const livePortfolio = useMemo(
    () => portfolio && reprice(portfolio, Object.fromEntries(instruments.map((i) => [i.symbol, i.lastPrice]))),
    [portfolio, instruments],
  );

  const cancel = async (id: string) => {
    try {
      await api("DELETE", `/orders/${id}`);
      toast("Cancel sent. The order closes once the market confirms.", "flat");
    } catch (err) {
      toast(errorOf(err), "down");
    }
  };

  const modify = async (id: string, change: Change) => {
    try {
      await api("POST", `/orders/${id}/modify`, { ...change, clientOrderId: crypto.randomUUID() });
      toast("Order modified. It takes its new place in the queue.", "flat");
      refreshAccount().catch(() => {});
      return true;
    } catch (err) {
      toast(errorOf(err), "down");
      return false;
    }
  };

  const signOut = async () => {
    await api("POST", "/auth/logout").catch(() => {});
    navigate("/signed-out", true);
  };

  // Buy/Sell on the holdings page opens the market with that stock and side ready in the ticket.
  const trade = (symbol: string, side: "BUY" | "SELL") => {
    setSelected(symbol);
    setTicketSide(side);
    navigate("/");
    scrollTo(0, 0);
  };

  const view = path === "/holdings" || path === "/account" ? path : "/";

  return (
    <>
      <TopBar me={me} path={view} c={c} live={live}>
        <DayBanner c={c} portfolio={livePortfolio} />
      </TopBar>
      {engine === "stopped" && (
        <p className="banner" role="alert">
          The market is paused: prices and orders won't move until the market engine runs. Start it with <code>npm run worker</code>.
        </p>
      )}
      <div hidden={view !== "/"}>
        <main className="trade">
          <Summary portfolio={livePortfolio} />
          <MarketTable
            instruments={instruments}
            ticks={ticks}
            selected={selected}
            onSelect={(s) => {
              setSelected(s);
              setTicketSide("BUY");
            }}
          />
          <OrderTicket key={`${selected}-${ticketSide}`} initialSide={ticketSide} marketClosed={c.phase === "CLOSED"} instrument={instruments.find((i) => i.symbol === selected) ?? null} portfolio={livePortfolio} onPlaced={() => refreshAccount().catch(() => {})} />
          <Tabs portfolio={livePortfolio} orders={orders} history={history} onCancel={cancel} onModify={modify} />
        </main>
      </div>
      <div hidden={view !== "/holdings"}>
        <Holdings portfolio={livePortfolio} instruments={instruments} onTrade={trade} />
      </div>
      <div hidden={view !== "/account"}>
        <Account me={me} portfolio={livePortfolio} onProfileSaved={onProfileSaved} onSignOut={signOut} />
      </div>
      <Toasts toasts={toasts} />
    </>
  );
}
