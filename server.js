const express = require("express");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_TIMEOUT_MS = 25000;
const LINK_TIMEOUT_MS = 9000;
const MAX_HTML_BYTES = 1200000;

const DISCLOSURES = {
  toss: "이 포스팅은 토스쇼핑 쉐어링크 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받을 수 있습니다.",
  coupang: "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다."
};

let store = { posts: [], scheduled: [] };
try {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    store = { ...store, ...saved };
  }
} catch (e) {
  console.error("Data load failed:", e.message);
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error("Save failed:", e.message);
  }
}

function token() {
  return process.env.THREADS_ACCESS_TOKEN || "";
}

function cleanText(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function validateHttpUrl(value) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch (_) { throw new Error("링크 주소를 https:// 또는 http://부터 정확히 입력해 주세요."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("http 또는 https 링크만 사용할 수 있습니다.");
  if (url.username || url.password) throw new Error("아이디나 비밀번호가 포함된 링크는 사용할 수 없습니다.");
  return url.toString();
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const p = address.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    return a === "::1" || a === "::" || a.startsWith("fc") ||
      a.startsWith("fd") || a.startsWith("fe8") ||
      a.startsWith("fe9") || a.startsWith("fea") ||
      a.startsWith("feb") || a.startsWith("::ffff:127.") ||
      a.startsWith("::ffff:10.") || a.startsWith("::ffff:192.168.");
  }
  return true;
}

async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("해당 링크 주소는 미리보기로 열 수 없습니다.");
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("내부 네트워크 주소는 열 수 없습니다.");
    return;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(x => isPrivateAddress(x.address))) {
    throw new Error("안전하지 않은 링크 주소로 판단되어 미리보기를 중단했습니다.");
  }
}

async function fetchPublicHtml(rawUrl, redirects = 0) {
  const url = validateHttpUrl(rawUrl);
  await assertPublicUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ProductLinkPreview/1.0)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= 3) throw new Error("링크 이동 횟수가 너무 많습니다.");
      const location = response.headers.get("location");
      if (!location) throw new Error("링크 이동 주소를 확인할 수 없습니다.");
      return await fetchPublicHtml(new URL(location, url).toString(), redirects + 1);
    }
    if (!response.ok) throw new Error("상품 페이지를 열지 못했습니다. (" + response.status + ")");
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) {
      throw new Error("이 링크는 상품 정보를 읽을 수 있는 웹페이지가 아닙니다. 상품명을 직접 입력해 주세요.");
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_HTML_BYTES) {
        response.body.cancel().catch(() => {});
        break;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (e) {
    if (e.name === "AbortError") throw new Error("링크 미리보기 시간이 초과됐습니다. 상품명을 직접 입력해 주세요.");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, " ").trim();
}

function htmlMeta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g, (_, name, whole, dq, sq, bare) => {
      attrs[name.toLowerCase()] = dq !== undefined ? dq : (sq !== undefined ? sq : bare);
      return whole;
    });
    if ((attrs.property || "").toLowerCase() === key || (attrs.name || "").toLowerCase() === key) {
      return decodeHtml(attrs.content || "");
    }
  }
  return "";
}

app.get("/api/link-preview", async (req, res) => {
  const raw = cleanText(req.query.url, 2000);
  if (!raw) return res.status(400).json({ error: "상품 링크를 입력해 주세요." });
  try {
    const url = validateHttpUrl(raw);
    const html = await fetchPublicHtml(url);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = htmlMeta(html, "og:title") || htmlMeta(html, "twitter:title") ||
      decodeHtml(titleMatch ? titleMatch[1].replace(/<[^>]+>/g, " ") : "");
    const description = htmlMeta(html, "og:description") || htmlMeta(html, "description") || htmlMeta(html, "twitter:description");
    const image = htmlMeta(html, "og:image");
    res.json({ ok: true, title: title.slice(0, 240), description: description.slice(0, 700), image });
  } catch (e) {
    res.status(422).json({ error: e.message || "상품 정보를 읽지 못했습니다." });
  }
});

