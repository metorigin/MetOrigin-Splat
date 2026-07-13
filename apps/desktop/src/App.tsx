import { AppProvider, useAppContext } from "./context";
import { HomePage, NewProjectPage, ProjectDetailPage, TrainingPage } from "./pages";
import "./App.css";

function AppRouter() {
  const { state, dispatch } = useAppContext();

  return (
    <div className="app-shell">
      {/* Global error banner */}
      {state.error && (
        <div className="global-error">
          <span>{state.error}</span>
          <button onClick={() => dispatch({ type: "SET_ERROR", error: null })}>
            ✕
          </button>
        </div>
      )}

      {/* Global loading overlay */}
      {state.loading && (
        <div className="loading-overlay">
          <div className="loading-spinner" />
          <p>正在加载…</p>
        </div>
      )}

      {/* Page router */}
      {(() => {
        switch (state.page.type) {
          case "home":
            return <HomePage />;
          case "new-project":
            return <NewProjectPage />;
          case "project-detail":
            return (
              <ProjectDetailPage
                projectId={state.page.projectId}
                projectPath={state.page.projectPath}
              />
            );
          case "training":
            return (
              <TrainingPage
                projectId={state.page.projectId}
                projectPath={state.page.projectPath}
              />
            );
          default:
            return <HomePage />;
        }
      })()}
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppRouter />
    </AppProvider>
  );
}

export default App;
