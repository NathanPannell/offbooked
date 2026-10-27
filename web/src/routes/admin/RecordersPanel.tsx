import { Link } from "react-router";
import { admin } from "../../api/admin";
import { useResource } from "../../lib/useResource";
import { Figures, Loaded, PersonLink, Table, When } from "./shared";
import { sum } from "./totals";

/** Everyone who has recorded a line, one row per person (grouped by verified email across shows). */
export default function RecordersPanel() {
  const list = useResource(() => admin.recorders().then((r) => r.recorders), "admin-recorders");
  return (
    <Loaded resource={list}>
      {(rows) => (
        <>
          <Figures
            items={[
              { label: "People recording", value: rows.length },
              { label: "Cast members", value: rows.filter((r) => r.kind === "cast").length },
              { label: "Lines recorded", value: sum(rows, (r) => r.linesRecorded) },
              { label: "Takes", value: sum(rows, (r) => r.takes) },
            ]}
          />
          {rows.length === 0 ? (
            <p className="muted">Nobody has recorded a line yet.</p>
          ) : (
            <Table label="Recorders" head={["Person", "Email", "Productions", "Lines recorded", "Takes", "First recording", "Last recording", "Last seen"]}>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <PersonLink personKey={r.key} label={r.name} />
                    {r.kind === "director" && <span className="admin-tag">Director</span>}
                  </td>
                  <td>{r.email ?? <span className="muted">None verified</span>}</td>
                  <td>
                    <ul className="admin-inline-list">
                      {r.productions.map((p) => (
                        <li key={p.id}>
                          <Link to={`/app/p/${p.id}`}>{p.title || "(untitled)"}</Link>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="num">{r.linesRecorded.toLocaleString("en-US")}</td>
                  <td className="num">{r.takes.toLocaleString("en-US")}</td>
                  <td>
                    <When iso={r.firstRecordingAt} />
                  </td>
                  <td>
                    <When iso={r.lastRecordingAt} relative />
                  </td>
                  <td>
                    <When iso={r.lastSeenAt} relative />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Loaded>
  );
}
