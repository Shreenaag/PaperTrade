// One WebSocket to /ws. The server pushes price ticks to everyone and order updates to their owner.

export type LiveMsg =
  | { type: "price"; symbol: string; price: string; phase: string; tradingDay: number }
  | { type: "order"; orderId: string; status: string; filledQuantity: number; avgFillPrice: string | null; rejectReason: string | null };

export type LiveStatus = "connecting" | "live" | "reconnecting" | "signed-out";

const RETRY_MS = [2000, 4000, 8000]; // then every 8 s

export function connectLive(onMessage: (m: LiveMsg) => void, onStatus: (s: LiveStatus) => void): () => void {
  let socket: WebSocket;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const open = () => {
    onStatus(attempt ? "reconnecting" : "connecting");
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.onopen = () => {
      attempt = 0;
      onStatus("live");
    };
    socket.onmessage = (e) => onMessage(JSON.parse(String(e.data)) as LiveMsg);
    socket.onclose = (e) => {
      if (stopped) return;
      if (e.code === 4401) return onStatus("signed-out");
      onStatus("reconnecting");
      timer = setTimeout(open, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    };
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    socket.close();
  };
}
