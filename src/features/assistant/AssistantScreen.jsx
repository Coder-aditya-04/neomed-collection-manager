import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { partiesAgeingQuery } from '../../lib/queries.js';
import { matchIntent, CAPABILITIES, CAPABILITY_GROUPS } from './intents.js';
import { executeIntent } from './execute.js';
import AgeingStrip from '../../components/AgeingStrip.jsx';

const CHIPS = [
  "Give me today's calls on priority",
  'Who has payment pending?',
  'Who did not keep their promise?',
  'What is the overall position?',
  'Which parties cannot I judge?',
  'What changed since the last import?',
];

export default function AssistantScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: parties } = useQuery(partiesAgeingQuery());
  const [thread, setThread] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [thread, busy]);

  const askRef = useRef(null);

  // A question handed over from another screen — "Ask the assistant" on the
  // party drawer. Waits for the party list, since routing a named party needs
  // it, and clears the state so a refresh does not ask again.
  useEffect(() => {
    const handed = location.state?.question;
    if (!handed || !parties) return;
    navigate(location.pathname, { replace: true, state: null });
    askRef.current?.(handed);
  }, [location.state, location.pathname, parties, navigate]);

  async function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    setDraft('');
    setThread((t) => [...t, { role: 'user', text: q }]);
    setBusy(true);

    // Routing is instant and local; only the data fetch takes time.
    const routed = matchIntent(q, parties ?? []);
    const answer = await executeIntent(routed, { parties });
    setThread((t) => [...t, { role: 'assistant', routed, answer }]);
    setBusy(false);
  }

  askRef.current = ask;

  return (
    <div className="animate-screen-in flex h-full min-h-0 flex-col px-[18px] pb-4 pt-4">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {thread.length === 0 ? <Intro onAsk={ask} /> : null}

        <div className="mx-auto grid max-w-[860px] gap-4">
          {thread.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[70%] rounded-[3px] bg-ink px-3 py-2 text-[12.5px] text-onaccent">{m.text}</div>
              </div>
            ) : (
              <Answer key={i} answer={m.answer} routed={m.routed} />
            )
          )}
          {busy ? <div className="text-[12px] text-mute">Working…</div> : null}
          <div ref={endRef} />
        </div>
      </div>

      <div className="mx-auto mt-3 w-full max-w-[860px]">
        <div className="mb-2 flex flex-wrap gap-2">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => ask(c)}
              className="rounded-[2px] border border-hair bg-surface px-[10px] py-[4px] text-[11.5px] text-body transition-colors hover:border-teal hover:bg-teal/[0.06]"
            >
              {c}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(draft);
          }}
          className="flex gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about any party, bucket or bill in the current snapshot…"
            className="flex-1 rounded-[2px] border border-hair bg-surface px-[11px] py-[8px] text-[13px]"
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>
            Ask
          </button>
        </form>
        <p className="mt-2 text-[10.5px] text-faint text-pretty">
          No language model. Questions are matched to a fixed set of intents and every figure is
          computed by the database — so the same question always returns the same answer, and a
          number can never be invented.
        </p>
      </div>
    </div>
  );
}

