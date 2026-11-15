const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
let store = { posts: [], scheduled: [] };
try { if (fs.existsSync(DATA_FILE)) store = { ...store, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) }; } catch (e) { console.error(e.message); }
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch (e) { console.error("Save failed:", e.message); } }
function token() { return process.env.THREADS_ACCESS_TOKEN || ""; }
async function threadsRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || data.error_description || "Threads API 요청 실패 (" + response.status + ")");
  return data;
}
async function publish(text) {
  if (!token()) throw new Error("Railway에 THREADS_ACCESS_TOKEN을 먼저 등록해야 합니다.");
  const base = "https://graph.threads.net/v1.0";
  const me = await threadsRequest(base + "/me?fields=id,username&access_token=" + encodeURIComponent(token()));
  const container = await threadsRequest(base + "/" + me.id + "/threads", { method: "POST", body: new URLSearchParams({ media_type: "TEXT", text, access_token: token() }) });
  const result = await threadsRequest(base + "/" + me.id + "/threads_publish", { method: "POST", body: new URLSearchParams({ creation_id: container.id, access_token: token() }) });
  return { id: result.id, username: me.username };
}
app.get("/api/status", async (req, res) => {
  if (!token()) return res.json({ configured: false });
  try { const me = await threadsRequest("https://graph.threads.net/v1.0/me?fields=id,username&access_token=" + encodeURIComponent(token())); res.json({ configured: true, username: me.username }); }
  catch (e) { res.json({ configured: true, error: e.message }); }
});
app.get("/api/posts", (req, res) => res.json({ posts: store.posts, scheduled: store.scheduled }));
app.post("/api/generate", async (req, res) => {
  const topic = String(req.body.topic || "").trim(), tone = String(req.body.tone || "친근한").trim();
  if (!topic) return res.status(400).json({ error: "주제를 입력해 주세요." });
  if (process.env.GEMINI_API_KEY) {
    try {
      const prompt = "스레드에 올릴 자연스러운 한국어 게시글을 작성해. 주제: " + topic + ". 말투: " + tone + ". 2~5문장, 과장이나 허위 사실 없이, 게시글 본문만 출력해.";
      const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(process.env.GEMINI_API_KEY);
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || "Gemini 요청 실패");
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
      if (!text) throw new Error("AI가 글을 생성하지 못했습니다.");
      return res.json({ text, mode: "AI" });
    } catch (e) { return res.status(502).json({ error: "AI 생성 실패: " + e.message }); }
  }
  res.json({ mode: "간편 초안", text: topic + "에 대해 생각해 볼 만한 점을 정리해 봤어요.\n\n여러분은 어떻게 생각하시나요? 경험이나 의견이 있다면 댓글로 공유해 주세요." });
});
app.post("/api/publish", async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "게시글 내용을 입력해 주세요." });
  try {
    const result = await publish(text), createdAt = new Date().toISOString();
    const post = { id: result.id, text, username: result.username, status: "게시 완료", createdAt };
    store.posts.unshift(post); save(); res.json({ ok: true, post });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/schedule", (req, res) => {
  const text = String(req.body.text || "").trim(), at = new Date(req.body.at);
  if (!text) return res.status(400).json({ error: "게시글 내용을 입력해 주세요." });
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return res.status(400).json({ error: "미래 시간을 선택해 주세요." });
  const item = { id: String(Date.now()) + Math.random().toString(16).slice(2), text, at: at.toISOString(), status: "예약 대기" };
  store.scheduled.push(item); save(); res.json({ ok: true, item });
});
app.delete("/api/schedule/:id", (req, res) => { store.scheduled = store.scheduled.filter(x => x.id !== req.params.id); save(); res.json({ ok: true }); });
async function runScheduler() {
  const due = store.scheduled.filter(x => x.status === "예약 대기" && new Date(x.at).getTime() <= Date.now());
  for (const item of due) {
    item.status = "게시 중"; save();
    try {
      const result = await publish(item.text), completedAt = new Date().toISOString();
      item.status = "게시 완료"; item.postId = result.id; item.completedAt = completedAt;
      store.posts.unshift({ id: result.id, text: item.text, username: result.username, status: "예약 게시 완료", createdAt: completedAt });
    } catch (e) { item.status = "실패: " + e.message; }
    save();
  }
}
setInterval(runScheduler, 15000);
app.get("/health", (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log("Threads automation server listening on " + PORT));