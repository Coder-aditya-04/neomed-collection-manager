import { useEffect, useMemo, useState } from 'react';

/**
 * A point of light that runs along the background grid.
 *
 * The earlier version swept wide green bands across the whole screen, which
 * read as a fault rather than an effect — too much of the field moving at
 * once, and impossible to ignore while reading a column of figures.
 *
 * This traces instead: a short bright segment travelling one grid line at a
 * time, turning corners at the intersections, the way current moves through
 * a circuit board. Only a few pixels are lit at any moment, so it registers
 * at the edge of vision and disappears the moment you look at a number.
 *
 * Animated with stroke-dashoffset on a handful of paths — cheap, and confined
 * to one SVG layer that nothing else has to repaint around.
 */

const CELL = 34;          // matches the grid drawn on the body
const SEGMENT = 90;       // how much of the path is lit
const TRACE_COUNT = 7;

/** Deterministic, so the routes do not reshuffle on every render. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * A right-angled walk along grid lines, snapped to the cell size so the trace
 * sits exactly on the drawn lines rather than floating across the squares.
 */
function buildRoute(rand, width, height) {
  const cols = Math.max(2, Math.floor(width / CELL));
  const rows = Math.max(2, Math.floor(height / CELL));

  let x = Math.floor(rand() * cols) * CELL;
  let y = Math.floor(rand() * rows) * CELL;
  const points = [[x, y]];
  let horizontal = rand() < 0.5;

  const legs = 5 + Math.floor(rand() * 5);
  for (let i = 0; i < legs; i++) {
    const run = (2 + Math.floor(rand() * 7)) * CELL * (rand() < 0.5 ? -1 : 1);
    if (horizontal) {
      x = Math.min(Math.max(x + run, 0), cols * CELL);
    } else {
      y = Math.min(Math.max(y + run, 0), rows * CELL);
    }
    points.push([x, y]);
    horizontal = !horizontal;
  }
  return points;
}

function toPath(points) {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
}

/** Rough length of a right-angled route: the legs simply add up. */
function routeLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.abs(points[i][0] - points[i - 1][0]) + Math.abs(points[i][1] - points[i - 1][1]);
  }
  return Math.max(total, 1);
}

export default function GridTrace() {
  const [size, setSize] = useState(() => ({
    w: typeof window === 'undefined' ? 1440 : window.innerWidth,
    h: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));

  useEffect(() => {
    // Only on a real resize, and coarsely — the routes do not need to be
    // exact, and rebuilding them on every pixel would be wasteful.
    let timer;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setSize({ w: window.innerWidth, h: window.innerHeight }), 250);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(timer);
    };
  }, []);

  const traces = useMemo(() => {
    const rand = seeded(20260920);
    return Array.from({ length: TRACE_COUNT }, (_, i) => {
      const points = buildRoute(rand, size.w, size.h);
      const length = routeLength(points);
      return {
        id: i,
        d: toPath(points),
        length,
        // Longer routes take proportionally longer, so every trace moves at
        // roughly the same speed rather than racing to finish together.
        duration: Math.round(length / 26) + 6,
        delay: Math.round(rand() * 14),
      };
    });
  }, [size.w, size.h]);

  return (
    <svg
      className="grid-trace"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      aria-hidden="true"
      focusable="false"
    >
      {traces.map((t) => (
        <path
          key={t.id}
          d={t.d}
          fill="none"
          stroke="var(--color-teal)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: `${SEGMENT} ${t.length}`,
            // The keyframe reads this; an inline strokeDashoffset would be
            // overridden the moment the animation starts.
            '--from': `${t.length + SEGMENT}px`,
            strokeDashoffset: `${t.length + SEGMENT}px`,
            animation: `traceRun ${t.duration}s linear ${t.delay}s infinite`,
          }}
        />
      ))}
    </svg>
  );
}
