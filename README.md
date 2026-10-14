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
npm test                           # unit tests
```

Optional:
- Kafka UI: `docker compose --profile tools up -d` → http://localhost:8080
- Backend in Docker instead of `npm run dev`: `docker compose --profile app up -d --build`
- DB browser: `npm run db:studio`

## Architecture

```
            ┌───────────── backend (one codebase, modules) ─────────────┐
 browser ──►│ api (Fastify): auth · market · orders · portfolio · health│
            │ workers (P2/P3): price-feed · matching · settlement · relay│
            └──────┬──────────────────┬──────────────────────┬──────────┘
                   │                  │                      │
              Postgres            Redis                   Kafka
          (source of truth)   (sessions, OTP,     market.prices.v1   key=symbol
                              profile cache,      orders.placed.v1   key=symbol
                              latest prices,      orders.updates.v1  key=userId
                              leaderboard)        trades.executed.v1 key=userId
```

Order flow (P3): API validates + reserves cash/shares and writes `Order` + `OutboxEvent` in one transaction →
relay publishes `orders.placed` → matching engine fills against the latest price → `trades.executed` →
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
  src/modules/<feature>/    one folder per feature (health now; auth, market, orders, portfolio next)
```

Adding a later phase = new folder in `src/modules/`, new env vars in `env.ts`, and (if needed) an additive migration.
Schema changes go through `npm run db:migrate -- --name <change>`; never edit an applied migration.

## Roadmap

- **P0 Foundation** ✅ infra, data model, skeleton, health checks
- P1 Auth: OAuth (Google/GitHub) → OTP → Redis session
- P2 Market data: price simulator → `market.prices.v1` → Redis
- P3 Trading: orders → matching → settlement via Kafka (+ outbox relay)
- P4 Portfolio & P&L
- P5 UI, WebSockets, leaderboard
