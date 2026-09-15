import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth.js";

const CDP = process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222";
type Pending = { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
let socket: WebSocket | undefined;
let connecting: Promise<WebSocket> | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function failPending(error: Error): void {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(error);
  }
  pending.clear();
}

async function pageTarget(): Promise<{ url: string; title: string; webSocketDebuggerUrl: string }> {
  const response = await fetch(CDP + "/json/list", { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error("Chrome returned HTTP " + response.status);
  const targets = (await response.json()) as Array<{ type?: string; url?: string; title?: string; webSocketDebuggerUrl?: string }>;
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error("Chrome has no open page");
  return { url: page.url || "about:blank", title: page.title || "Browser", webSocketDebuggerUrl: page.webSocketDebuggerUrl };
}

async function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return socket;
  if (connecting) return connecting;
  connecting = (async () => {
    const target = await pageTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome connection timed out")), 5000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to Chrome")); }, { once: true });
    });
    socket = ws;
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(typeof event.data === "string" ? event.data : "") as { id?: number; result?: Record<string, any>; error?: { message?: string } };
        if (!message.id) return;
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message || "Chrome command failed"));
        else item.resolve(message.result || {});
      } catch {}
    });
    const closed = () => {
      if (socket === ws) socket = undefined;
      failPending(new Error("Chrome connection closed"));
    };
    ws.addEventListener("close", closed, { once: true });
    ws.addEventListener("error", closed, { once: true });
    return ws;
  })().finally(() => { connecting = undefined; });
  return connecting;
}

