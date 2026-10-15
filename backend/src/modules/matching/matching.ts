import type { Db } from "../../infra/db.js";
import type { Kafka, Producer } from "../../infra/kafka.js";
import type { Redis } from "../../infra/redis.js";
import { makeEvent, parseEvent, Topics, type EventEnvelope } from "../../shared/events.js";
import { dayStartsAt, sessionAt } from "../../shared/marketClock.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { Book, stableUuid, type BookEvent } from "./book.js";

// Matching engine runner: feeds orders.commands.v1 into one in-memory Book per symbol and ships the results:
//   fills / ends  -> orders.executions.v1 (key userId) for settlement
//   traded price  -> market.prices.v1 + Redis market:prices
//   day's OHLC    -> daily_bars
// No offsets are committed. On start it reads the topic from the beginning and skips everything before
// today's PRE_OPEN, rebuilding today's books exactly (books never outlive a 10-minute day).
// Re-sent events carry the same ids, so settlement ignores them.
// shortcut: reads the whole retained topic (1h) on start; fine at this volume, seek by timestamp if it grows.

const GROUP = "matching";

export async function startMatching(kafka: Kafka, producer: Producer, db: Db, redis: Redis): Promise<() => Promise<void>> {
  const today = sessionAt().tradingDay;
  const fromMs = dayStartsAt(today).getTime();

  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    include: { dailyBars: { where: { tradingDay: { lt: today } }, orderBy: { tradingDay: "desc" }, take: 1 } },
  });
  const books = new Map(instruments.map((i) => [i.symbol, new Book(i.symbol, (i.dailyBars[0]?.close ?? i.initialPrice).toFixed(4), today)]));

  const emit = async (book: Book, events: BookEvent[]) => {
    const execs = events.filter((e) => e.kind === "EXEC");
    if (execs.length) {
      await producer.send({
        topic: Topics.executions.name,
        messages: execs.map((e) => ({ key: e.payload.userId, value: JSON.stringify(makeEvent("executions", e.payload, e.id)) })),
      });
    }
    for (const e of events) {
      if (e.kind === "PRICE") {
        const tick = makeEvent("prices", { symbol: book.symbol, price: e.price, tradingDay: book.day, phase: e.phase, ts: new Date().toISOString() });
        await redis.hset(RedisKeys.prices, book.symbol, JSON.stringify(tick.payload));
        await producer.send({ topic: tick.topic, messages: [{ key: book.symbol, value: JSON.stringify(tick) }] });
      } else if (e.kind === "BAR") {
        const { tradingDay, open, high, low, close } = e;
        await db.dailyBar.upsert({
          where: { symbol_tradingDay: { symbol: book.symbol, tradingDay } },
          create: { symbol: book.symbol, tradingDay, open, high, low, close },
          update: { open, high, low, close },
        });
      }
    }
  };

  await expireStaleOrders(db, producer, today);

  const consumer = kafka.consumer({ groupId: GROUP });
  await consumer.connect();
  await consumer.subscribe({ topic: Topics.orderCommands.name, fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ message }) => {
      if (Number(message.timestamp) < fromMs) return; // an earlier day: its orders are already settled or expired
      let event: EventEnvelope<"orderCommands">;
      try {
        event = parseEvent("orderCommands", message.value);
      } catch (err) {
        console.error("matching: skipping malformed command", err);
        return;
      }
      const book = books.get(event.payload.symbol);
      if (!book) return; // API only accepts active instruments
      await emit(book, book.handle(event.payload, new Date(Number(message.timestamp)).toISOString()));
    },
  });

  // Phase changes enter the log as CLOCK commands (one per symbol). Duplicates are harmless: a book ignores
  // a phase it has already reached.
  let lastClock = "";
  const tick = async () => {
    const { tradingDay, phase } = sessionAt();
    if (`${tradingDay}:${phase}` === lastClock) return;
    await producer.send({
      topic: Topics.orderCommands.name,
      messages: [...books.keys()].map((symbol) => ({
        key: symbol,
        value: JSON.stringify(makeEvent("orderCommands", { kind: "CLOCK", symbol, tradingDay, phase })),
      })),
    });
    lastClock = `${tradingDay}:${phase}`;
  };
  await tick();
  const timer = setInterval(() => tick().catch((err) => console.error("matching: clock send failed", err)), 500);

  return async () => {
    clearInterval(timer);
    await consumer.disconnect();
  };
}

// Orders from earlier days still open in the DB (the worker was down at day end, or Kafka was reset):
// expire them so their reservations come back. Same END id as the book would use, so never applied twice.
async function expireStaleOrders(db: Db, producer: Producer, today: number) {
  const stale = await db.order.findMany({
    where: { tradingDay: { lt: today }, status: { in: ["OPEN", "PARTIALLY_FILLED"] } },
    select: { id: true, userId: true },
  });
  if (!stale.length) return;
  await producer.send({
    topic: Topics.executions.name,
    messages: stale.map((o) => ({
      key: o.userId,
      value: JSON.stringify(
        makeEvent("executions", { kind: "END", orderId: o.id, userId: o.userId, status: "EXPIRED", reason: "DAY_END" }, stableUuid("end", o.id)),
      ),
    })),
  });
}
