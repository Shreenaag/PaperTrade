// Inline SVG line of this session's ticks. No chart library: it is one polyline.
export function Sparkline({ points, trend }: { points: number[]; trend: string }) {
  if (points.length < 2) return <svg className="spark" aria-hidden />;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 100},${28 - ((p - min) / span) * 26}`).join(" ");
  return (
    <svg className={`spark ${trend}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <polyline points={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
