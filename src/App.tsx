import { lazy, Suspense } from "react";
import { Trans } from "@lingui/react/macro";
import { BusinessLandingPage } from "./pages/BusinessLandingPage";

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
  return <BusinessLandingPage />;
}
