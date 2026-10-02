import { useMemo, useRef, useState } from 'react';
import { formatInr } from '../../lib/format.js';

/*
 * Chart primitives, drawn as plain SVG.
 *
 * No charting library. Three forms are needed here — a line over time, a
 * column per interval, a horizontal bar per name — and a library that draws
 * all three brings a renderer, a scale system and a theme layer to do what
 * forty lines of SVG do. It would also fight the glass panels for control of
 * colour, which is the part that had to be measured rather than chosen.
 *
 * Every mark here follows the same rules: 2px strokes, data-ends rounded 4px
 * and anchored to the baseline, a 2px surface gap between adjacent fills,
 * recessive grid, and a hover readout on everything that has a plot. Values
 * are in text tokens, never in the series colour — the mark carries identity,
 * the text carries the number.
 */

const PAD = { top: 12, right: 14, bottom: 26, left: 56 };

/** Nice round ceiling, so the axis reads 0 / 2 Cr / 4 Cr rather than 3.86. */
function niceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const step = [1, 2, 2.5, 5, 10].find((s) => v <= s * mag) ?? 10;
  return step * mag;
}

/*
 * Axis labels at one consistent precision per axis, decided by the largest
 * value on it — "10Cr" above "5.0Cr" reads as two different scales.
 */
function axisLabeller(max) {
  const a = Math.abs(max);
  if (a >= 1e7) return (v) => `${(v / 1e7).toFixed(1)} Cr`;
  if (a >= 1e5) return (v) => `${(v / 1e5).toFixed(1)} L`;
  if (a >= 1000) return (v) => `${Math.round(v / 1000)}k`;
  return (v) => String(Math.round(v));
}

