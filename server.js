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
const GEMINI_TIMEOUT_MS = 65000;
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


function exactlyThreeParagraphs(value) {
  const source = String(value || "").replace(/\r/g, "").trim();
  if (!source) return "";
  let paragraphs = source.split(/\n\s*\n+/)
    .map(part => part.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length === 3) return paragraphs.join("\n\n");

  let units = paragraphs;
  if (units.length < 3) {
    const sentences = source.replace(/\n+/g, " ")
      .match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g);
    units = (sentences || []).map(part => part.trim()).filter(Boolean);
  }
  if (units.length < 3) {
    const words = source.replace(/\n+/g, " ").split(/\s+/).filter(Boolean);
    const chunk = Math.ceil(words.length / 3);
    units = [
      words.slice(0, chunk).join(" "),
      words.slice(chunk, chunk * 2).join(" "),
      words.slice(chunk * 2).join(" ")
    ].filter(Boolean);
  }
  const groups = [[], [], []];
  units.forEach((part, index) => {
    groups[Math.min(2, Math.floor(index * 3 / units.length))].push(part);
  });
  return groups.map(group => group.join(" ").trim()).filter(Boolean).join("\n\n");
}

async function waitForThreadContainer(containerId) {
  const base = "https://graph.threads.net/v1.0";
  for (let attempt = 0; attempt < 12; attempt++) {
    const status = await threadsRequest(
      base + "/" + encodeURIComponent(containerId) +
      "?fields=status,error_message&access_token=" + encodeURIComponent(token())
    );
    if (status.status === "FINISHED") return;
    if (status.status === "ERROR" || status.status === "EXPIRED") {
      throw new Error(status.error_message || ("댓글 컨테이너 처리 실패: " + status.status));
    }
    if (status.status === "PUBLISHED") return;
    if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error("댓글 처리 시간이 초과됐습니다. 게시글은 등록됐으니 댓글 다시 등록을 눌러 재시도해 주세요.");
}

function cleanText(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}
function seoulDayTimeRange() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  const start = new Date(date.year + "-" + date.month + "-" + date.day + "T00:00:00+09:00");
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

function seoulTodayLabel() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "long"
  }).format(new Date());
}

// 설명 문장이나 다른 글자와 함께 붙여 넣어도 첫 번째 http(s) URL만 추출합니다.
function extractHttpUrl(value) {
  const text = String(value || "").trim();
  const match = text.match(/https?:\/\/[^\s<>"'`]+/i);
  if (!match) return "";
  return match[0].replace(/[.,!?;:，。！？；：)\]}》〉」』】]+$/u, "");
}

