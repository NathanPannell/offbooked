import { Suspense } from "react";
import { NavLink, Outlet } from "react-router";
import { Loading } from "../../components/Loading";
import { NotFound } from "../NotFound";
import { useDirector } from "../director/DirectorLayout";
import { ADMIN_SECTIONS } from "./sections";
import "../../styles/admin.css";

/** /app/admin: the tabs from the section registry over the open panel. The server gates every call. */
export default function AdminLayout() {
  const { user } = useDirector();
  if (!user.admin) return <NotFound />;
  return (
    <main className="page admin-page">
      <div className="page-head">
        <h1 className="display">Admin</h1>
      </div>
      <nav className="admin-tabs" aria-label="Admin sections">
        {ADMIN_SECTIONS.map((s) => (
          <NavLink key={s.id} to={`/app/admin/${s.id}`} className="admin-tab">
            {s.label}
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<Loading />}>
        <Outlet />
      </Suspense>
    </main>
  );
}
