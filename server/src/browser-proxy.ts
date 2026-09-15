import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import type { Express } from "express";
import { config } from "./extensions/browser-service.js";
import { viewerConnected, viewerDisconnected } from "./extensions/browser-frames.js";
import { mountNativeBrowserUi } from "./browser-native-ui.js";

/**
 * The agent's browser, served through the portal.
 *
 * Two reasons this is a proxy rather than a link to port 3011:
 *
 * The VNC client refuses to run outside a secure context, and a secure context
 * needs every ancestor to be trustworthy — so an HTTPS iframe inside the portal
 * is only secure if the portal itself is. Same-origin means it inherits
 * whatever the portal has instead of needing its own.
 *
 * And it removes a second credential and a second certificate: the portal has
 * already decided who you are, so it holds the browser's password rather than
 * asking you for it again.
 */

const UPSTREAM_HOST = process.env.BROWSER_HOST || "127.0.0.1";
const upstreamPort = () => Number(config().httpsPort);
const PREFIX = "/browser-ui";
const nativeUi = process.env.BROWSER_NATIVE_UI === "true";

const auth = () => {
  const { user, password } = config();
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
};

/** Self-signed upstream on loopback: verifying it would mean pinning our own cert. */
const agent = new https.Agent({ rejectUnauthorized: false });

const upstreamPath = (url: string) => url.slice(PREFIX.length) || "/";

/**
 * The route half. Registered with the other routes, before the SPA fallback —
 * that fallback answers everything outside /api, so a proxy mounted after it
 * quietly served the portal's own index.html instead.
 */
export function mountBrowserProxy(app: Express): void {
  if (nativeUi) {
    mountNativeBrowserUi(app, PREFIX);
    return;
  }
  app.use(PREFIX, (req, res) => {
    const proxied = https.request(
      {
        host: UPSTREAM_HOST,
        port: upstreamPort(),
        // Express strips the mount path from req.url, so it is already relative.
        path: req.url || "/",
        method: req.method,
        headers: { ...req.headers, host: `${UPSTREAM_HOST}:${upstreamPort()}`, authorization: auth() },
        agent,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      }
    );
    proxied.on("error", (e) => {
      if (!res.headersSent) res.status(502);
      res.end(`The browser is not answering: ${e.message}`);
    });
    req.pipe(proxied);
  });

}

/**
 * The stream half, which needs the server rather than the app. Express never
 * sees an upgrade, so without this the page loads and then sits blank.
 */
export function attachBrowserUpgrade(server: http.Server): void {
  if (nativeUi) return;
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith(PREFIX)) return;
    const proxied = https.request({
      host: UPSTREAM_HOST,
      port: upstreamPort(),
      path: upstreamPath(req.url),
      method: "GET",
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${upstreamPort()}`, authorization: auth() },
      agent,
    });
    proxied.end();

    proxied.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead?.length) socket.unshift(upstreamHead);
      if (head?.length) upstreamSocket.unshift(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      // Somebody is watching now, so the portal's own stream gets out of the
      // way — only one client may hold the display, and the newer one wins.
      viewerConnected();
      let counted = true;
      const close = () => {
        if (counted) {
          counted = false;
          viewerDisconnected();
        }
        upstreamSocket.destroy();
        socket.destroy();
      };
      socket.on("close", close);
      upstreamSocket.on("close", close);
      socket.on("error", close);
      upstreamSocket.on("error", close);
    });
    proxied.on("error", () => socket.destroy());
  });
}
