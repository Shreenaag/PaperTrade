import type { Instrument } from "../api.js";
import { direction, pct, price } from "../format.js";
import { Sparkline } from "./Sparkline.js";

export function MarketTable(props: {
  instruments: Instrument[];
  ticks: Record<string, number[]>;
  selected: string | null;
  onSelect: (symbol: string) => void;
}) {
  const { instruments, ticks, selected, onSelect } = props;
  return (
    <section className="panel market" aria-labelledby="market-title">
      <h2 id="market-title" className="panel-title">
        Market
      </h2>
      <table>
        <thead>
          <tr>
            <th>Stock</th>
            <th className="num">Last</th>
            <th className="num">Change</th>
            <th className="spark-col">Today</th>
          </tr>
        </thead>
        <tbody>
          {instruments.map((i) => (
            <tr
              key={i.symbol}
              className={i.symbol === selected ? "selected" : undefined}
              onClick={() => onSelect(i.symbol)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(i.symbol))}
              tabIndex={0}
              aria-selected={i.symbol === selected}
            >
              <td>
                <span className="symbol">{i.symbol}</span>
                <span className="name">{i.name}</span>
              </td>
              <td className="num last">{price(i.lastPrice)}</td>
              <td className={`num ${direction(i.changePct)}`}>{pct(i.changePct)}</td>
              <td className="spark-col">
                <Sparkline points={ticks[i.symbol] ?? []} trend={direction(i.changePct)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