async function threadsRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || data.error_description || "Threads API 요청 실패 (" + response.status + ")");
  }
  return data;
}

async function publish(text) {
  if (!token()) throw new Error("Railway에 THREADS_ACCESS_TOKEN을 먼저 등록해야 합니다.");
  const base = "https://graph.threads.net/v1.0";
  const me = await threadsRequest(base + "/me?fields=id,username&access_token=" + encodeURIComponent(token()));
  const container = await threadsRequest(base + "/" + me.id + "/threads", {
    method: "POST",
    body: new URLSearchParams({ media_type: "TEXT", text, access_token: token() })
  });
  const result = await threadsRequest(base + "/" + me.id + "/threads_publish", {
    method: "POST",
    body: new URLSearchParams({ creation_id: container.id, access_token: token() })
  });
  return { id: result.id, username: me.username };
}

app.get("/api/status", async (req, res) => {
  if (!token()) return res.json({ configured: false });
  try {
    const me = await threadsRequest("https://graph.threads.net/v1.0/me?fields=id,username&access_token=" + encodeURIComponent(token()));
    res.json({ configured: true, username: me.username });
  } catch (e) {
    res.json({ configured: true, error: e.message });
  }
});

app.get("/api/posts", (req, res) => res.json({ posts: store.posts, scheduled: store.scheduled }));

app.post("/api/generate", async (req, res) => {
  const category = ["toss", "coupang", "daily"].includes(req.body.category) ? req.body.category : "daily";
  const topic = cleanText(req.body.topic, 300);
  const productName = cleanText(req.body.productName, 240);
  const details = cleanText(req.body.details, 1400);
  const tone = cleanText(req.body.tone || "친근한", 60);
  let affiliateLink = "";
  let alternateLink = "";
  try {
    affiliateLink = validateHttpUrl(cleanText(req.body.affiliateLink, 2000));
    alternateLink = validateHttpUrl(cleanText(req.body.alternateLink, 2000));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const subject = productName || topic;
  if (!subject) return res.status(400).json({ error: "상품명 또는 게시글 주제를 입력해 주세요." });
  if (category !== "daily" && !affiliateLink) {
    return res.status(400).json({ error: category === "toss" ? "토스 쉐어링크를 입력해 주세요." : "쿠팡 파트너스 링크를 입력해 주세요." });
  }

  const linkInfo = req.body.linkInfo && typeof req.body.linkInfo === "object" ? req.body.linkInfo : {};
  const pageTitle = cleanText(linkInfo.title, 240);
  const pageDescription = cleanText(linkInfo.description, 700);
  const prompt = [
    "한국어 Threads(스레드) 제휴 마케팅 게시글을 작성해.",
    "상품 또는 주제: " + subject,
    pageTitle ? "링크 페이지 제목: " + pageTitle : "",
    pageDescription ? "링크 페이지 설명: " + pageDescription : "",
    details ? "사용자가 제공한 상품 특징과 참고 정보: " + details : "",
    "게시물 유형: " + (category === "toss" ? "토스 쇼핑 쉐어링크 소개" : category === "coupang" ? "쿠팡 파트너스 상품 소개" : "일상/정보 게시글"),
    "말투: " + tone,
    "첫 문장은 스크롤을 멈추게 하는 자연스러운 후킹 문장으로 시작해.",
    "짧은 문단과 자연스러운 줄바꿈을 사용하고, 광고 티가 과도하게 나지 않도록 실제 사용자가 쓴 듯 담백하게 작성해.",
    "상품의 가격, 할인율, 배송, 성능, 재고, 수수료, 구매 후기, 사용 경험, 24시간 추적 여부는 입력된 정보에 없는 한 절대 만들어내지 마.",
    "직접 사용해 봤다고 거짓말하지 마. 과장된 수익 보장이나 구매 압박도 하지 마.",
    "3~6문장 정도로 작성하고, 링크와 제휴 고지 문구는 시스템이 뒤에 붙이므로 본문에 URL이나 고지 문구를 쓰지 마.",
    "게시글 본문만 출력해."
  ].filter(Boolean).join("\n");

  let generated = "";
  let mode = "간편 초안";
  if (!process.env.GEMINI_API_KEY) {
    generated = subject + "을(를) 찾고 있다면 특징과 조건을 한 번 비교해 보세요.\n\n구매 전에 본인에게 필요한 기능인지 확인하는 것도 중요합니다.";
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 420, temperature: 0.8 }
        }),
        signal: controller.signal
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = data.error?.message || "Gemini 요청 실패 (" + r.status + ")";
        if (r.status === 429 || r.status === 503 || r.status === 504) {
          throw new Error("Gemini 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요. (" + detail + ")");
        }
        throw new Error(detail);
      }
      generated = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "";
      if (!generated) throw new Error("AI가 글을 생성하지 못했습니다.");
      mode = "AI (" + GEMINI_MODEL + ")";
    } catch (e) {
      const detail = e.name === "AbortError"
        ? "Gemini 응답 시간 초과(25초). 다시 시도해 주세요."
        : e.message;
      console.error("Gemini generate failed:", detail);
      return res.status(502).json({ error: "AI 생성 실패: " + detail });
    } finally {
      clearTimeout(timeout);
    }
  }

  const output = [generated.trim()];
  if (category === "toss") {
    output.push("토스에서 상품 확인하기\n" + affiliateLink);
    if (alternateLink) output.push("다른 쇼핑 링크로 비교하기\n" + alternateLink);
    output.push(DISCLOSURES.toss);
  } else if (category === "coupang") {
    output.push("쿠팡에서 상품 확인하기\n" + affiliateLink);
    if (alternateLink) output.push("토스에서도 확인하기\n" + alternateLink);
    output.push(DISCLOSURES.coupang);
  } else if (affiliateLink) {
    output.push("관련 링크\n" + affiliateLink);
  }

  res.json({
    text: output.join("\n\n"),
    mode,
    category,
    productName: subject,
    links: { affiliateLink, alternateLink }
  });
});