function validateHttpUrl(value) {
  if (!value) return "";
  const extracted = extractHttpUrl(value);
  if (!extracted) throw new Error("입력한 내용에서 http:// 또는 https:// 링크를 찾지 못했습니다.");
  let url;
  try { url = new URL(extracted); } catch (_) { throw new Error("링크 주소를 다시 확인해 주세요."); }
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

async function publishReply(text, parentPostId) {
  if (!text) return null;
  if (!parentPostId) throw new Error("댓글을 연결할 게시글 ID가 없습니다.");
  if (!token()) throw new Error("THREADS_ACCESS_TOKEN이 등록되지 않았습니다.");
  const base = "https://graph.threads.net/v1.0";
  const me = await threadsRequest(base + "/me?fields=id&access_token=" + encodeURIComponent(token()));
  const container = await threadsRequest(base + "/" + me.id + "/threads", {
    method: "POST",
    body: new URLSearchParams({
      media_type: "TEXT",
      text,
      reply_to_id: parentPostId,
      access_token: token()
    })
  });
  await waitForThreadContainer(container.id);
  const result = await threadsRequest(base + "/" + me.id + "/threads_publish", {
    method: "POST",
    body: new URLSearchParams({ creation_id: container.id, access_token: token() })
  });
  return result.id;
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


app.get("/api/reply-status", async (req, res) => {
  if (!token()) return res.json({ ok: false, canReply: false, error: "THREADS_ACCESS_TOKEN이 등록되지 않았습니다." });
  try {
    const base = "https://graph.threads.net/v1.0";
    const me = await threadsRequest(base + "/me?fields=id,username&access_token=" + encodeURIComponent(token()));
    const quota = await threadsRequest(
      base + "/" + me.id + "/threads_publishing_limit?fields=reply_quota_usage,reply_config&access_token=" + encodeURIComponent(token())
    );
    const info = Array.isArray(quota.data) ? quota.data[0] : quota;
    res.json({
      ok: true,
      canReply: true,
      username: me.username,
      replyQuotaUsed: Number(info?.reply_quota_usage || 0),
      replyQuotaTotal: Number(info?.reply_config?.quota_total || 0)
    });
  } catch (e) {
    res.json({ ok: false, canReply: false, error: e.message || "댓글 권한 확인에 실패했습니다." });
  }
});

app.get("/api/posts", (req, res) => res.json({ posts: store.posts, scheduled: store.scheduled }));


app.post("/api/generate", async (req, res) => {
  const category = ["toss", "daily"].includes(req.body.category) ? req.body.category : "daily";
  const topic = cleanText(req.body.topic, 300);
  const productName = cleanText(req.body.productName, 240);
  const tone = cleanText(req.body.tone || "생활형 후기형", 60);
  const todayIssue = category === "daily" && req.body.todayIssue === true;
  let affiliateLink = "";
  try {
    affiliateLink = validateHttpUrl(cleanText(req.body.affiliateLink, 2000));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const subject = productName || topic;
  if (!subject && !todayIssue) return res.status(400).json({ error: "조사할 키워드나 주제를 입력해 주세요." });
  if (category !== "daily" && !affiliateLink) {
    return res.status(400).json({ error: "토스 쉐어링크를 입력해 주세요." });
  }
  if (category === "daily" && !process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "실시간 조사 기능을 사용하려면 Railway에 GEMINI_API_KEY가 등록되어 있어야 합니다." });
  }

  const linkInfo = req.body.linkInfo && typeof req.body.linkInfo === "object" ? req.body.linkInfo : {};
  const pageTitle = cleanText(linkInfo.title, 240);
  const pageDescription = cleanText(linkInfo.description, 700);
  const today = seoulTodayLabel();
  const prompt = [
    category === "daily"
      ? "한국어 Threads(스레드)에 올릴 사실 기반 일상·정보 게시글을 작성해."
      : "한국어 Threads(스레드)에 올릴 상품 소개 글을 작성해.",
    category === "daily" ? "오늘 날짜(대한민국 서울 기준): " + today : "",
    category === "daily" && todayIssue
      ? "주제 선택: Google 검색을 사용해 오늘 대한민국에서 실제로 많이 보도되고 관심을 받는 뉴스·사건·사회 이슈를 직접 찾아라. 검색 결과의 보도량과 여러 언론의 공통 보도를 바탕으로 글감 하나를 골라라. 사용자가 추가 키워드를 적었다면 그 키워드 분야 안에서 오늘의 주요 이슈를 골라라. 객관적으로 확인할 수 없는 '가장 인기' 순위는 단정하지 마라."
      : "",
    category === "daily" && !todayIssue
      ? "조사할 키워드: " + subject + ". Google 검색으로 이 키워드가 가리키는 사건·이슈가 무엇인지 직접 조사해라. 무슨 일이 언제 어디서 발생했는지, 핵심 원인이나 배경, 현재까지 확인된 상황을 신뢰할 만한 자료로 교차 확인해라."
      : "",
    category === "daily"
      ? "검색 결과의 날짜를 확인하고 오래된 사건을 오늘 발생한 것처럼 쓰지 마라. 최소 두 개의 신뢰할 만한 언론·공식 기관 자료가 뒷받침하는 사실만 사용해라. 확인되지 않은 숫자·인명·장소·원인·피해 규모·속보성 주장은 만들지 마라. 보도 내용이 충돌하거나 사실이 불명확하면 그 내용을 빼라. 핵심을 이해하기 쉽게 설명하고 독자에게 왜 중요한지 짚어라. 기사 제목을 베끼지 말고 사실을 네 문장으로 요약해라."
      : "",
    category === "toss" ? "상품명 또는 주제: " + subject : "",
    pageTitle ? "링크 페이지 제목: " + pageTitle : "",
    pageDescription ? "링크 페이지 설명: " + pageDescription : "",
    "게시물 유형: " + (category === "toss" ? "토스 쉐어링크 상품 소개" : "일상/정보 게시글"),
    "말투 설정: " + tone,
    category === "daily"
      ? "말투는 친구에게 알려주듯 자연스럽고 이해하기 쉽게. 사실을 가볍게 왜곡하거나 선정적으로 과장하지 마."
      : "핵심 말투는 친구에게 수다 떨듯 편하고 생생한 생활형 후기 스타일이야. 딱딱한 광고 문구나 쇼핑몰 상세페이지 말투는 쓰지 마.",
    category === "toss"
      ? "예시의 문체 특징을 적용해: '이런 거 숨겨두는 게 국룰인 거 알지? ㅋㅋ'처럼 일상 공감으로 시작하고, 상품을 발견한 순간의 반응을 자연스럽게 말한 다음, 확인된 특징을 감각적이고 구체적인 표현으로 풀어줘."
      : "",
    category === "toss"
      ? "짧은 문장과 줄바꿈으로 리듬을 만들고, 중간중간 '진짜 요물임', '장난 아님', '나도 모르게 눈길 감', 'ㅠㅠ', 'ㅋㅋ' 같은 구어체 반응을 과하지 않게 섞어줘."
      : "",
    category === "toss" ? "마무리는 친구에게 이야기하듯 가벼운 농담이나 솔직한 한마디로 끝내." : "첫 단락은 관심을 끄는 핵심 요약, 두 번째 단락은 확인된 사실과 배경, 세 번째 단락은 현재 상황과 독자에게 중요한 점으로 마무리해.",
    "게시글은 반드시 정확히 3개의 단락으로만 작성해. 각 단락은 1~3개의 짧은 문장으로 구성하고, 단락 사이에는 빈 줄을 하나만 넣어. 소제목, 번호, 목록은 쓰지 마.",
    "첫 번째 단락은 스크롤을 멈추게 하는 후킹 문장으로 시작하고, 두 번째 단락은 확인된 사실이나 상품 특징을 자연스럽게 설명하며, 세 번째 단락은 핵심 의미를 정리해 마무리해.",
    category === "toss" ? "상품명, 기능, 용량, 소재, 구성, 가격, 할인, 배송, 재고 등은 링크 페이지에서 확인된 내용만 사용해. 확인되지 않은 구체 정보는 만들지 마." : "",
    category === "toss" ? "사용자가 실제 사용 경험을 제공하지 않았다면 구매하거나 먹어 봤다고 거짓말하지 마. 가족이나 남편의 반응, 직접 사용한 에피소드도 지어내지 마." : "",
    category === "toss" ? "수익 보장, 과장된 효능, 검증되지 않은 24시간 추적·수수료 주장은 넣지 마." : "",
    category === "toss" ? "링크와 제휴 고지 문구는 시스템이 뒤에 자동으로 붙이므로 본문에는 URL이나 고지 문구를 쓰지 마." : "",
    category === "toss" ? "광고라는 사실을 숨기려 하지 말고, 자연스러운 추천 문체로만 작성해." : "",
    "게시글 본문만 출력해. 조사 과정, 출처 목록, 안내 문구를 별도로 붙이지 마."
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
      const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 620, temperature: category === "daily" ? 0.55 : 0.8 }
      };
      if (category === "daily") {
        const googleSearch = {};
        if (todayIssue) googleSearch.timeRangeFilter = seoulDayTimeRange();
        requestBody.tools = [{ google_search: googleSearch }];
      }
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify(requestBody),
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
      mode = "AI (" + GEMINI_MODEL + (category === "daily" ? " · Google 검색 조사" : "") + ")";
    } catch (e) {
      const detail = e.name === "AbortError"
        ? "검색 및 글 생성 시간이 초과됐습니다. 다시 시도해 주세요."
        : e.message;
      console.error("Gemini generate failed:", detail);
      return res.status(502).json({ error: "AI 생성 실패: " + detail });
    } finally {
      clearTimeout(timeout);
    }
  }

  generated = exactlyThreeParagraphs(generated);

  const commentParts = [];
  if (category === "toss") {
    commentParts.push("상품 링크\n" + affiliateLink);
    commentParts.push(DISCLOSURES.toss);
  }

  res.json({
    text: generated.trim(),
    commentText: commentParts.join("\n\n"),
    mode,
    category,
    productName: subject || "오늘의 이슈",
    links: { affiliateLink }
  });
});

