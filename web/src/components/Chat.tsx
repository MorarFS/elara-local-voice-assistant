import { useDocuments, DOCUMENT_ACCEPT } from "../use-documents";
import { ActivityProgress } from './ActivityProgress';
import { useWorkPanels } from "../use-work-panels";
import { CanvasPanel } from "./CanvasPanel";
import { displaySpeechText } from "../voice";
import { latestBrowserActivity, latestTerminalActivity } from "../voice-browser";
import { VoiceControl } from "./VoiceControl";
import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown, type DiagramPlugin } from "streamdown";
import { LuGlobe, LuSquareTerminal, LuSquare, LuFileText, LuArrowUp, LuAudioLines, LuPaperclip, LuMinus, LuX } from "react-icons/lu";
import { api, type PiCommand, type PortalEvent, type Session } from "../api";
import { activity, buildTranscript, type Activity } from "../transcript";
import { HAS_MERMAID, loadMermaidPlugin } from "../mermaid";
import { useResolvedTheme } from "../theme";
import { ComposerBar } from "./ComposerBar";
import { TerminalPanel } from "./TerminalPanel";

/**
 * Context the portal attaches to a message, and what to call it.
 *
 * The agent needs to be told who is speaking and what it said while nobody was
 * talking to it. A person reading the transcript does not — they wrote the
 * message, so seeing their own words buried under three framing blocks is
 * noise. Folded away rather than dropped: it is still what the model saw, and
 * when a reply looks strange this is usually why.
 */
/** Keep in step with what the server attaches — see channels/supervisor.ts. */
const CONTEXT_BLOCKS: { tag: string; label: string }[] = [
  { tag: "attached-documents", label: "Documents" },
  { tag: "speaker", label: "Speaker" },
  { tag: "sent-since-you-last-spoke", label: "Sent while idle" },
  { tag: "answer-from-primary", label: "Answer" },
  { tag: "channel-instructions", label: "Channel instructions" },
  { tag: "routine", label: "Routine" },
];

function splitContext(raw: string): { text: string; blocks: { label: string; body: string }[] } {
  let text = raw;
  const blocks: { label: string; body: string }[] = [];
  for (const { tag, label } of CONTEXT_BLOCKS) {
    // The opening tag may carry attributes, as <routine name="..."> does.
    const re = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g");
    text = text.replace(re, (match) => {
      const body = match
        .replace(new RegExp(`^<${tag}(\\s[^>]*)?>`), "")
        .replace(new RegExp(`</${tag}>$`), "")
        .trim();
      if (body) blocks.push({ label, body });
      return "";
    });
  }
  return { text: text.trim(), blocks };
}

