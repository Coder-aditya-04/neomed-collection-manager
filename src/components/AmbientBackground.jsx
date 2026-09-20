/**
 * The light behind the glass.
 *
 * Earlier attempts drew *on* the background — sweeping bands, then a point
 * tracing the grid. Both were wrong for the same reason: they were lines on a
 * diagram, competing with the figures for attention, and they gave the panels
 * nothing to work with. Frosted glass only looks like glass when there is
 * something soft and coloured behind it to blur; over a flat grey field the
 * best blur in the world still reads as grey paint.
 *
 * So this puts colour back there instead. Four wide, heavily blurred pools of
 * brand green drifting very slowly, well under the grid. Nothing has an edge,
 * so nothing reads as a shape you could be asked to look at — but the panels
 * now have light to bend, and the surface comes alive.
 *
 * Movement is transform and nothing else, so the compositor carries all of it
 * on the GPU and no other element repaints.
 */

const ORBS = [
  { top: '-14%', left: '-8%',  size: 620, hue: 'rgba(0, 133, 122, 0.30)',  dur: 34, delay: 0 },
  { top: '38%',  left: '58%',  size: 720, hue: 'rgba(20, 149, 138, 0.26)', dur: 46, delay: -12 },
  { top: '64%',  left: '4%',   size: 540, hue: 'rgba(0, 133, 122, 0.20)',  dur: 40, delay: -24 },
  { top: '-6%',  left: '62%',  size: 480, hue: 'rgba(109, 91, 184, 0.14)', dur: 52, delay: -8 },
];

export default function AmbientBackground() {
  return (
    <div className="ambient" aria-hidden="true">
      {ORBS.map((o, i) => (
        <span
          key={i}
          className="ambient-orb"
          style={{
            top: o.top,
            left: o.left,
            width: o.size,
            height: o.size,
            background: `radial-gradient(circle at 50% 50%, ${o.hue}, transparent 68%)`,
            animationDuration: `${o.dur}s`,
            animationDelay: `${o.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