app.post("/api/publish", async (req, res) => {
  const text = cleanText(req.body.text, 5000);
  const category = ["toss", "coupang", "daily"].includes(req.body.category) ? req.body.category : "daily";
  if (!text) return res.status(400).json({ error: "게시글 내용을 입력해 주세요." });
  try {
    const result = await publish(text);
    const createdAt = new Date().toISOString();
    const post = { id: result.id, text, username: result.username, category, status: "게시 완료", createdAt };
    store.posts.unshift(post);
    save();
    res.json({ ok: true, post });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/schedule", (req, res) => {
  const text = cleanText(req.body.text, 5000);
  const category = ["toss", "coupang", "daily"].includes(req.body.category) ? req.body.category : "daily";
  const at = new Date(req.body.at);
  if (!text) return res.status(400).json({ error: "게시글 내용을 먼저 작성해 주세요." });
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return res.status(400).json({ error: "미래 시간을 선택해 주세요." });
  const item = {
    id: String(Date.now()) + Math.random().toString(16).slice(2),
    text, category, at: at.toISOString(), status: "예약 대기"
  };
  store.scheduled.push(item);
  store.scheduled.sort((a, b) => new Date(a.at) - new Date(b.at));
  save();
  res.json({ ok: true, item });
});

app.delete("/api/schedule/:id", (req, res) => {
  store.scheduled = store.scheduled.filter(x => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});

async function runScheduler() {
  const due = store.scheduled.filter(x => x.status === "예약 대기" && new Date(x.at).getTime() <= Date.now());
  for (const item of due) {
    item.status = "게시 중";
    save();
    try {
      const result = await publish(item.text);
      const completedAt = new Date().toISOString();
      item.status = "게시 완료";
      item.postId = result.id;
      item.completedAt = completedAt;
      store.posts.unshift({
        id: result.id, text: item.text, username: result.username,
        category: item.category || "daily", status: "예약 게시 완료", createdAt: completedAt
      });
    } catch (e) {
      item.status = "실패: " + e.message;
    }
    save();
  }
}

setInterval(runScheduler, 15000);
app.get("/health", (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log("Threads automation server listening on " + PORT));
