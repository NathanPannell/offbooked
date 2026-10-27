import { useParams } from "react-router";
import { NotFound } from "../NotFound";
import { sectionById } from "./sections";

/** /app/admin/:section: the registered panel with its one-line summary. */
export default function AdminSectionPage() {
  const section = sectionById(useParams().section);
  if (!section) return <NotFound />;
  const { Panel } = section;
  return (
    <section className="admin-panel" aria-labelledby="admin-panel-title">
      <div className="admin-panel-head">
        <h2 id="admin-panel-title">{section.label}</h2>
        <p className="muted">{section.summary}</p>
      </div>
      <Panel />
    </section>
  );
}
