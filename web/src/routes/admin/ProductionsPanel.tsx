import { Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { admin, type AdminProduction } from "../../api/admin";
import { plural } from "../../lib/format";
import { useResource } from "../../lib/useResource";
import { Figures, Loaded, PersonLink, Table, When } from "./shared";
import { sum } from "./totals";

/** Every production, searchable by title or owner; a title opens it in the app, read only. */
export default function ProductionsPanel() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [draft, setDraft] = useState(q);
  const list = useResource(() => admin.productions(q).then((r) => r.productions), `admin-productions:${q}`);

  const search = (e: FormEvent) => {
    e.preventDefault();
    setParams(draft.trim() ? { q: draft.trim() } : {}, { replace: true });
  };

  return (
    <>
      <form className="admin-search" role="search" onSubmit={search}>
        <input
          type="search"
          aria-label="Search productions"
          placeholder="Title, or the owner's email or name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-secondary btn-sm">
          <Search size={16} aria-hidden="true" /> Search
        </button>
      </form>
      <Loaded resource={list}>
        {(rows) => (
          <>
            <Figures
              items={[
                { label: q ? "Matching productions" : "Productions", value: rows.length },
                { label: "Cast members", value: sum(rows, (p) => p.castMembers) },
                { label: "Lines recorded", value: sum(rows, (p) => p.linesRecorded) },
                { label: "Takes", value: sum(rows, (p) => p.takes) },
              ]}
            />
            {rows.length === 0 ? (
              <p className="muted">{q ? `No production matches "${q}".` : "No productions yet."}</p>
            ) : (
              <Table label="Productions" head={["Production", "Owner", "Lines recorded", "Takes", "Cast", "Created", "Last activity"]}>
                {rows.map((p) => (
                  <ProductionRow key={p.id} production={p} />
                ))}
              </Table>
            )}
          </>
        )}
      </Loaded>
    </>
  );
}

function ProductionRow({ production: p }: { production: AdminProduction }) {
  const state = p.contentDeleted ? "Content deleted" : p.archived ? "Archived" : p.scriptStatus !== "ready" ? `Script ${p.scriptStatus}` : null;
  return (
    <tr>
      <td>
        <Link to={`/app/p/${p.id}`}>{p.title || "(untitled)"}</Link>
        {state && <span className="admin-tag">{state}</span>}
      </td>
      <td>
        <PersonLink personKey={p.owner.key} label={p.owner.email ?? "Deleted account"} />
      </td>
      <td className="num">
        {p.linesRecorded.toLocaleString("en-US")} <span className="muted">of {plural(p.linesTotal, "line")}</span>
      </td>
      <td className="num">{p.takes.toLocaleString("en-US")}</td>
      <td className="num">{p.castMembers.toLocaleString("en-US")}</td>
      <td>
        <When iso={p.createdAt} />
      </td>
      <td>
        <When iso={p.lastActivity} relative />
      </td>
    </tr>
  );
}
