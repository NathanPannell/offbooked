import { admin } from "../../api/admin";
import { useResource } from "../../lib/useResource";
import { Figures, Loaded, PersonLink, Table, When } from "./shared";
import { sum } from "./totals";

/** Headline figures for every account that has created a production. */
export default function CreatorsPanel() {
  const list = useResource(() => admin.creators().then((r) => r.creators), "admin-creators");
  return (
    <Loaded resource={list}>
      {(rows) => (
        <>
          <Figures
            items={[
              { label: "Creators", value: rows.length },
              { label: "Productions", value: sum(rows, (c) => c.productions) },
              { label: "Cast members", value: sum(rows, (c) => c.castMembers) },
              { label: "Lines recorded", value: sum(rows, (c) => c.linesRecorded) },
            ]}
          />
          {rows.length === 0 ? (
            <p className="muted">Nobody has set up a production yet.</p>
          ) : (
            <Table
              label="Creators"
              head={["Email", "Name", "Signed up", "Plan", "Productions", "Cast", "Lines recorded", "Takes", "Last sign-in", "Last activity"]}
            >
              {rows.map((c) => (
                <tr key={c.key}>
                  <td>
                    <PersonLink personKey={c.key} label={c.email ?? "Deleted account"} />
                  </td>
                  <td>{c.name ?? <span className="muted">Not set</span>}</td>
                  <td>
                    <When iso={c.signedUpAt} />
                  </td>
                  <td>
                    {c.plan.name}
                    {!c.plan.betaAccessAt && <span className="admin-tag">No beta access</span>}
                  </td>
                  <td className="num">
                    {c.productions}
                    {c.activeProductions !== c.productions && <span className="muted"> ({c.activeProductions} active)</span>}
                  </td>
                  <td className="num">{c.castMembers.toLocaleString("en-US")}</td>
                  <td className="num">{c.linesRecorded.toLocaleString("en-US")}</td>
                  <td className="num">{c.takes.toLocaleString("en-US")}</td>
                  <td>
                    <When iso={c.lastSignInAt} relative />
                  </td>
                  <td>
                    <When iso={c.lastActivity} relative />
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
