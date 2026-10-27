import type { ReactNode } from "react";
import { Link } from "react-router";
import { personPath, type PersonKey } from "../../api/admin";
import { errorMessage } from "../../api/client";
import { Loading } from "../../components/Loading";
import { formatDate, relativeTime } from "../../lib/format";
import type { Resource } from "../../lib/useResource";

// Small pieces every admin panel uses.

/** A resource's loading and error states, else its content. */
export function Loaded<T>({ resource, children }: { resource: Resource<T>; children: (data: T) => ReactNode }) {
  if (resource.loading) return <Loading />;
  if (resource.error || resource.data === undefined) {
    return (
      <div className="notice notice-error" role="alert">
        {errorMessage(resource.error)}{" "}
        <button type="button" className="link-btn" onClick={() => void resource.reload()}>
          Try again
        </button>
      </div>
    );
  }
  return <>{children(resource.data)}</>;
}

/** A date with the exact time on hover; `relative` reads "3 days ago". */
export function When({ iso, relative = false }: { iso: string | null; relative?: boolean }) {
  if (!iso) return <span className="muted">Never</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {relative ? relativeTime(iso) : formatDate(iso)}
    </time>
  );
}

/** A person, linked to their trace. */
export function PersonLink({ personKey, label }: { personKey: PersonKey; label: string | null }) {
  return <Link to={personPath(personKey)}>{label || "(no name)"}</Link>;
}

/** The headline figures above a table. */
export function Figures({ items }: { items: { label: string; value: number }[] }) {
  return (
    <dl className="admin-figures">
      {items.map((f) => (
        <div key={f.label} className="admin-figure">
          <dt>{f.label}</dt>
          <dd>{f.value.toLocaleString("en-US")}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A table that scrolls sideways inside its card on a phone, never the page. */
export function Table({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div className="admin-table-wrap raised">
      <table className="admin-table" aria-label={label}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
