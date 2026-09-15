import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import express from "express";
import { once } from "node:events";
import { extractDocument, saveDocument, MAX_DOCUMENT_BYTES } from "../server/src/documents.js";

function pdf(text: string) {
  const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}

test("extracts PDF pages, Word paragraphs and UTF-8 text locally", async () => {
  assert.match(await extractDocument("note.PDF", pdf("The launch code is ORCHID-47.")), /Page 1.*The launch code is ORCHID-47/s);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Elara reads Word.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p></w:body></w:document>');
  assert.equal(await extractDocument("note.docx", await zip.generateAsync({ type: "nodebuffer" })), "Elara reads Word.\n\nSecond paragraph.");
  assert.equal(await extractDocument("note.txt", Buffer.from("Café 你好")), "Café 你好");
});

test("rejects unreadable, unsupported and oversized documents with useful errors", async () => {
  for (const [name, body, message] of [
    ["empty.txt", Buffer.alloc(0), /empty/], ["bad.pdf", Buffer.from("invalid PDF"), /valid.*password/],
    ["scan.pdf", pdf(""), /OCR/], ["old.doc", Buffer.from("old Word"), /DOCX/],
    ["binary.txt", Buffer.from([255]), /UTF-8/], ["binary.txt", Buffer.from("text\0data"), /binary/],
    ["large.txt", Buffer.alloc(MAX_DOCUMENT_BYTES + 1), /15 MB/], ["long.txt", Buffer.from("a".repeat(500001)), /500,000/],
  ] as const) await assert.rejects(extractDocument(name, body), message);
});

test("preserves originals and full text, uses unique folders, and cannot follow a document-folder symlink", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "elara-doc-test-"));
  const outside = await mkdtemp(path.join(tmpdir(), "elara-doc-outside-"));
  try {
    const contents = Buffer.from("A".repeat(15000) + " Final fact: jade.");
    const first = await saveDocument(workspace, "../../extracted.txt", contents);
    const second = await saveDocument(workspace, "extracted.txt", Buffer.from("Second"));
    assert.notEqual(first.id, second.id);
    assert.equal(first.name, "extracted.txt");
    assert.equal(first.excerpt.length, 12000); assert.equal(first.truncated, true);
    assert.equal(await readFile(first.textPath, "utf8"), contents.toString());
    assert.deepEqual(await readFile(path.join(path.dirname(first.textPath), "original", first.name)), contents);
    await rm(path.join(workspace, ".elara-documents"), { recursive: true });
    await symlink(outside, path.join(workspace, ".elara-documents"));
    await assert.rejects(saveDocument(workspace, "note.txt", Buffer.from("Hello")), /inside this workspace/);
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("upload HTTP route validates sessions, parses raw files and returns JSON errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "elara-upload-test-"));
  process.env.DATA_DIR = path.join(directory, "db");
  const { getDb } = await import("../server/src/db.js");
  const { documentsRouter } = await import("../server/src/api/documents.js");
  getDb().prepare("INSERT INTO sessions (id,title,workspace) VALUES (?,?,?)").run("upload", "Upload test", directory);
  const app = express(); app.use(express.json()); app.use("/api", documentsRouter());
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/sessions`;
  try {
    const headers = { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("Café.txt") };
    const good = await fetch(`${base}/upload/documents`, { method: "POST", headers, body: "A fact for Elara." });
    assert.equal(good.status, 201); assert.equal((await good.json()).name, "Café.txt");
    const missing = await fetch(`${base}/missing/documents`, { method: "POST", headers, body: "Hello" });
    assert.equal(missing.status, 404);
    const wrongType = await fetch(`${base}/upload/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(wrongType.status, 400);
    const big = await fetch(`${base}/upload/documents`, { method: "POST", headers, body: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) });
    assert.equal(big.status, 413); assert.match((await big.json()).error, /15 MB/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); getDb().close(); await rm(directory, { recursive: true, force: true }); }
});
