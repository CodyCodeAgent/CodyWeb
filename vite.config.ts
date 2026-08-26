import { defineConfig } from "vitest/config";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import {
  attachCodexBridgeWebSocketServer,
  createCodexBridgeMiddleware,
} from "./src/server/codexAppServerBridge";
import tailwindcss from "@tailwindcss/vite";
import { readBuildMetadata } from "./scripts/build-metadata.mjs";

const buildVersion = process.env.npm_package_version ?? "0.0.0";
const buildMetadata = readBuildMetadata(fileURLToPath(new URL(".", import.meta.url)));
const buildTime = new Date().toISOString();

export default defineConfig({
  test: {
    setupFiles: ["./src/test/setup.ts"],
  },
  define: {
    __CODY_VERSION__: JSON.stringify(buildVersion),
    __CODY_GIT_SHA__: JSON.stringify(buildMetadata.gitSha),
    __CODY_GIT_DIRTY__: JSON.stringify(buildMetadata.dirty),
    __CODY_SOURCE_FINGERPRINT__: JSON.stringify(buildMetadata.sourceFingerprint),
    __CODY_BUILD_ID__: JSON.stringify(buildMetadata.buildId),
    __CODY_BUILD_TIME__: JSON.stringify(buildTime),
  },
  server: {
    port: 5173,
  },
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: "codex-bridge",
      configureServer(server) {
        const bridge = createCodexBridgeMiddleware();
        const httpServer = server.httpServer as HttpServer | undefined;
        const disposeWebSocketServer = httpServer
          ? attachCodexBridgeWebSocketServer(httpServer)
          : () => {};
        server.middlewares.use(bridge);
        server.httpServer?.once("close", () => {
          disposeWebSocketServer();
          bridge.dispose();
        });
      },
    },
  ],
});