app.post("/api/publish", async (req, res) => {
  const text = cleanText(req.body.text, 5000);
  const commentText = cleanText(req.body.commentText, 2000);
  const category = ["toss", "daily"].includes(req.body.category) ? req.body.category : "daily";
  if (!text) return res.status(400).json({ error: "게시글 내용을 입력해 주세요." });
  try {
    const result = await publish(text);
    let replyId = null;
    let commentStatus = commentText ? "댓글 등록 대기" : "댓글 없음";
    let commentError = "";
    if (commentText) {
      try {
        replyId = await publishReply(commentText, result.id);
        commentStatus = "댓글 게시 완료";
      } catch (e) {
        commentStatus = "댓글 등록 실패";
        commentError = e.message;
      }
    }
    const createdAt = new Date().toISOString();
    const post = {
      id: result.id, text, username: result.username, category,
      status: "게시 완료", commentStatus, commentText, replyId, createdAt
    };
    store.posts.unshift(post);
    save();
    res.json({ ok: true, post, commentPosted: Boolean(replyId), commentError });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/schedule", (req, res) => {
  const text = cleanText(req.body.text, 5000);
  const commentText = cleanText(req.body.commentText, 2000);
  const category = ["toss", "daily"].includes(req.body.category) ? req.body.category : "daily";
  const at = new Date(req.body.at);
  if (!text) return res.status(400).json({ error: "게시글 내용을 먼저 작성해 주세요." });
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return res.status(400).json({ error: "미래 시간을 선택해 주세요." });
  const item = {
    id: String(Date.now()) + Math.random().toString(16).slice(2),
    text, commentText, category, at: at.toISOString(), status: "예약 대기"
  };
  store.scheduled.push(item);
  store.scheduled.sort((a, b) => new Date(a.at) - new Date(b.at));
  save();
  res.json({ ok: true, item });
});

app.post("/api/reply", async (req, res) => {
  const postId = cleanText(req.body.postId, 200);
  const post = store.posts.find(item => item.id === postId);
  if (!post) return res.status(404).json({ error: "해당 게시물을 찾지 못했습니다." });
  const text = cleanText(req.body.text || post.commentText, 2000);
  if (!text) return res.status(400).json({ error: "등록할 댓글 내용이 없습니다." });
  try {
    const replyId = await publishReply(text, post.id);
    post.commentText = text;
    post.replyId = replyId;
    post.commentStatus = "댓글 게시 완료";
    save();
    res.json({ ok: true, replyId, post });
  } catch (e) {
    post.commentStatus = "댓글 등록 실패";
    post.commentError = e.message;
    save();
    res.status(400).json({ error: e.message });
  }
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
      item.postId = result.id;
      let replyId = null;
      let commentError = "";
      if (item.commentText) {
        try {
          replyId = await publishReply(item.commentText, result.id);
          item.commentStatus = "댓글 게시 완료";
        } catch (e) {
          commentError = e.message;
          item.commentStatus = "댓글 등록 실패";
        }
      } else {
        item.commentStatus = "댓글 없음";
      }
      const completedAt = new Date().toISOString();
      item.status = commentError ? "게시 완료 (댓글 등록 실패)" : "게시 완료";
      item.replyId = replyId;
      item.commentError = commentError;
      item.completedAt = completedAt;
      store.posts.unshift({
        id: result.id, text: item.text, username: result.username,
        category: item.category || "daily",
        status: commentError ? "예약 게시 완료 (댓글 실패)" : "예약 게시 완료",
        commentStatus: item.commentStatus, commentText: item.commentText || "", replyId, createdAt: completedAt
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