function ContextChip({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full px-2 py-0.5 text-[11px] transition ${
          open
            ? "bg-accent/20 text-accent"
            : "bg-fg/5 text-fg-faint hover:bg-fg/10 hover:text-fg-muted"
        }`}
        title="Context the portal attached to this message"
      >
        {label}
      </button>
      {open && (
        <pre className="mt-1 w-full whitespace-pre-wrap rounded-lg bg-fg/5 p-2 text-left text-[11px] leading-relaxed text-fg-muted">
          {body}
        </pre>
      )}
    </>
  );
}

export function Chat({
  session,
  events,
  onSend,
  onAbort,
  onClientCommand,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
}: {
  session: Session;
  events: PortalEvent[];
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  onSend: (message: string, options?: { voice?: boolean }) => Promise<void>;
  onAbort: () => Promise<void>;
  /** Builtins the portal itself services — /settings, /new, /name. */
  onClientCommand: (name: string, args: string) => void | Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [voiceMode, setVoiceMode] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const workspaceElement = useRef<HTMLDivElement>(null);
  const [compactChat, setCompactChat] = useState(false);
  useEffect(() => {
    const element = workspaceElement.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setCompactChat(entry.contentRect.width <= 760));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const documents = useDocuments(session.id, onSend);
  const fileInput = useRef<HTMLInputElement>(null);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [voiceHost, setVoiceHost] = useState<HTMLDivElement | null>(null);
  const [sending, setSending] = useState(false);
  const [panelRequest, setPanelRequest] = useState<"model" | "effort" | null>(null);
  // Whether there is a browser to watch, and whether you are watching it. Asked
  // once — the answer only changes when somebody installs or removes one.
  const [browserUp, setBrowserUp] = useState(false);
  const [watching, setWatching] = useState(false);
  const [terminal, setTerminal] = useState(false);
  useWorkPanels(!voiceMode && watching, !voiceMode && terminal, canvasOpen, panel => { if(panel === "browser") setWatching(false); else if(panel === "terminal") setTerminal(false); else setCanvasOpen(false); });
  const browserPane = useRef<HTMLDivElement>(null);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  useEffect(() => {
    const update = () => setBrowserFullscreen(!!browserPane.current && document.fullscreenElement === browserPane.current);
    document.addEventListener("fullscreenchange", update);
    update();
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggleBrowserFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (browserPane.current?.requestFullscreen) await browserPane.current.requestFullscreen();
      else documents.setError("Fullscreen is unavailable.");
    } catch {
      documents.setError("Could not change fullscreen. Press Escape to return.");
    }
  };
  const collapseBrowser = async () => {
    try {
      if (document.fullscreenElement === browserPane.current) await document.exitFullscreen();
      setWatching(false);
    } catch {
      documents.setError("Could not leave fullscreen. Press Escape to return.");
    }
  };

  // Kept across reloads: a width you dragged is a preference, and losing it on
  // every refresh makes the handle feel decorative.
  const [asideWidth, setAsideWidth] = useState(() =>
    Number(localStorage.getItem("panelWidth")) || 560
  );
  const [split, setSplit] = useState(() => Number(localStorage.getItem("panelSplit")) || 0.55);
  useEffect(() => localStorage.setItem("panelWidth", String(asideWidth)), [asideWidth]);
  useEffect(() => localStorage.setItem("panelSplit", String(split)), [split]);

  /**
   * Dragging, on pointer events rather than mouse ones.
   *
   * Capture keeps the drag alive when the pointer crosses the iframe — without
   * it the frame swallows the move events and the panel stops following
   * halfway across.
   */
  const dragWidth = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = asideWidth;
    const move = (ev: PointerEvent) => {
      const next = startWidth - (ev.clientX - startX);
      setAsideWidth(Math.min(Math.max(next, 320), window.innerWidth * 0.75));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dragSplit = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const ratio = (ev.clientY - box.top) / box.height;
      setSplit(Math.min(Math.max(ratio, 0.15), 0.85));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const bottomRef = useRef<HTMLDivElement>(null);
  const settled = useRef(false);
  const items = useMemo(() => buildTranscript(events), [events]);


  // Diagrams: the plugin is only fetched once a reply actually contains a
  // mermaid fence, and mermaid bakes its palette into the SVG, so it is handed
  // the theme rather than left to guess at dark text on a dark background.
  const wantsMermaid = useMemo(
    () => items.some((item) => item.kind === "assistant" && HAS_MERMAID.test(item.text ?? "")),
    [items],
  );
  const [mermaid, setMermaid] = useState<DiagramPlugin | null>(null);
  const theme = useResolvedTheme();
  const mermaidOptions = useMemo(
    () => ({ config: { theme: theme === "light" ? ("default" as const) : ("dark" as const) } }),
    [theme],
  );

  useEffect(() => {
    if (!wantsMermaid || mermaid) return;
    let live = true;
    loadMermaidPlugin().then(
      (plugin) => live && setMermaid(plugin),
      // A failed chunk fetch leaves the fence as a code block, which is still
      // readable — better than an error where the answer should be.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wantsMermaid, mermaid]);
  const running = session.status === "running";

  // What it is doing, and for how long. The clock ticks only while something is
  // running, so an idle session re-renders no more than it used to.
  const phase = useMemo(() => (running ? activity(events) : null), [running, events]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Commands come from pi at runtime, so anything a newly installed package
  // registers shows up here without the portal knowing about it in advance.
  const [commands, setCommands] = useState<PiCommand[]>([]);
  useEffect(() => {
    api
      .commands(session.id)
      .then((r) => setCommands(r.commands))
      .catch(() => setCommands([]));
    // Refetch when a run ends: installing an extension mid-session should make
    // its commands show up without a reload.
  }, [session.id, running]);

  // Show the palette while the composer holds a bare "/name" prefix.
  const slashQuery = /^\/([\w:-]*)$/.exec(input.trimStart());
  const matches = slashQuery
    ? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery[1].toLowerCase())).slice(0, 8)
    : [];

  useEffect(() => {
    // Only offered where it would work: an iframe needs a secure context, and
    // over plain HTTP the client inside it refuses to start.
    settled.current = false;
    if (!window.isSecureContext) return;
    api
      .browser()
      .then((b) => setBrowserUp(b.install.container === "running"))
      .catch(() => setBrowserUp(false));
  }, []);

  useEffect(() => {
    // Jump on the first paint, glide afterwards. Smooth-scrolling through a
    // whole replayed conversation is the thing that looked broken on refresh.
    bottomRef.current?.scrollIntoView({ behavior: settled.current ? "smooth" : "auto" });
    settled.current = true;
  }, [items.length, events.length, chatOpen, voiceMode]);

  const send = async () => {
    const msg = input.trim() || (documents.attachments.length ? "Please read the attached documents." : "");
    if (!msg || sending || documents.uploading) return;

    // Some builtins are UI, not prompts: /model opens the picker the pill uses,
    // /settings opens the modal. Sending them to pi would just be a chat line.
    const parsed = /^\/([\w-]+)\s*(.*)$/.exec(msg);
    const client = parsed
      ? commands.find((c) => c.name === parsed[1] && c.where === "client")
      : undefined;
    if (client && parsed) {
      setInput("");
      if (client.name === "model") setPanelRequest("model");
      else await onClientCommand(client.name, parsed[2]);
      return;
    }

    setSending(true);
    setInput("");
    try {
      documents.setError("");
      await documents.send(msg, voiceMode ? { voice: true } : undefined);
    } catch (error) {
      setInput(value => value || msg);
      documents.setError(error instanceof Error ? error.message : "Could not send your message.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div ref={workspaceElement} className={`session-workspace relative flex h-full min-h-0 flex-col${voiceMode ? " is-voice" : ""}${voiceMode && chatOpen ? " is-voice-chat" : ""}${compactChat ? " is-compact" : ""}`}>

      <div className={voiceMode ? "voice-area relative flex min-h-0 min-w-0 flex-1 flex-col" : "contents"}>
        <CanvasPanel showToggle={false} key={session.id} sessionId={session.id} open={canvasOpen} setOpen={setCanvasOpen}/>
        <div ref={setVoiceHost} className={voiceMode ? "voice-host flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} />
      </div>
      <header className={voiceMode ? "hidden" : "border-b border-line px-4 py-3"}>
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-fg">{session.title}</h2>
          <p className="truncate font-mono text-[11px] text-fg-faint">{session.workspace}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {session.status === "interrupted" && (
            <span className="rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
              interrupted — send a message to resume
            </span>
          )}
          {browserUp && (
            <button
              onClick={() => setWatching((v) => !v)}
              title={
                watching ? "Hide the browser" : "Watch the browser the agent is driving"
              }
              className={`rounded-lg border px-2 py-1 text-xs transition ${
                watching
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-line text-fg-muted hover:bg-fg/5 hover:text-fg"
              }`}
            >
              <LuGlobe className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setTerminal((v) => !v)}
            title={terminal ? "Hide the terminal" : "Open a shell in this workspace"}
            className={`rounded-lg border px-2 py-1 text-xs transition ${
              terminal
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-line text-fg-muted hover:bg-fg/5 hover:text-fg"
            }`}
          >
            <LuSquareTerminal className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setCanvasOpen(v => !v)} aria-label="Session canvases" title="Session canvases" aria-expanded={canvasOpen}
            className={`rounded-lg border px-2 py-1 text-xs transition ${canvasOpen ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-fg-muted hover:bg-fg/5 hover:text-fg'}`}>
            <LuFileText className="h-3.5 w-3.5" />
          </button>
        </div>
        </div>
      </header>

      <div id="elara-chat" className={voiceMode ? (chatOpen ? "voice-chat-panel flex min-h-0" : "hidden") : "flex min-h-0 flex-1"}
        onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); documents.attach(e.dataTransfer.files); } }}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {voiceMode && <div className="voice-chat-heading">
        <div><strong>Conversation</strong><span>Talk, type, or add a document</span></div>
        <button type="button" aria-label="Minimize chat" title="Minimize chat" onClick={() => setChatOpen(false)}><LuMinus /></button>
      </div>}
      <div className="chat-transcript min-h-0 flex-1 overflow-y-auto px-4 py-6" aria-label="Conversation transcript">
        <div className="mx-auto w-full max-w-3xl space-y-3">
        {hasEarlier && (
          <div className="flex justify-center pb-2">
            <button
              onClick={onLoadEarlier}
              disabled={loadingEarlier}
              className="rounded-lg border border-line px-3 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg disabled:opacity-50"
            >
              {loadingEarlier ? "Loading…" : "Load earlier messages"}
            </button>
          </div>
        )}

        {items.length === 0 && (
          <div className="pt-16 text-center">
            <p className="text-sm text-fg-muted">Talk or type to Elara.</p>
            <p className="mt-1 text-xs text-fg-faint">Attach a document to discuss it together.</p>
          </div>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            const { text, blocks } = splitContext(item.text);
            // Nothing but framing: the portal spoke, not a person. Drawing it as
            // a message bubble with no message in it reads as something broken.
            if (!text) {
              return (
                <div key={item.id} className="flex flex-wrap justify-end gap-1">
                  {blocks.map((b, i) => (
                    <ContextChip key={i} label={b.label} body={b.body} />
                  ))}
                </div>
              );
            }
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/10 px-3.5 py-2 text-sm text-fg ring-1 ring-inset ring-accent/15">
                  {item.audio && <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-accent" title="Sent in voice mode"><LuAudioLines size={13} aria-hidden="true" /><span>Audio</span></div>}
                  <div className="whitespace-pre-wrap">{text}</div>
                  {blocks.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap justify-end gap-1">
                      {blocks.map((b, i) => (
                        <ContextChip key={i} label={b.label} body={b.body} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className="max-w-[90%]">
                {item.thinking && (
                  <details className="mb-1 text-xs text-fg-subtle">
                    <summary className="cursor-pointer hover:text-fg-muted">thinking</summary>
                    <div className="mt-1 whitespace-pre-wrap border-l border-line pl-2">
                      {item.thinking}
                    </div>
                  </details>
                )}
                {item.text && (
                  <div className="md text-sm leading-relaxed text-fg">
                    {/* Streamdown rather than plain markdown: a reply arrives a
                        token at a time, so half of it is briefly malformed —
                        an unclosed fence, a half-written link — and a strict
                        renderer flickers between interpretations as it lands.
                        A reasoning model also sometimes closes a thought inside
                        the answer; that stray tag is noise to whoever reads it. */}
                    <Streamdown
                      parseIncompleteMarkdown
                      shikiTheme={["github-light", "github-dark"]}
                      plugins={mermaid ? { mermaid } : undefined}
                      mermaid={mermaidOptions}
                    >
                      {(item.audio ? displaySpeechText(item.text, item.done) : item.text).replace(/<\/?think(ing)?>/gi, "")}
                    </Streamdown>
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === "tool") {
            const tone =
              item.status === "error"
                ? "text-danger"
                : item.status === "running"
                  ? "text-accent"
                  : "text-fg-faint";
            return (
              <div
                key={item.id}
                className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-fg-faint"
              >
                <span className={`shrink-0 ${tone}`}>
                  {item.status === "running" ? "◇" : item.status === "error" ? "✕" : "◆"}
                </span>
                <span className="shrink-0 text-fg-subtle">{item.name}</span>
                {item.detail && <span className="truncate opacity-60">{item.detail}</span>}
              </div>
            );
          }
          return (
            <div
              key={item.id}
              className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-xs ${
                item.tone === "error"
                  ? "bg-danger/10 text-danger"
                  : "bg-raised/60 text-fg-muted"
              }`}
            >
              {item.text}
            </div>
          );
        })}

          {running && phase && <ActivityLine phase={phase} now={now} />}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="px-4 pb-4 pt-2 sm:px-6 sm:pb-5"
      >
        <div className="prompt-shell relative mx-auto w-full max-w-3xl">
        {matches.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
            {matches.map((c) => (
              <button
                key={c.name}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(`/${c.name} `);
                }}
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left transition hover:bg-fg/5"
              >
                <span className="font-mono text-xs text-accent">/{c.name}</span>
                <span className="truncate text-xs text-fg-subtle">{c.description}</span>
                <span className="ml-auto shrink-0 text-[10px] text-fg-faint">{c.source}</span>
              </button>
            ))}
          </div>
        )}
        <input ref={fileInput} type="file" accept={DOCUMENT_ACCEPT} multiple className="hidden" aria-label="Choose documents"
          onChange={e => { if (e.target.files) documents.attach(e.target.files); e.target.value = ""; }} />
        {documents.attachments.length > 0 && <div className="document-attachments" aria-live="polite">
          {documents.attachments.map(a => <div key={a.key} className={`document-attachment${a.error ? " has-error" : ""}`}>
            <LuFileText aria-hidden="true" />
            <div><span title={a.name}>{a.name}</span><small>{a.error || (a.document ? `Ready · ${a.document.characters.toLocaleString()} characters` : "Reading document…")}</small></div>
            <button type="button" aria-label={`Remove ${a.name}`} title="Remove attachment" onClick={() => documents.remove(a.key)}><LuX /></button>
          </div>)}
          <p>Included with your next typed or spoken message.</p>
        </div>}
        {documents.error && <p role="alert" className="document-error">{documents.error}</p>}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={running ? "Send a follow-up…" : voiceMode ? "Type while you talk to Elara…" : "Message Elara…"}
          aria-label="Message"
          className="prompt-input"
        />
          <ComposerBar
            sessionId={session.id}
            session={session}
            running={running}
            panelRequest={panelRequest}
            onPanelConsumed={() => setPanelRequest(null)}
            actions={<>
              <button type="button" className="prompt-action" aria-label="Attach documents" title="Attach documents (PDF, Word, text)" disabled={documents.attachments.length >= 5} onClick={() => fileInput.current?.click()}><LuPaperclip className="h-4 w-4" /></button>
              <VoiceControl chatOpen={chatOpen} onChatToggle={() => setChatOpen(value => !value)} canvasOpen={canvasOpen} onCanvasMinimize={()=>setCanvasOpen(false)} onCanvasToggle={()=>setCanvasOpen(value=>!value)} key={session.id} sessionId={session.id} items={items} running={running} onSend={documents.send} onAbort={onAbort} stageTarget={voiceHost} onModeChange={setVoiceMode} title={session.title} browserAvailable={browserUp} browserActivity={latestBrowserActivity(events)} terminalActivity={latestTerminalActivity(events)} toolEvents={events} />
              {running && !input.trim() && !documents.attachments.length ? <button type="button" aria-label="Stop generation" title="Stop generation" onClick={onAbort} className="prompt-action prompt-stop">
                <LuSquare aria-hidden className="h-4 w-4" fill="currentColor" />
              </button> : <button type="submit" aria-label="Send message" title={running ? 'Send follow-up' : 'Send message'} disabled={sending || documents.uploading || documents.attachments.some(a => !!a.error) || (!input.trim() && !documents.attachments.length)}
                className="prompt-action prompt-send">
                <LuArrowUp aria-hidden className="h-5 w-5" />
              </button>}
            </>}
          />
        </div>
      </form>
      </div>

      {/* Beside the conversation rather than above it: the page changing while
          the agent explains what it is doing is the thing worth seeing, and a
          strip across the top pushed the transcript out of view to show it. */}
      {!voiceMode && (watching || terminal) && (
        <>
          <div
            onPointerDown={dragWidth}
            title="Drag to resize"
            className="w-1 shrink-0 cursor-col-resize bg-line transition hover:bg-accent/40"
          />
          <aside
            ref={browserPane}
            style={{ width: asideWidth }}
            className="flex shrink-0 flex-col overflow-hidden border-l border-line [&:fullscreen]:w-screen"
          >
            {watching && (
              <div
                className="flex min-h-0 flex-col bg-black"
                style={{ flex: terminal ? `${split} 1 0%` : "1 1 0%" }}
              >
                <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
                  <span className="text-[11px] text-fg-subtle">Browser</span>
                  <button
                    onClick={() => { void toggleBrowserFullscreen(); }}
                    aria-pressed={browserFullscreen}
                    className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg"
                  >
                    {browserFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  </button>
                  <button
                    onClick={() => { void collapseBrowser(); }}
                    title="Collapse"
                    className="rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg"
                  >
                    ✕
                  </button>
                </div>
                <iframe
                  src="/browser-ui/"
                  title="The agent's browser"
                  className="min-h-0 flex-1 border-0"
                  allow="clipboard-read; clipboard-write; fullscreen"
                />
              </div>
            )}

            {watching && terminal && (
              <div
                onPointerDown={dragSplit}
                title="Drag to resize"
                className="h-1 shrink-0 cursor-row-resize bg-line transition hover:bg-accent/40"
              />
            )}

            {terminal && (
              <div
                className="flex min-h-0 flex-col"
                style={{ flex: watching ? `${1 - split} 1 0%` : "1 1 0%" }}
              >
                <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
                  <span className="text-[11px] text-fg-subtle">Terminal</span>
                  <span className="truncate font-mono text-[10px] text-fg-faint">
                    {session.workspace}
                  </span>
                  <button
                    onClick={() => setTerminal(false)}
                    title="Collapse"
                    className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg"
                  >
                    ✕
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <TerminalPanel sessionId={session.id} />
                </div>
              </div>
            )}
          </aside>
        </>
      )}
      </div>
    </div>
  );
}

/**
 * The line that says what the agent is doing.
 *
 * The elapsed count is the point of it: "processing the prompt" for four
 * seconds is normal and "processing the prompt" for four minutes is a question,
 * and only one of those is worth interrupting. Where llama.cpp reports its own
 * prefill, the bar is its numbers rather than an animation standing in for
 * progress — a cached prefix shows as already done, because it is.
 */
function ActivityLine({ phase, now }: { phase: Activity; now: number }) {
  if (phase.label === 'processing the prompt' || phase.label === 'compacting the conversation') return <ActivityProgress phase={phase} />;
  const seconds = phase.since ? Math.floor((now - phase.since) / 1000) : 0;
  const p = phase.prefill;
  // `processed` already counts the cached prefix — llama.cpp reports the first
  // batch as processed == cache, so adding them overshoots the total.
  const done = p ? Math.min(p.total, p.processed) : 0;
  const percent = p && p.total > 0 ? Math.round((done / p.total) * 100) : null;

  return (
    <div className="py-1 text-xs text-fg-subtle">
      <div className="flex items-center gap-1.5">
        <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
        <span>{phase.label}</span>
        {percent !== null && <span className="text-fg-muted">{percent}%</span>}
        {seconds >= 2 && <span className="text-fg-faint">· {formatElapsed(seconds)}</span>}
      </div>
      {p && p.total > 0 && (
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 w-40 overflow-hidden rounded-full bg-fg/10">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.min(100, (done / p.total) * 100)}%` }}
            />
          </div>
          <span className="font-mono text-[10px] text-fg-faint">
            {tokens(done)}/{tokens(p.total)} tokens
            {p.cache > 0 && ` · ${tokens(p.cache)} from cache`}
          </span>
        </div>
      )}
    </div>
  );
}

const formatElapsed = (s: number) =>
  s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
