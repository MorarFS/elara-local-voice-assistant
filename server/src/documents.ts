import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const MAX_CHARACTERS = 500_000;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".log", ".yaml", ".yml"]);

export async function extractDocument(name: string, buffer: Buffer): Promise<string> {
  if (!buffer.length) throw new Error("This document is empty.");
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error("Documents must be 15 MB or smaller.");
  const extension = path.extname(name).toLowerCase();
  let text = "";
  if (TEXT_EXTENSIONS.has(extension)) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw new Error("Save this text document as UTF-8 and attach it again."); }
    if (text.includes("\0")) throw new Error("This file contains binary data, not readable text.");
  } else if (extension === ".docx") {
    try { text = (await mammoth.extractRawText({ buffer })).value; }
    catch { throw new Error("Could not read this Word document. Attach a valid .docx file."); }
  } else if (extension === ".pdf") {
    const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 200) throw new Error("PDFs can have up to 200 pages. Attach a smaller section.");
      const pages: string[] = [];
      let length = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const paragraph = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        if (paragraph) pages.push(`[Page ${i}]\n${paragraph}`);
        length += paragraph.length;
        page.cleanup();
        if (length > MAX_CHARACTERS) throw new Error("Document text exceeds 500,000 characters. Attach a smaller section.");
      }
      text = pages.join("\n\n");
      if (!text) throw new Error("This PDF has no readable text. For a scan, export it with OCR first.");
    } catch (error) {
      if (error instanceof Error && /200 pages|500,000|no readable text/.test(error.message)) throw error;
      throw new Error("Could not read this PDF. Check that it is valid and not password protected.");
    } finally { await task.destroy(); }
  } else {
    throw new Error("Attach a PDF, DOCX, or text file (TXT, Markdown, CSV, JSON, YAML, LOG).");
  }
  text = text.trim();
  if (!text) throw new Error("This document has no readable text.");
  if (text.length > MAX_CHARACTERS) throw new Error("Document text exceeds 500,000 characters. Attach a smaller section.");
  return text;
}

export async function saveDocument(workspace: string, fileName: string, buffer: Buffer) {
  const name = path.basename(fileName.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180);
  if (!name || name === "." || name === "..") throw new Error("A document filename is required.");
  const text = await extractDocument(name, buffer);
  const root = await realpath(workspace);
  const parent = path.join(root, ".elara-documents");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error("The document folder must be inside this workspace.");
  const id = randomUUID();
  const directory = path.join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  const textPath = path.join(directory, "extracted.txt");
  try {
    // Separate original/ avoids a filename colliding with the extracted text.
    await mkdir(path.join(directory, "original"), { mode: 0o700 });
    await writeFile(path.join(directory, "original", name), buffer, { flag: "wx", mode: 0o600 });
    await writeFile(textPath, text, { flag: "wx", mode: 0o600 });
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { id, name, characters: text.length, textPath, excerpt: text.slice(0, 12_000), truncated: text.length > 12_000 };
}
