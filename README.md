# PaperTrade

Paper-trading simulator (fake money, simulated prices) that demonstrates:
**Kafka** for exchange events, **OAuth (GitHub/Google)** for login, **Redis** for fast profile/session/price access,
**Postgres** as the source of truth.

Stack: Node.js 24 + TypeScript, Fastify 5, Prisma 7, kafkajs, ioredis, Zod. Modular monolith.

## Run it

```bash
cp .env.example .env               # once
docker compose up -d --wait        # postgres, redis, kafka
cd backend
npm install
npm run db:migrate                 # apply migrations (+ generates the Prisma client)
npm run db:seed                    # 10 NSE instruments
npm run dev                        # http://localhost:3000/health/ready
npm run worker                     # second terminal: fair value, outbox relay, matching, settlement, bots (all background jobs)
npm test                           # unit + integration tests (auth tests skip if compose is down)
```

Run **one** worker. A second one waits 15 s for the Redis lock `lock:worker`, then exits: two would publish every command twice and run two sets of bots.

Optional:
- Kafka UI: `docker compose --profile tools up -d` → http://localhost:8080
- Backend in Docker instead of `npm run dev`: `docker compose --profile app up -d --build`
- DB browser: `npm run db:studio`

## Market hours

One **trading day every 6 min 20 s** (30 s pre-open, 5 min open, 30 s closing, 20 s closed), back-to-back; cash and holdings carry over between days.
Days start on the :00, :10, :20 … minute boundaries (`src/shared/marketClock.ts`, `GET /market/session`).

| Phase | Length | Prices | Orders |
|---|---|---|---|
| `PRE_OPEN` | 2.5 min | frozen at previous close | accepted and queued, nothing fills; at the open an **opening auction** fills crossing orders at one price per symbol |
| `OPEN` | 5 min | last traded price | continuous matching in the order book (price-time priority, partial fills) |
| `POST_CLOSE` | 2.5 min | frozen at the close | fill **only at the closing price**; when it ends, unfilled orders → `EXPIRED`, reservations released |

Every order and trade records its `tradingDay`; `daily_bars` keeps each day's OHLC (the next day starts from `close`).
The phase when an order is *matched* decides how it fills. The clock is wall-clock based, so days keep passing while workers are down.

## Auth (P1)

