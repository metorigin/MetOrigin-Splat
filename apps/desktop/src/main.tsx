import React from "react";
import ReactDOM from "react-dom/client";
const Page = React.lazy(() => import("./App"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <React.Suspense fallback={<div>正在启动…</div>}><Page /></React.Suspense>
  </React.StrictMode>,
);
