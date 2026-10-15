import { PHASE_SECONDS } from "../../shared/marketClock.js";

// Hidden "true value" of each instrument. Players never see it; bots (P3) quote and trade around it,
// and the traded price players see comes from the order book.
// Floats are fine here: this is a simulation input, not money. It becomes a decimal string at the edge.

const YEAR_IN_SIM_SECONDS = PHASE_SECONDS.OPEN * 252; // one OPEN phase = one real trading day

// Geometric Brownian motion step: annualised volatility sigma, dtSeconds of OPEN time.
export function stepFairValue(price: number, sigma: number, dtSeconds: number, rand: () => number = Math.random): number {
  const dt = dtSeconds / YEAR_IN_SIM_SECONDS;
  return price * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * gaussian(rand));
}

export function toTickString(price: number, tickSize: number): string {
  return (Math.max(1, Math.round(price / tickSize)) * tickSize).toFixed(4);
}

// Box-Muller; 1 - rand() keeps log() away from 0.
function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