Sign in with GitHub (or Google) and you're in: OAuth proves who you are, then a Redis session cookie.
A new player completes a profile (name + unique @handle) before they can trade; a returning player goes straight to trading.
(The email one-time code from the first version was removed on 2026-10-16 at the user's request; it is in git history.)

```
GET  /auth/providers            enabled providers (those with credentials in .env)
GET  /auth/:provider/login      -> provider consent screen (state + PKCE)
GET  /auth/:provider/callback   -> user found/linked/created (+ ₹STARTING_CASH), 24h session cookie,
                                   redirect WEB_APP_URL/profile (new player) or WEB_APP_URL/ (profile done)
                                   (failures: WEB_APP_URL/login?error=<reason>)
POST /auth/logout
GET  /me                        profile (Redis cache-aside), incl. handle + profileComplete; 401 {error: UNAUTHENTICATED}
PUT  /me/profile {displayName, handle}  -> profile complete; 409 HANDLE_TAKEN. POST /orders is 403 PROFILE_INCOMPLETE until then
```

Setup: create an OAuth app (GitHub: Settings → Developer settings → OAuth Apps; Google: Cloud Console → Credentials),
callback `http://localhost:3000/auth/<provider>/callback`, put the id/secret in `.env`.

Protect any later route with `{ preHandler: requireAuth(redis) }` (`src/modules/auth/session.ts`); it sets `req.user`.

## Orders (P3a)

```
POST   /orders      {symbol, side, type: MARKET|LIMIT, quantity, limitPrice?, clientOrderId?} -> 201 order (OPEN)
GET    /orders?open=true                                                                  latest 50
DELETE /orders/:id                                                                        202; the engine decides
```
Placing an order reserves cash (BUY: worst price × qty + 0.03% fee) or shares (SELL) in the same transaction
that writes the order and its outbox command. Rules live in `src/shared/limits.ts`: LIMIT within ±10% of the
previous close and on the tick; MARKET fills at most 5% from the last price; ≤ 10,000 shares and ≤ ₹10,00,000
per order; per user 5 orders/s, 100/day, 20 open (bots exempt). Login is limited to 20/min per IP.
Errors are `{ error: "CODE" }` (`INSUFFICIENT_CASH`, `PRICE_OUT_OF_BAND`, `RATE_LIMITED`, …).

Matching (`src/modules/matching`): one in-memory book per symbol (`book.ts`, pure and unit-tested) fed by
`orders.commands.v1`. Phase changes enter the same log as `CLOCK` commands, so on restart the engine replays
today's commands and rebuilds identical books; fills/ends carry name-based ids, so re-sent events are deduped by
settlement. Orders left open from an earlier day are expired on start.

## Bots (P3c)

Dummy traders compete with players in the same order books (`src/modules/bots`, started by `npm run worker`).
On start the worker creates three bot users per instrument (`isBot`, `bot.<kind>.<symbol>@bots.papertrade.local`),
each with ₹20,00,000 cash and ₹10,00,000 of its stock. They call `placeOrder`/`cancelOrder` directly, so they hit the
same checks, reservations, outbox, matching and settlement as players; only the per-user rate limits are skipped.

| Bot | When | Does |
|---|---|---|
| market maker | `PRE_OPEN`, `OPEN` | one bid and one ask at the hidden fair value ±0.1%, requoted when fair value moves off them |
| noise | `OPEN` | random small MARKET or LIMIT (±0.5% of fair value) orders; at most 3 resting |
| momentum | `OPEN` | MARKET order in the direction of a ≥0.2% move in the traded price since its last look |

Each bot acts about every 5 s (≈6 orders/s in total). Every `PRE_OPEN`, once yesterday's orders are settled, bots
are topped back up to their starting cash (`RESET` ledger entry) and shares. Rules live in `strategies.ts` (pure, unit-tested).

Storage stays small: Kafka topics keep 1 hour, published outbox rows are pruned after 1 hour, dedupe rows after 2.

## Architecture

```
            ┌───────────── backend (one codebase, modules) ─────────────┐
 browser ──►│ api (Fastify): auth · market · orders · portfolio · health│
            │ worker (1 process): fair-value · relay · settlement · matching · bots│
            └──────┬──────────────────┬──────────────────────┬──────────┘
                   │                  │                      │
              Postgres            Redis                   Kafka
          (source of truth)   (sessions,          market.prices.v1   key=symbol
                              profile cache,      orders.commands.v1 key=symbol  (PLACE, CANCEL, CLOCK)
                              latest prices,      orders.updates.v1  key=userId
                              leaderboard)        orders.executions.v1 key=userId (FILL, END)
```

Order flow (P3): API validates + reserves cash/shares and writes `Order` + `OutboxEvent` in one transaction →
relay publishes `orders.commands` → matching engine crosses buyers and sellers in a per-symbol order book per the market phase
(auction / continuous / closing price) → `orders.executions` (two FILLs per match, or END) →
settlement writes `Trade`, updates `Account`/`Holding`/`LedgerEntry` (idempotent on event id) → `orders.updates`.

## Design decisions (locked in P0)

| Area | Decision | Why |
|---|---|---|
| Money | `Decimal(20,4)` in DB, decimal **strings** in events | No float rounding errors |
| IDs | UUIDv7; instruments keyed by `symbol` | Time-ordered indexes; Kafka key == FK |
| Integrity | DB `CHECK`s: no negative cash/shares, reserved ≤ total, LIMIT ⇔ limitPrice | Bugs fail loudly instead of creating money |
| Reservations | `reservedCash` / `reservedQuantity` | Can't spend the same cash on two open orders |
| Audit | Append-only `LedgerEntry` | Every balance change is explainable |
| Kafka delivery | Idempotent producer + transactional **outbox** + consumer **inbox** (`ProcessedEvent`) | At-least-once delivery without double-processing |
| Kafka ordering | Partition by symbol for orders/prices, by user for trades/updates | Per-instrument and per-user ordering |
| Market calendar | 10-min days from a pure wall-clock function | Every process agrees on the phase with no coordination |
| Topic versions | `.v1` suffix, payloads validated by Zod both ways | Breaking change = new topic |
| OAuth | Store only `(provider, providerAccountId)`, never provider tokens | Identity only; nothing secret to leak |
| Sessions | Redis with TTLs (`src/shared/redisKeys.ts`) | Fast, auto-expiring |
| Config | Zod-validated env, crash at startup if invalid | No half-configured server |

## Layout

```
docker-compose.yml          postgres, redis, kafka (+ kafka-ui, backend profiles)
backend/
  prisma/schema.prisma      data model (10 tables)
  prisma/migrations/        SQL migrations (init includes CHECK constraints)
  prisma/seed.ts            instruments
  src/server.ts             entry: connect deps, ensure topics, listen, graceful shutdown
  src/app.ts                Fastify factory; feature modules register here
  src/config/env.ts         env schema
  src/infra/                db (Prisma), redis, kafka clients
  src/shared/events.ts      Kafka topics + event contracts
  src/shared/redisKeys.ts   Redis key names + TTLs
  src/shared/marketClock.ts 6 min 20 s trading day: phases + fill mode per phase
  src/modules/<feature>/    one folder per feature: health, auth, market, orders, matching, settlement, bots (portfolio next)
```

Adding a later phase = new folder in `src/modules/`, new env vars in `env.ts`, and (if needed) an additive migration.
Schema changes go through `npm run db:migrate -- --name <change>`; never edit an applied migration.

## Roadmap

- **P0 Foundation** ✅ infra, data model, skeleton, health checks
- **P1 Auth** ✅ OAuth (Google/GitHub) → Redis session (email OTP removed in P5) → profile
- **P2 Market data** ✅ hidden fair-value simulator (moves only in `OPEN`) that bots trade around
- **P3 Trading** ✅ (P3a ✅ orders API, outbox relay, settlement · P3b ✅ matching engine · P3c ✅ bots): orders → order-book matching (opening auction, continuous, closing price, end-of-day expiry) → settlement via Kafka (+ outbox relay);
  traded price → `market.prices.v1` → Redis + `daily_bars`; dummy traders (`src/modules/bots`, `User.isBot`) place orders through the same path as players
- **P4 Portfolio & P&L** ✅ `GET /portfolio` (cash, positions at last price, realized/unrealized P&L, return %),
  `GET /trades` and `GET /orders` with `?before=<id>&limit=` keyset paging
- P5 UI, WebSockets, leaderboard
