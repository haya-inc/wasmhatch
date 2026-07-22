import { lazy, Suspense } from "react";
import { Trans } from "@lingui/react/macro";
import { BusinessLandingPage } from "./pages/BusinessLandingPage";

const WorkspacePage = lazy(() =>
  import("./pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage }))
);
const OperatorPage = lazy(() =>
  import("./pages/OperatorPage").then((module) => ({ default: module.OperatorPage }))
);
const ChatPage = lazy(() =>
  import("./pages/ChatPage").then((module) => ({ default: module.ChatPage }))
);

export function App() {
  const basePath = new URL(import.meta.env.BASE_URL, window.location.origin).pathname;
  const route = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length)
    : window.location.pathname.slice(1);
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (route.startsWith("chat") || requestedView === "chat") {
    return (
      <Suspense fallback={<div className="route-loading"><Trans>Opening WasmHatch…</Trans></div>}>
        <ChatPage />
      </Suspense>
    );
  }
  if (route.startsWith("work") || requestedView === "work") {
    return (
      <Suspense fallback={<div className="route-loading"><Trans>Opening your workspace…</Trans></div>}>
        <OperatorPage simple />
      </Suspense>
    );
  }
  if (route.startsWith("operator") || requestedView === "operator") {
    return (
      <Suspense fallback={<div className="route-loading"><Trans>Opening operator…</Trans></div>}>
        <OperatorPage />
      </Suspense>
    );
  }
  if (!route.startsWith("workspace") && requestedView !== "workspace") return <BusinessLandingPage />;

  return (
    <Suspense fallback={<div className="route-loading"><Trans>Hatching workspace…</Trans></div>}>
      <WorkspacePage />
    </Suspense>
  );
}
