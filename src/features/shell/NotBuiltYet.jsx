/**
 * A placeholder for routes later build steps fill in. It names the step
 * rather than pretending the screen is merely empty, so the state of the
 * build is legible from inside the app.
 */
export default function NotBuiltYet({ title, step, what }) {
  return (
    <div className="animate-screen-in px-[18px] pb-[34px] pt-4">
      <div className="panel max-w-[70ch] p-[18px]">
        <div className="kicker">Build step {step}</div>
        <h2 className="mt-1 text-[17px] font-semibold tracking-[-0.015em]">{title}</h2>
        <p className="mt-2 text-[12.5px] text-mute text-pretty">{what}</p>
        <p className="mt-3 text-[12px] text-faint text-pretty">
          Steps 1–3 are done: schema and policies, the Marg parser and import screen, and the
          ageing and priority SQL. This screen arrives in step {step}.
        </p>
      </div>
    </div>
  );
}
