import express from "express";
import { getSession } from "../db.js";
import { MAX_DOCUMENT_BYTES, saveDocument } from "../documents.js";

export function documentsRouter() {
  const router = express.Router();
  router.post("/sessions/:id/documents", (req, res, next) => {
    if (!getSession(String(req.params.id))) return res.status(404).json({ error: "Session not found" });
    next();
  }, express.raw({ type: "application/octet-stream", limit: MAX_DOCUMENT_BYTES }), async (req, res) => {
    try {
      const session = getSession(String(req.params.id));
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "Upload a document as application/octet-stream." });
      const name = decodeURIComponent(req.get("X-File-Name") || "");
      res.status(201).json(await saveDocument(session.workspace, name, req.body));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not read this document." });
    }
  });
  router.use((error: { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error.type === "entity.too.large") res.status(413).json({ error: "Documents must be 15 MB or smaller." });
    else next(error);
  });
  return router;
}
