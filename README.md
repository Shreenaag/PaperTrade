# PaperTrade

Paper-trading simulator (fake money, simulated prices) that demonstrates:
**Kafka** for exchange events, **OAuth + OTP** for login, **Redis** for fast profile/session/price access,
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
npm run worker:fair-value          # P2: hidden fair value per symbol -> Redis market:fairvalue (moves only in OPEN)
npm test                           # unit + integration tests (auth tests skip if compose is down)
```

Optional:
- Kafka UI: `docker compose --profile tools up -d` → http://localhost:8080
- Backend in Docker instead of `npm run dev`: `docker compose --profile app up -d --build`
- DB browser: `npm run db:studio`

## Market hours

One **trading day every 10 minutes**, back-to-back; cash and holdings carry over between days.
Days start on the :00, :10, :20 … minute boundaries (`src/shared/marketClock.ts`, `GET /market/session`).

| Phase | Length | Prices | Orders |
|---|---|---|---|
| `PRE_OPEN` | 2.5 min | frozen at previous close | accepted and queued, nothing fills; at the open an **opening auction** fills crossing orders at one price per symbol |
| `OPEN` | 5 min | last traded price | continuous matching in the order book (price-time priority, partial fills) |
| `POST_CLOSE` | 2.5 min | frozen at the close | fill **only at the closing price**; when it ends, unfilled orders → `EXPIRED`, reservations released |

Every order and trade records its `tradingDay`; `daily_bars` keeps each day's OHLC (the next day starts from `close`).
The phase when an order is *matched* decides how it fills. The clock is wall-clock based, so days keep passing while workers are down.

## Auth (P1)

OAuth (Google/GitHub) proves who you are, a 6-digit email OTP is the second step, then a Redis session cookie.

```
GET  /auth/providers            enabled providers (those with credentials in .env)
GET  /auth/:provider/login      -> provider consent screen (state + PKCE)
GET  /auth/:provider/callback   -> user found/linked/created (+ ₹STARTING_CASH), OTP sent,
                                   pending session cookie, redirect WEB_APP_URL/verify-otp
                                   (failures: WEB_APP_URL/login?error=<reason>)
POST /auth/otp/verify {code}    -> full 24h session (new id); 5 wrong tries = locked
POST /auth/otp/resend           -> new code, 60s cooldown
POST /auth/logout
GET  /me                        profile (Redis cache-aside); 401 {error: UNAUTHENTICATED | OTP_REQUIRED}
```

Setup: create an OAuth app (GitHub: Settings → Developer settings → OAuth Apps; Google: Cloud Console → Credentials),
callback `http://localhost:3000/auth/<provider>/callback`, put the id/secret in `.env`. Without `SMTP_URL` the OTP
is printed in the `npm run dev` log. Until the frontend exists (P5), finish the login from the browser console on
`http://localhost:3000`: `fetch('/auth/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'123456'})})`,
then open `/me`.

Protect any later route with `{ preHandler: requireAuth(redis) }` (`src/modules/auth/session.ts`); it sets `req.user`.
The containerised backend runs with `NODE_ENV=production`, which requires `SMTP_URL`.

## Architecture

```
            ┌───────────── backend (one codebase, modules) ─────────────┐
 browser ──►│ api (Fastify): auth · market · orders · portfolio · health│
            │ workers (P2/P3): fair-value · bots · matching · settlement · relay│
            └──────┬──────────────────┬──────────────────────┬──────────┘
                   │                  │                      │
              Postgres            Redis                   Kafka
          (source of truth)   (sessions, OTP,     market.prices.v1   key=symbol
                              profile cache,      orders.placed.v1   key=symbol
                              latest prices,      orders.updates.v1  key=userId
                              leaderboard)        trades.executed.v1 key=userId
```

Order flow (P3): API validates + reserves cash/shares and writes `Order` + `OutboxEvent` in one transaction →
relay publishes `orders.placed` → matching engine crosses buyers and sellers in a per-symbol order book per the market phase
(auction / continuous / closing price) → `trades.executed` →
settlement writes `Trade`, updates `Account`/`Holding`/`LedgerEntry` (idempotent on trade id) → `orders.updates`.

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
| Sessions/OTP | Redis with TTLs (`src/shared/redisKeys.ts`) | Fast, auto-expiring |
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
  src/shared/marketClock.ts 10-minute trading day: phases + fill mode per phase
  src/modules/<feature>/    one folder per feature: health, auth, market (orders, portfolio next)
```

Adding a later phase = new folder in `src/modules/`, new env vars in `env.ts`, and (if needed) an additive migration.
Schema changes go through `npm run db:migrate -- --name <change>`; never edit an applied migration.

## Roadmap

- **P0 Foundation** ✅ infra, data model, skeleton, health checks
- **P1 Auth** ✅ OAuth (Google/GitHub) → OTP → Redis session
- **P2 Market data** ✅ hidden fair-value simulator (moves only in `OPEN`) that bots trade around
- P3 Trading: orders → order-book matching (opening auction, continuous, closing price, end-of-day expiry) → settlement via Kafka (+ outbox relay);
  traded price → `market.prices.v1` → Redis + `daily_bars`; dummy traders (`src/modules/bots`, `User.isBot`) place orders through the same path as players
- P4 Portfolio & P&L
- P5 UI, WebSockets, leaderboard
