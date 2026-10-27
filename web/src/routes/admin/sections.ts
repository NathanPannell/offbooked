import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// The admin area's panels, in tab order. A new panel is one file in this folder (a default-exported
// component that loads its own data when it opens: no timers, so the database can sleep) plus one
// entry here. Its API goes in backend/src/routes/admin.ts, which gates every route on the server.

export interface AdminSection {
  /** The URL segment: /app/admin/<id>. */
  id: string;
  label: string;
  /** One line under the title, saying what the panel shows. */
  summary: string;
  Panel: LazyExoticComponent<ComponentType>;
}

export const ADMIN_SECTIONS: AdminSection[] = [
  {
    id: "productions",
    label: "Productions",
    summary: "Every production. Open one to see it as its director does, read only.",
    Panel: lazy(() => import("./ProductionsPanel")),
  },
  {
    id: "creators",
    label: "Creators",
    summary: "Every account that has set up a production, with its headline figures.",
    Panel: lazy(() => import("./CreatorsPanel")),
  },
  {
    id: "recorders",
    label: "Recorders",
    summary: "Everyone who has recorded a line, cast members and directors, one row per person.",
    Panel: lazy(() => import("./RecordersPanel")),
  },
  {
    id: "audit",
    label: "Audit log",
    summary: "Each time an admin opened someone's production or traced a person.",
    Panel: lazy(() => import("./AuditPanel")),
  },
];

export const sectionById = (id: string | undefined) => ADMIN_SECTIONS.find((s) => s.id === id);
