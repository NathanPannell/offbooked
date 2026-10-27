import { Link } from "react-router";
import { admin } from "../../api/admin";
import { useResource } from "../../lib/useResource";
import { Loaded, PersonLink, Table, When } from "./shared";

/** The newest admin views: someone's production opened, or a person traced (one row per 10 minutes). */
export default function AuditPanel() {
  const list = useResource(() => admin.audit().then((r) => r.entries), "admin-audit");
  return (
    <Loaded resource={list}>
      {(rows) =>
        rows.length === 0 ? (
          <p className="muted">No admin has opened anyone's production yet.</p>
        ) : (
          <Table label="Audit log" head={["When", "Admin", "Looked at"]}>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>
                  <When iso={e.at} relative />
                </td>
                <td>{e.admin}</td>
                <td>
                  {e.action === "view_production" && e.production ? (
                    <>
                      Production <Link to={`/app/p/${e.production.id}`}>{e.production.title || "(untitled)"}</Link>
                    </>
                  ) : e.subject ? (
                    <>
                      Person <PersonLink personKey={e.subject} label={e.subject.slice(2)} />
                    </>
                  ) : (
                    e.action
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )
      }
    </Loaded>
  );
}
