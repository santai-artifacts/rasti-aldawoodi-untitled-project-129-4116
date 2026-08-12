import Database from "bun:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------- Database ----------
const DB_PATH = process.env.DATABASE_URL || "./data/app.db";
try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
} catch {}
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------- AI ----------
const AI_READY = Boolean(
  process.env.SANTAI_AI_BASE_URL && process.env.SANTAI_AI_TOKEN,
);
const ai = new Anthropic({
  baseURL: process.env.SANTAI_AI_BASE_URL,
  apiKey: process.env.SANTAI_AI_TOKEN || "placeholder",
});
const MODEL = "anthropic-claude-bedrock4.5-haiku";
const SYSTEM_PROMPT =
  "You are a friendly, concise assistant. Answer clearly and helpfully. " +
  "Use plain language, and format with short paragraphs or bullet points when it aids readability.";

async function generateReply(
  history: { role: string; content: string }[],
): Promise<string> {
  if (!AI_READY) {
    return "👋 Hi! I'm Aria. The AI service isn't wired up in this preview environment yet — it's provided automatically once the app is deployed. Until then, this is a placeholder reply so you can see how the chat flows.";
  }
  try {
    const msg = await ai.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })) as any,
    });
    return (
      msg.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim() || "…"
    );
  } catch (err) {
    console.error("AI call failed", err);
    return "⚠️ I couldn't reach the AI service just now. This usually resolves once the app is deployed. Please try again in a moment.";
  }
}

// ---------- Helpers ----------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const publicDir = `${import.meta.dir}/public`;

// ---------- Server ----------
export default {
  port: process.env.PORT || 3000,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const { pathname } = url;

    // --- API ---
    if (pathname === "/api/conversations" && req.method === "GET") {
      const rows = db
        .query(
          `SELECT c.id, c.title, c.created_at,
             (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last
           FROM conversations c ORDER BY c.id DESC`,
        )
        .all();
      return json(rows);
    }

    if (pathname === "/api/conversations" && req.method === "POST") {
      const info = db.query("INSERT INTO conversations (title) VALUES (?)").run(
        "New chat",
      );
      const id = Number(info.lastInsertRowid);
      return json({ id, title: "New chat" });
    }

    const convMatch = pathname.match(/^\/api\/conversations\/(\d+)$/);
    if (convMatch && req.method === "DELETE") {
      const id = Number(convMatch[1]);
      db.query("DELETE FROM messages WHERE conversation_id = ?").run(id);
      db.query("DELETE FROM conversations WHERE id = ?").run(id);
      return json({ ok: true });
    }

    const msgMatch = pathname.match(/^\/api\/conversations\/(\d+)\/messages$/);
    if (msgMatch && req.method === "GET") {
      const id = Number(msgMatch[1]);
      const rows = db
        .query(
          "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC",
        )
        .all(id);
      return json(rows);
    }

    if (pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          conversationId?: number;
          message?: string;
        };
        const text = (body.message || "").trim();
        if (!text) return json({ error: "Empty message" }, 400);

        // Ensure a conversation exists
        let convId = body.conversationId;
        if (!convId) {
          const info = db
            .query("INSERT INTO conversations (title) VALUES (?)")
            .run(text.slice(0, 60));
          convId = Number(info.lastInsertRowid);
        }

        // Persist user message
        db.query(
          "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)",
        ).run(convId, text);

        // Title the conversation from its first message
        const count = db
          .query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
          .get(convId) as { n: number };
        if (count.n === 1) {
          db.query("UPDATE conversations SET title = ? WHERE id = ?").run(
            text.slice(0, 60),
            convId,
          );
        }

        // Build history and get reply
        const history = db
          .query(
            "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC",
          )
          .all(convId) as { role: string; content: string }[];

        const reply = await generateReply(history);

        db.query(
          "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)",
        ).run(convId, reply);

        const title = (
          db
            .query("SELECT title FROM conversations WHERE id = ?")
            .get(convId) as { title: string }
        ).title;

        return json({ conversationId: convId, reply, title });
      } catch (err) {
        console.error("chat error", err);
        return json({ error: "Something went wrong generating a reply." }, 500);
      }
    }

    // --- Static files ---
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const file = Bun.file(`${publicDir}${filePath}`);
    if (await file.exists()) return new Response(file);

    // SPA fallback
    return new Response(Bun.file(`${publicDir}/index.html`));
  },
};
