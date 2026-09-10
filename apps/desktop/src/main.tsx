import { t, syncDocumentLanguage } from "./i18n";
import React from "react";
import ReactDOM from "react-dom/client";
syncDocumentLanguage();
const Page = React.lazy(() => import("./App"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <React.Suspense fallback={<div>{t("正在启动…")}</div>}><Page /></React.Suspense>
  </React.StrictMode>,
);