/** Shared empty state: says why there is nothing, never draws an empty box. */
function Empty({ children }) {
  return (
    <div className="grid min-h-[140px] place-items-center px-4 text-center">
      <p className="max-w-[46ch] text-[12px] text-mute text-pretty">{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A measure over time. One series, so no legend — the title names it.
 *
 * Points are plotted at their real dates, not at even intervals: imports
 * happen when somebody remembers, and spacing them evenly would draw a
 * steady decline where there was a six-day gap and then a fortnight's.
 */
export function TimeLine({ points, height = 190, color = 'var(--color-teal)', valueLabel = 'Value' }) {
  const wrap = useRef(null);
  const [hover, setHover] = useState(null);
  const W = 680;
  const H = height;

  const geom = useMemo(() => {
    if (!points?.length) return null;
    const xs = points.map((p) => new Date(p.date).getTime());
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const span = maxX - minX || 1;
    /*
     * The y-axis does NOT start at zero, and there is no area fill.
     *
     * The book moves between ₹7.4 Cr and ₹7.9 Cr. Against a zero baseline
     * that is a flat line — the chart would be honest and useless, which is
     * its own kind of dishonest, because the reader concludes nothing is
     * happening when ₹5.6 Cr has come in. A line may be truncated where a bar
     * may not: a line encodes position, not length, so no mark's size is
     * being misread. The fill is dropped for the same reason — an area
     * implies magnitude from a baseline, and this baseline is not zero.
     *
     * Both axis ends are labelled, so the range is never left implied.
     */
    const vals = points.map((p) => p.value);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const padding = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.18;
    const min = lo - padding;
    const max = hi + padding;
    const x = (t) => PAD.left + ((t - minX) / span) * (W - PAD.left - PAD.right);
    const y = (v) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);
    return {
      min,
      max,
      pts: points.map((p, i) => ({ ...p, i, cx: x(new Date(p.date).getTime()), cy: y(p.value) })),
      y,
    };
  }, [points, H]);

  if (!geom) {
    return <Empty>Two imports are needed before a trend exists. Import tomorrow's export and the line begins.</Empty>;
  }

  const { pts, min, max, y } = geom;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
  const label = axisLabeller(max);
  const ticks = [0, 0.5, 1].map((f) => min + (max - min) * f);

  /*
   * Only labels that will not collide. With five imports a few days apart,
   * every date drawn means "9 Sep10 Sep" running together; the first and last
   * always survive, and the rest are kept only where there is room.
   */
  const MIN_GAP = 52;
  const shown = [];
  let lastX = -Infinity;
  pts.forEach((p, i) => {
    const isEnd = i === 0 || i === pts.length - 1;
    if (isEnd || p.cx - lastX >= MIN_GAP) {
      if (i === pts.length - 1 && shown.length && p.cx - lastX < MIN_GAP) shown.pop();
      shown.push(p);
      lastX = p.cx;
    }
  });

  function onMove(e) {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.cx - px) < Math.abs(best.cx - px)) best = p;
    setHover(best);
  }

  return (
    <div ref={wrap} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={valueLabel}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)}
                  stroke="var(--color-rule)" strokeWidth="1" />
            <text x={PAD.left - 8} y={y(t) + 3.5} textAnchor="end"
                  className="fill-[var(--color-faint)] text-[9px]">{label(t)}</text>
          </g>
        ))}

        <path d={line} fill="none" stroke={color} strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round" />

        {pts.map((p) => (
          <circle key={p.i} cx={p.cx} cy={p.cy} r={hover?.i === p.i ? 5 : 3.5}
                  fill={color} stroke="var(--color-surface)" strokeWidth="2" />
        ))}

        {hover ? (
          <line x1={hover.cx} x2={hover.cx} y1={PAD.top} y2={H - PAD.bottom}
                stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
        ) : null}

        {shown.map((p) => (
          <text key={`l${p.i}`} x={p.cx} y={H - 8}
                textAnchor={p.i === 0 ? 'start' : p.i === pts.length - 1 ? 'end' : 'middle'}
                className="fill-[var(--color-faint)] text-[9px]">{p.label}</text>
        ))}
      </svg>

      {hover ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-[3px] border border-hair bg-surface px-[9px] py-[6px] text-[11px] shadow-[0_6px_18px_-8px_rgba(15,31,46,.45)]"
          style={{ left: `${(hover.cx / W) * 100}%`, top: `${(hover.cy / H) * 100}%` }}
        >
          <div className="font-mono text-[9.5px] uppercase tracking-[0.07em] text-faint">{hover.label}</div>
          <div className="tnum mt-[2px] font-semibold">{formatInr(hover.value)}</div>
          {hover.note ? <div className="mt-[2px] text-[10.5px] text-mute">{hover.note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** A value per interval. Columns, because the periods are discrete. */
export function Columns({ bars, height = 170, color = 'var(--color-teal)', empty }) {
  const [hover, setHover] = useState(null);
  if (!bars?.length) return <Empty>{empty}</Empty>;

  const W = 680;
  const H = height;
  const max = niceMax(Math.max(...bars.map((b) => b.value)));
  const label = axisLabeller(max);
  const plotH = H - PAD.top - PAD.bottom;
  // 2px of surface between neighbours, so two full columns never merge.
  const slot = (W - PAD.left - PAD.right) / bars.length;
  const bw = Math.max(6, Math.min(44, slot - 10));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + (1 - f) * plotH} y2={PAD.top + (1 - f) * plotH}
                  stroke="var(--color-rule)" strokeWidth="1" />
            <text x={PAD.left - 8} y={PAD.top + (1 - f) * plotH + 3.5} textAnchor="end"
                  className="fill-[var(--color-faint)] text-[9px]">{label(max * f)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const h = Math.max(2, (b.value / max) * plotH);
          const x = PAD.left + slot * i + (slot - bw) / 2;
          return (
            <g key={i} onMouseEnter={() => setHover({ ...b, i, x: x + bw / 2, y: PAD.top + plotH - h })}
               onMouseLeave={() => setHover(null)}>
              {/* A full-height hit area: a 6px column is not a hover target. */}
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent" />
              <rect x={x} y={PAD.top + plotH - h} width={bw} height={h}
                    rx="4" ry="4" fill={color} opacity={hover && hover.i !== i ? 0.45 : 1} />
              <text x={x + bw / 2} y={H - 8} textAnchor="middle"
                    className="fill-[var(--color-faint)] text-[9px]">{b.label}</text>
            </g>
          );
        })}
      </svg>
      {hover ? (
        <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-[3px] border border-hair bg-surface px-[9px] py-[6px] text-[11px] shadow-[0_6px_18px_-8px_rgba(15,31,46,.45)]"
             style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%` }}>
          <div className="font-mono text-[9.5px] uppercase tracking-[0.07em] text-faint">{hover.label}</div>
          <div className="tnum mt-[2px] font-semibold">{formatInr(hover.value)}</div>
          {hover.note ? <div className="mt-[2px] text-[10.5px] text-mute">{hover.note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Magnitude by name. One hue, because the bars are already named — colouring
 * each one differently would encode identity twice and say nothing new.
 */
export function RankedBars({ rows, empty, unit = 'money' }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);

  return (
    <div className="grid gap-[7px]">
      {rows.map((r) => (
        <div key={r.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[12px]">{r.name}</span>
              {r.meta ? <span className="shrink-0 text-[10.5px] text-faint">{r.meta}</span> : null}
            </div>
            <div className="mt-[3px] h-[7px] w-full overflow-hidden rounded-[2px] bg-surface-3">
              <div className="h-full rounded-[2px]"
                   style={{ width: `${Math.max((Math.abs(r.value) / max) * 100, 1.5)}%`,
                            background: r.color ?? 'var(--color-teal)' }} />
            </div>
          </div>
          <span className="tnum w-[84px] shrink-0 text-right text-[12px] font-medium">
            {unit === 'money' ? formatInr(r.value) : `${Math.round(r.value)}${r.suffix ?? ''}`}
          </span>
        </div>
      ))}
    </div>
  );
}
