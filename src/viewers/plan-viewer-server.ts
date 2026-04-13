import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generatePlanViewerHTML } from "./plan-viewer-html.js";

export type PlanAction = "approve" | "needs_fix" | "cancel";

export type PlanViewerResult =
  | { action: "approve"; markdown: string }
  | { action: "needs_fix"; markdown: string; comment: string }
  | { action: "cancel" };

export type PlanViewerState = {
  feature: string;
  title: string;
  markdown: string;
  resolve: (result: PlanViewerResult) => void;
  server: Server;
  port: number;
};

let currentState: PlanViewerState | undefined;

function getAvailablePort(startPort: number = 3838): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(startPort, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        server.close(() => resolve(address.port));
      } else {
        server.close(() => resolve(startPort));
      }
    });
    server.on("error", () => {
      getAvailablePort(startPort + 1).then(resolve);
    });
  });
}

export async function openPlanViewer(opts: {
  feature: string;
  title: string;
  markdown: string;
}): Promise<PlanViewerResult> {
  const port = await getAvailablePort();

  return new Promise((resolve, reject) => {
    const state: PlanViewerState = {
      feature: opts.feature,
      title: opts.title,
      markdown: opts.markdown,
      resolve,
      server: createServer(),
      port,
    };

    currentState = state;

    state.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || "/";

      if (url === "/" || url === "/index.html") {
        const html = generatePlanViewerHTML({
          feature: opts.feature,
          title: opts.title,
          markdown: opts.markdown,
          port,
        });

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(html);
        return;
      }

      if (url === "/markdown" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ markdown: state.markdown }));
        return;
      }

      if (url === "/action" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            const result: PlanViewerResult =
              data.action === "approve"
                ? { action: "approve", markdown: data.markdown }
                : data.action === "needs_fix"
                  ? { action: "needs_fix", markdown: data.markdown, comment: data.comment || "" }
                  : { action: "cancel" };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));

            setTimeout(() => {
              state.resolve(result);
              closeServer(state.server);
              currentState = undefined;
            }, 100);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid request" }));
          }
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    state.server.listen(port, () => {
      const url = `http://localhost:${port}`;
      openBrowser(url);
    });

    setTimeout(() => {
      if (currentState === state) {
        reject(new Error("Plan viewer timeout"));
        closeServer(state.server);
        currentState = undefined;
      }
    }, 30 * 60 * 1000);
  });
}

function closeServer(server: Server) {
  try {
    server.close();
  } catch {
    // ignore
  }
}

function openBrowser(url: string): void {
  try {
    const { execSync } = require("child_process");
    const platform = process.platform;

    if (platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (platform === "linux") {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore" });
    }
  } catch {
    // Fallback: log URL if browser can't be opened
    console.log(`[plan-viewer] Open: ${url}`);
  }
}

export function cancelPlanViewer() {
  if (currentState) {
    currentState.resolve({ action: "cancel" });
    closeServer(currentState.server);
    currentState = undefined;
  }
}
