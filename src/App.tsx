import { lazy, Suspense } from "react";
import { LandingPage } from "./pages/LandingPage";

const WorkspacePage = lazy(() =>
  import("./pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage }))
);

export function App() {
  const basePath = new URL(import.meta.env.BASE_URL, window.location.origin).pathname;
  const route = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length)
    : window.location.pathname.slice(1);
  if (!route.startsWith("workspace")) return <LandingPage />;

  return (
    <Suspense fallback={<div className="route-loading">Hatching workspace…</div>}>
      <WorkspacePage />
    </Suspense>
  );
}