async function command(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const ws = await connect();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + " timed out"));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Elara browser</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}html,body{height:100%;margin:0;background:#11141a;color:#d8dee9;font:13px system-ui,sans-serif;overflow:hidden}
body{display:flex;flex-direction:column}.bar{display:flex;gap:7px;align-items:center;padding:8px;background:#1a1e26;border-bottom:1px solid #303642}
button,input{height:30px;border:1px solid #394150;border-radius:7px;background:#242a34;color:#e5e9f0}button{min-width:34px;cursor:pointer}button:hover{background:#303846}input{flex:1;padding:0 10px;outline:none}input:focus{border-color:#5e81ac}
#screen{position:relative;flex:1;min-height:0;display:grid;place-items:center;outline:none;background:#0b0d11}#screen:focus{box-shadow:inset 0 0 0 2px #5e81ac}img{width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none}.status{position:absolute;left:10px;bottom:10px;padding:5px 8px;border-radius:7px;background:#111d;color:#d8dee9;pointer-events:none}.status:empty{display:none}
</style></head><body>
<form class="bar" id="nav"><button type="button" id="back" title="Back">&larr;</button><button type="button" id="reload" title="Reload">&#8635;</button><input id="address" aria-label="Browser address"><button type="submit">Go</button></form>
<main id="screen" tabindex="0" aria-label="Interactive browser view"><img id="frame" alt="Live browser"><span class="status" id="status">Connecting...</span></main>
<script>
const frame=document.getElementById('frame'),screen=document.getElementById('screen'),status=document.getElementById('status'),address=document.getElementById('address');let drawing=false,lastUrl='';
async function api(path,options){const response=await fetch('/browser-ui/'+path,options);if(!response.ok)throw new Error(await response.text());return response}
async function refresh(){if(drawing)return;drawing=true;try{const response=await api('frame?at='+Date.now());const blob=await response.blob(),previous=frame.src;frame.src=URL.createObjectURL(blob);frame.onload=()=>{if(previous.startsWith('blob:'))URL.revokeObjectURL(previous)};status.textContent=''}catch{status.textContent='Browser reconnecting...'}finally{drawing=false}}
async function state(){try{const value=await(await api('state')).json();if(document.activeElement!==address&&value.url!==lastUrl){address.value=value.url;lastUrl=value.url}document.title=(value.title||'Browser')+' - Elara'}catch{}}
function point(event){const box=frame.getBoundingClientRect(),scale=Math.min(box.width/frame.naturalWidth,box.height/frame.naturalHeight),width=frame.naturalWidth*scale,height=frame.naturalHeight*scale,left=box.left+(box.width-width)/2,top=box.top+(box.height-height)/2;return{x:Math.max(0,Math.min(frame.naturalWidth,(event.clientX-left)/scale)),y:Math.max(0,Math.min(frame.naturalHeight,(event.clientY-top)/scale))}}
async function send(body){try{await api('input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});setTimeout(refresh,80)}catch(error){status.textContent=String(error)}}
screen.addEventListener('click',event=>{if(!frame.naturalWidth)return;screen.focus();send({type:'click',...point(event)})});
screen.addEventListener('wheel',event=>{event.preventDefault();if(!frame.naturalWidth)return;send({type:'wheel',...point(event),deltaX:event.deltaX,deltaY:event.deltaY})},{passive:false});
screen.addEventListener('keydown',event=>{if(event.metaKey||event.ctrlKey||event.altKey)return;event.preventDefault();if(event.key.length===1)send({type:'text',text:event.key});else send({type:'key',key:event.key})});
document.getElementById('nav').addEventListener('submit',async event=>{event.preventDefault();await api('navigate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:address.value})});setTimeout(()=>{refresh();state()},250)});
document.getElementById('back').onclick=()=>send({type:'key',key:'BrowserBack'});
document.getElementById('reload').onclick=async()=>{await api('reload',{method:'POST'});setTimeout(refresh,250)};
setInterval(refresh,350);setInterval(state,1000);refresh();state();
</script></body></html>`;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function historyEntry(offset: number): Promise<{ entryId: number }> {
  const history = await command("Page.getNavigationHistory");
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const entry = entries[Number(history.currentIndex) + offset];
  if (!entry || !Number.isInteger(entry.id)) throw new Error("No previous page");
  return { entryId: entry.id };
}

export function mountNativeBrowserUi(app: Express, prefix: string): void {
  app.get([prefix, prefix + "/"], (_req, res) => res.type("html").send(PAGE));
  app.get(prefix + "/state", requireAuth, async (_req, res) => {
    try {
      const target = await pageTarget();
      res.json({ url: target.url, title: target.title });
    } catch (error) {
      res.status(502).send(errorMessage(error));
    }
  });
  app.get(prefix + "/frame", requireAuth, async (_req, res) => {
    try {
      const result = await command("Page.captureScreenshot", { format: "jpeg", quality: 78, fromSurface: true, captureBeyondViewport: false });
      if (typeof result.data !== "string") throw new Error("Chrome returned no image");
      res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.send(Buffer.from(result.data, "base64"));
    } catch (error) {
      socket?.close();
      socket = undefined;
      res.status(502).send(errorMessage(error));
    }
  });
  app.post(prefix + "/navigate", requireAuth, async (req: Request, res: Response) => {
    try {
      let url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
      if (!/^https?:\/\//i.test(url) && url !== "about:blank") throw new Error("Enter an HTTP or HTTPS address");
      await command("Page.navigate", { url });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post(prefix + "/reload", requireAuth, async (_req, res) => {
    try {
      await command("Page.reload");
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });
  app.post(prefix + "/input", requireAuth, async (req: Request, res: Response) => {
    try {
      const value = req.body || {};
      if (value.type === "click") {
        const x = Number(value.x), y = Number(value.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid click position");
        await command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      } else if (value.type === "wheel") {
        await command("Input.dispatchMouseEvent", { type: "mouseWheel", x: Number(value.x) || 0, y: Number(value.y) || 0, deltaX: Number(value.deltaX) || 0, deltaY: Number(value.deltaY) || 0 });
      } else if (value.type === "text" && typeof value.text === "string" && value.text.length <= 20) {
        await command("Input.insertText", { text: value.text });
      } else if (value.type === "key" && typeof value.key === "string") {
        if (value.key === "BrowserBack") {
          await command("Page.navigateToHistoryEntry", await historyEntry(-1));
        } else {
          const allowed = new Set(["Enter", "Tab", "Backspace", "Escape", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
          if (!allowed.has(value.key)) throw new Error("Unsupported key");
          await command("Input.dispatchKeyEvent", { type: "keyDown", key: value.key });
          await command("Input.dispatchKeyEvent", { type: "keyUp", key: value.key });
        }
      } else {
        throw new Error("Unsupported browser input");
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });
}
