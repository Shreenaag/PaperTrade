import type { WebSocket } from "@fastify/websocket";

// In-memory fan-out of live messages to this process's open sockets.
// shortcut: per-process; with several API instances each one consumes every event, fine until sockets number in the thousands.

export type PriceMsg = { type: "price"; symbol: string; price: string; phase: string; tradingDay: number };
export type OrderMsg = {
  type: "order";
  orderId: string;
  status: string;
  filledQuantity: number;
  avgFillPrice: string | null;
  rejectReason: string | null;
};

export interface LiveHub {
  add(userId: string, socket: WebSocket): void;
  price(msg: PriceMsg): void;
  order(userId: string, msg: OrderMsg): void;
}

export function createHub(): LiveHub {
  const byUser = new Map<string, Set<WebSocket>>();
  const send = (socket: WebSocket, msg: PriceMsg | OrderMsg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  return {
    add(userId, socket) {
      const sockets = byUser.get(userId) ?? byUser.set(userId, new Set()).get(userId)!;
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
        if (!sockets.size) byUser.delete(userId);
      });
    },
    price(msg) {
      for (const sockets of byUser.values()) for (const s of sockets) send(s, msg);
    },
    order(userId, msg) {
      for (const s of byUser.get(userId) ?? []) send(s, msg);
    },
  };
}
