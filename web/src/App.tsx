import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Route, Routes, StaticRouter } from "react-router";
import { Loading } from "./components/Loading";
import { ToastProvider } from "./components/Toast";
import { NativeLinks } from "./native/NativeLinks";
import { isNativeApp } from "./native/platform";
import { Landing } from "./routes/Landing";
import { NotFound } from "./routes/NotFound";
import { Privacy } from "./routes/Privacy";
import { Terms } from "./routes/Terms";

const SignIn = lazy(() => import("./routes/director/SignIn"));
const Verify = lazy(() => import("./routes/director/Verify"));
const DirectorLayout = lazy(() => import("./routes/director/DirectorLayout"));
const Productions = lazy(() => import("./routes/director/Productions"));
const NewProduction = lazy(() => import("./routes/director/NewProduction"));
const ProductionPage = lazy(() => import("./routes/director/ProductionPage"));
const InvitePage = lazy(() => import("./routes/actor/InvitePage"));
const InvitePlay = lazy(() => import("./routes/actor/InvitePlay"));
const JoinPage = lazy(() => import("./routes/actor/JoinPage"));
const SceneRecorder = lazy(() => import("./routes/director/SceneRecorder"));
const Account = lazy(() => import("./routes/director/Account"));
const NativeHome = lazy(() => import("./native/NativeHome"));

function Router({ location, children }: { location?: string; children: ReactNode }) {
  return location === undefined ? <BrowserRouter>{children}</BrowserRouter> : <StaticRouter location={location}>{children}</StaticRouter>;
}

/**
 * The whole app. `location` renders it at that path without a browser, for the pre-rendered
 * marketing pages (src/prerender.tsx); the browser then hydrates the same tree.
 */
export function App({ location }: { location?: string }) {
  return (
    <ToastProvider>
      <Router location={location}>
        <NativeLinks />
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={isNativeApp() ? <NativeHome /> : <Landing />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/signin" element={<SignIn />} />
            <Route path="/auth/verify" element={<Verify />} />
            <Route path="/app" element={<DirectorLayout />}>
              <Route index element={<Productions />} />
              <Route path="new" element={<NewProduction />} />
              <Route path="p/:id" element={<ProductionPage />} />
              <Route path="p/:id/record" element={<SceneRecorder />} />
              <Route path="account" element={<Account />} />
            </Route>
            <Route path="/join/:token" element={<JoinPage />} />
            <Route path="/i/:token" element={<InvitePage />} />
            <Route path="/i/:token/play" element={<InvitePlay />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </Router>
    </ToastProvider>
  );
}
