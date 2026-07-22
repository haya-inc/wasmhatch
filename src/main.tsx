import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { App } from "./App";
import { i18n, initI18n } from "./lib/i18n";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
// Wait for the (tiny, code-split) catalog so the first paint is already in
// the user's language; initI18n falls back to English and never rejects.
void initI18n().then(() => {
  root.render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <App />
      </I18nProvider>
    </StrictMode>
  );
});
