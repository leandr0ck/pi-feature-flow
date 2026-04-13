import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { TicketRegistry } from "../types.js";
import { generateTicketViewerHTML } from "./ticket-viewer-html.js";

export type TicketViewerAction =
  | { action: "execute"; ticketId: string }
  | { action: "view"; ticketId: string }
  | { action: "refresh" }
  | { action: "cancel" };

export type TicketViewerResult =
  | { action: "execute"; ticketId: string }
  | { action: "view"; ticketId: string }
  | { action: "refresh" }
  | { action: "cancel" };

let currentServer: Server | undefined;
let currentResolve: ((result: TicketViewerResult) => void) | undefined;
let currentPort = 0;

function getAvailablePort(startPort: number = 3938): Promise<number> {
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

export async function openTicketViewer(opts: {
  feature: string;
  registry: TicketRegistry;
}): Promise<TicketViewerResult> {
  currentPort = await getAvailablePort();

  return new Promise((resolve, reject) => {
    currentResolve = resolve;
    const server = createServer();
    currentServer = server;

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || "/";

      if (url === "/" || url === "/index.html") {
        const html = generateTicketViewerHTML({
          feature: opts.feature,
          registry: opts.registry,
          port: currentPort,
        });

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(html);
        return;
      }

      if (url === "/registry" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ registry: opts.registry }));
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
            const result: TicketViewerResult = {
              action: data.action,
              ticketId: data.ticketId,
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));

            setTimeout(() => {
              if (currentResolve) {
                currentResolve(result);
                currentResolve = undefined;
              }
              closeServer(server);
              currentServer = undefined;
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

    server.listen(currentPort, () => {
      const url = `http://localhost:${currentPort}`;
      openBrowser(url);
    });

    setTimeout(() => {
      if (currentServer === server) {
        reject(new Error("Ticket viewer timeout"));
        closeServer(server);
        currentServer = undefined;
        currentResolve = undefined;
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
    console.log(`[ticket-viewer] Open: ${url}`);
  }
}

export function cancelTicketViewer() {
  if (currentResolve) {
    currentResolve({ action: "cancel" });
    currentResolve = undefined;
  }
  if (currentServer) {
    closeServer(currentServer);
    currentServer = undefined;
  }
}