function Intro({ onAsk }) {
  return (
    <div className="mx-auto max-w-[860px] pb-4">
      <div className="panel p-[18px]">
        <h2 className="text-[16px] font-semibold tracking-[-0.015em]">What I can answer</h2>
        <p className="mt-1 text-[12.5px] text-mute text-pretty">
          Everything below is read from the current snapshot. Where a question needs a credit term
          that is not recorded, I will say so rather than estimate one.
        </p>
        <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-5 gap-y-4">
          {CAPABILITY_GROUPS.map((g) => (
            <div key={g.group}>
              <div className="mb-[6px] text-[9.5px] font-semibold uppercase tracking-[0.11em] text-faint">
                {g.group}
              </div>
              <div className="grid gap-[3px]">
                {g.items.map((c) => (
                  <button
                    key={c.intent}
                    type="button"
                    onClick={() => onAsk(c.example)}
                    className="truncate rounded-[3px] border border-transparent px-[7px] py-[4px] text-left text-[12px] text-teal-deep transition-colors hover:border-teal/30 hover:bg-teal/[0.07]"
                  >
                    {c.example}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Answer({ answer, routed }) {
  if (!answer) return null;

  if (answer.kind === 'help') {
    return (
      <Card intent={routed?.intent}>
        <p className="text-[12.5px]">Ask me any of these:</p>
        <ul className="mt-2 grid gap-1">
          {CAPABILITIES.map((c) => (
            <li key={c.intent} className="text-[12px] text-mute">
              {c.example}
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  if (answer.kind === 'unmatched' || answer.kind === 'error') {
    return (
      <Card intent={routed?.intent} tone="muted">
        <p className="text-[12.5px] text-pretty">{answer.text}</p>
      </Card>
    );
  }

  if (answer.kind === 'blocked') {
    // THE STOP RULE, rendered. It says what it cannot answer, why, and what
    // would make it answerable — and never fills the gap with bill age.
    return (
      <Card intent={routed?.intent} tone="blocked">
        <p className="text-[12.5px] font-medium text-pretty">{answer.text}</p>
        {answer.detail ? <p className="mt-2 text-[12px] text-mute text-pretty">{answer.detail}</p> : null}
        {answer.kv ? <Kv rows={answer.kv} /> : null}
        {answer.list ? <List items={answer.list} /> : null}
        {answer.action ? (
          <Link to={answer.action.to} className="btn btn-primary mt-3 inline-block no-underline">
            {answer.action.label}
          </Link>
        ) : null}
      </Card>
    );
  }

  return (
    <Card intent={routed?.intent} source={answer.source}>
      <p className="text-[12.5px] text-pretty">{answer.text}</p>
      {answer.strip ? (
        <div className="mt-3">
          <AgeingStrip buckets={answer.strip} height={18} />
        </div>
      ) : null}
      {answer.kv ? <Kv rows={answer.kv} /> : null}
      {answer.list ? <List items={answer.list} /> : null}
      {answer.action ? (
        <Link to={answer.action.to} className="btn btn-secondary mt-3 inline-block no-underline">
          {answer.action.label}
        </Link>
      ) : null}
    </Card>
  );
}

function Card({ children, intent, source, tone }) {
  const border =
    tone === 'blocked'
      ? 'border-l-[3px] border-l-[#C9A93E]'
      : tone === 'muted'
        ? 'border-l-[3px] border-l-[#C4D0D9]'
        : 'border-l-[3px] border-l-teal';
  return (
    <div className={`panel ${border} p-[14px]`}>
      {children}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hair pt-2 font-mono text-[9px] uppercase tracking-[0.08em] text-faint">
        <span>{intent}</span>
        {source ? <span>· {source}</span> : null}
      </div>
    </div>
  );
}

function Kv({ rows }) {
  return (
    <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-px bg-hair">
      {rows.map((r) => (
        <div key={r.k} className="bg-surface/80 px-3 py-2">
          <div className="kicker">{r.k}</div>
          <div className="tnum mt-[2px] text-[15px] font-medium">{r.v}</div>
        </div>
      ))}
    </div>
  );
}

function List({ items }) {
  if (!items?.length) return null;
  return (
    <div className="mt-3 border border-hair bg-surface">
      {items.map((it, i) => (
        <div
          key={`${it.name}-${i}`}
          className="grid items-start gap-3 border-b border-rule px-3 py-2 last:border-b-0"
          style={{ gridTemplateColumns: 'minmax(0,1fr) 110px' }}
        >
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium">{it.name}</div>
            {it.meta ? <div className="mt-[2px] text-[11px] text-mute text-pretty">{it.meta}</div> : null}
            {it.buckets ? (
              <div className="mt-[6px] w-[140px]">
                <AgeingStrip buckets={it.buckets} height={6} />
              </div>
            ) : null}
          </div>
          <div className="tnum text-right text-[13px] font-medium">{it.amount}</div>
        </div>
      ))}
    </div>
  );
}
