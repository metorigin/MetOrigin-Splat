import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    // Use jsdom Storage; Node 26's server Web Storage is unrelated to the UI.
    // Vitest 2 filters runner flags, so forks must receive this explicitly.
    poolOptions: { forks: { execArgv: ["--no-experimental-webstorage"] } },
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
