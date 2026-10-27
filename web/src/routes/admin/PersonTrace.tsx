import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router";
import { admin, type TraceEvent } from "../../api/admin";
import { useResource } from "../../lib/useResource";
import { Loaded } from "./shared";

/** Everything stored about what one person did, oldest first, grouped by day. */
export default function PersonTrace() {
  const { key = "" } = useParams();
  const trace = useResource(() => admin.person(key).then((r) => r.person), `admin-person:${key}`);
  return (
    <section className="admin-panel" aria-labelledby="admin-trace-title">
      <Link className="back-link" to="/app/admin/recorders">
        <ArrowLeft size={16} aria-hidden="true" /> Admin
      </Link>
      <Loaded resource={trace}>
        {(p) => (
          <>
            <div className="admin-panel-head">
              <h2 id="admin-trace-title">{p.name || p.emails[0] || "Someone without a name"}</h2>
              <p className="muted">
                {p.emails.length ? p.emails.join(", ") : "No verified email"} · {p.accounts.length ? "Director account" : "Cast member, no account"}
                {p.castRows.length > 0 && ` · in ${p.castRows.length} cast${p.castRows.length === 1 ? "" : "s"}`}
              </p>
            </div>
            {p.events.length === 0 ? <p className="muted">Nothing recorded for this person yet.</p> : <Timeline events={p.events} />}
            <p className="muted admin-note">
              Not stored, so not shown: listening to a listen-through or a take, which parts someone picked and when, who deleted a take, and a director's
              activity between sign-ins.
            </p>
          </>
        )}
      </Loaded>
    </section>
  );
}

function Timeline({ events }: { events: TraceEvent[] }) {
  const days = new Map<string, TraceEvent[]>();
  for (const e of events) {
    const day = new Date(e.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return (
    <ol className="admin-timeline" aria-label="Timeline">
      {[...days].map(([day, list]) => (
        <li key={day}>
          <h3 className="eyebrow">{day}</h3>
          <ul>
            {list.map((e, i) => (
              <li key={`${e.at}-${e.kind}-${i}`} className={`admin-event admin-event-${e.kind}`}>
                <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
                <span>
                  {e.text}
                  {e.production && (
                    <>
                      {" · "}
                      <Link to={`/app/p/${e.production.id}`}>{e.production.title || "(untitled)"}</Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
