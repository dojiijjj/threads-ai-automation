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


function exactlyTwoParagraphs(value) {
  const source = String(value || "").replace(/\r/g, "").trim();
  if (!source) return "";
  let paragraphs = source.split(/\n\s*\n+/)
    .map(part => part.split("\n").map(line => line.trim()).filter(Boolean).join("\n").trim())
    .filter(Boolean);
  if (paragraphs.length === 2) return paragraphs.join("\n\n");

  let units = paragraphs;
  if (units.length < 2) {
    const sentences = source.replace(/\n+/g, " ")
      .match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g);
    units = (sentences || []).map(part => part.trim()).filter(Boolean);
  }
  if (units.length < 2) {
    const words = source.replace(/\n+/g, " ").split(/\s+/).filter(Boolean);
    const chunk = Math.ceil(words.length / 2);
    units = [
      words.slice(0, chunk).join(" "),
      words.slice(chunk).join(" ")
    ].filter(Boolean);
  }
  const groups = [[], []];
  units.forEach((part, index) => {
    groups[Math.min(1, Math.floor(index * 2 / units.length))].push(part);
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



function rssValue(block, tag) {
  const open = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>", "i"));
  if (!open) return "";
  const start = open.index + open[0].length;
  const end = block.toLowerCase().indexOf("</" + tag.toLowerCase() + ">", start);
  if (end < 0) return "";
  let value = block.slice(start, end).trim();
  if (value.startsWith("<![CDATA[")) value = value.slice(9, -3);
  return decodeHtml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchGoogleNewsFeed(query) {
  const url = query
    ? "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=ko&gl=KR&ceid=KR:ko"
    : "https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ThreadsInfoWriter/1.0)",
        "Accept": "application/rss+xml, application/xml, text/xml"
      }
    });
    if (!response.ok) throw new Error("Google 뉴스 RSS 요청 실패 (" + response.status + ")");
    const xml = await response.text();
    const blocks = xml.split("<item>").slice(1).map(part => part.split("</item>")[0]);
    return blocks.map(block => ({
      title: rssValue(block, "title"),
      description: rssValue(block, "description").slice(0, 700),
      source: rssValue(block, "source"),
      link: rssValue(block, "link"),
      publishedAt: rssValue(block, "pubDate")
    })).filter(item => item.title);
  } catch (e) {
    if (e.name === "AbortError") throw new Error("뉴스 검색 시간이 초과됐습니다.");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function gatherNewsResearch(topic, todayIssue) {
  const queries = todayIssue
    ? [null, "대한민국 주요 뉴스 when:1d", "사건 사고 when:1d", "사회 이슈 when:1d"]
    : [topic, topic + " 사건 최신"];
  const results = await Promise.allSettled(queries.map(query => fetchGoogleNewsFeed(query)));
  const items = [];
  for (const result of results) {
    if (result.status === "fulfilled") items.push(...result.value);
  }
  const seen = new Set();
  const unique = items.filter(item => {
    const key = item.title.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dayStart = new Date(seoulDayTimeRange().startTime).getTime();
  const currentDayItems = todayIssue
    ? unique.filter(item => {
        const time = Date.parse(item.publishedAt);
        return Number.isFinite(time) && time >= dayStart;
      })
    : unique;
  const selected = (todayIssue ? currentDayItems : unique).slice(0, 14);
  if (!selected.length) {
    throw new Error(todayIssue
      ? "오늘 확인할 수 있는 뉴스 검색 결과가 없습니다. 잠시 후 다시 시도해 주세요."
      : "해당 키워드의 뉴스 검색 결과가 없습니다. 다른 표현으로 다시 입력해 주세요.");
  }
  return selected;
}

function formatNewsResearch(items) {
  return items.map((item, index) => {
    const date = item.publishedAt ? new Date(item.publishedAt) : null;
    const time = date && !Number.isNaN(date.getTime())
      ? date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
      : "보도 시각 미확인";
    return [
      (index + 1) + ". " + item.title,
      "언론사: " + (item.source || "출처 표기 없음"),
      "보도 시각: " + time,
      item.description ? "RSS 요약: " + item.description : ""
    ].filter(Boolean).join("\n");
  }).join("\n\n");
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
    const imageRaw = htmlMeta(html, "og:image") || htmlMeta(html, "og:image:secure_url") || htmlMeta(html, "twitter:image");
    let image = "";
    if (imageRaw) {
      try {
        const parsedImage = new URL(imageRaw, url);
        if (["http:", "https:"].includes(parsedImage.protocol) && !parsedImage.username && !parsedImage.password) {
          image = parsedImage.toString();
        }
      } catch (_) {}
    }
    res.json({ ok: true, title: title.slice(0, 240), description: description.slice(0, 700), image });
  } catch (e) {
    res.status(422).json({ error: e.message || "상품 정보를 읽지 못했습니다." });
  }
});

async function fetchPublicImage(rawUrl, redirects = 0) {
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
        "User-Agent": "Mozilla/5.0 (compatible; ProductImagePreview/1.0)",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif"
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= 3) throw new Error("이미지 이동 횟수가 너무 많습니다.");
      const location = response.headers.get("location");
      if (!location) throw new Error("이미지 주소를 확인할 수 없습니다.");
      return await fetchPublicImage(new URL(location, url).toString(), redirects + 1);
    }
    if (!response.ok) throw new Error("상품 사진을 가져오지 못했습니다. (" + response.status + ")");
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
    if (!allowed.includes(type)) throw new Error("지원하지 않는 이미지 형식입니다.");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        response.body.cancel().catch(() => {});
        throw new Error("상품 사진이 10MB를 초과해 가져올 수 없습니다.");
      }
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), type };
  } catch (e) {
    if (e.name === "AbortError") throw new Error("상품 사진을 가져오는 시간이 초과됐습니다.");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/api/product-image", async (req, res) => {
  const raw = cleanText(req.query.url, 3000);
  if (!raw) return res.status(400).json({ error: "이미지 주소가 없습니다." });
  try {
    const result = await fetchPublicImage(raw);
    const extension = ({
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
      "image/gif": "gif", "image/avif": "avif"
    })[result.type] || "jpg";
    const download = req.query.download === "1";
    res.setHeader("Content-Type", result.type);
    res.setHeader("Content-Length", result.buffer.length);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", (download ? "attachment" : "inline") + '; filename="product-image.' + extension + '"');
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(result.buffer);
  } catch (e) {
    res.status(422).json({ error: e.message || "상품 사진을 가져오지 못했습니다." });
  }
});

function safeThreadsEndpoint(rawUrl) {
  try { return new URL(rawUrl).pathname; }
  catch (_) { return "Threads API"; }
}

async function threadsRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    const error = new Error("Threads API 연결 실패: " + (cause.message || "네트워크 오류"));
    error.threadsApi = {
      endpoint: safeThreadsEndpoint(url),
      transportError: cause.name || "NetworkError"
    };
    throw error;
  }

  const rawBody = await response.text().catch(() => "");
  let data = {};
  try { data = rawBody ? JSON.parse(rawBody) : {}; }
  catch (_) { data = {}; }

  if (!response.ok || data.error) {
    const apiError = data.error && typeof data.error === "object" ? data.error : {};
    const error = new Error(
      apiError.message ||
      data.error_description ||
      (rawBody.slice(0, 300) || "Threads API 요청 실패 (" + response.status + ")")
    );
    error.threadsApi = {
      httpStatus: response.status,
      endpoint: safeThreadsEndpoint(url),
      code: apiError.code ?? data.code ?? null,
      errorSubcode: apiError.error_subcode ?? data.error_subcode ?? null,
      type: apiError.type ?? data.type ?? null,
      fbtraceId: apiError.fbtrace_id ?? data.fbtrace_id ?? null,
      isTransient: apiError.is_transient ?? null,
      userTitle: apiError.error_user_title ?? null,
      userMessage: apiError.error_user_msg ?? null
    };
    throw error;
  }
  return data;
}

async function publish(text, imageSource = "") {
  if (!token()) throw new Error("Railway에 THREADS_ACCESS_TOKEN을 먼저 등록해야 합니다.");
  const base = "https://graph.threads.net/v1.0";
  const me = await threadsRequest(base + "/me?fields=id,username&access_token=" + encodeURIComponent(token()));
  let media = { media_type: "TEXT", text, access_token: token() };
  if (imageSource) {
    const source = validateHttpUrl(imageSource);
    const checked = await fetchPublicImage(source);
    if (!["image/jpeg", "image/png"].includes(checked.type)) {
      throw new Error("Threads 사진 게시에는 JPG 또는 PNG 사진이 필요합니다. 상품 페이지의 대표 사진 형식을 확인해 주세요.");
    }
    const publicImageUrl = "https://threads-ai-automation-production.up.railway.app/api/product-image?url=" + encodeURIComponent(source);
    media = { media_type: "IMAGE", image_url: publicImageUrl, text, access_token: token() };
  }
  const container = await threadsRequest(base + "/" + me.id + "/threads", {
    method: "POST",
    body: new URLSearchParams(media)
  });
  if (imageSource) await waitForThreadContainer(container.id);
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
  const todayDaily = category === "daily" && req.body.todayDaily === true;
  let affiliateLink = "";
  try {
    affiliateLink = validateHttpUrl(cleanText(req.body.affiliateLink, 2000));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const subject = productName || topic;
  if (!subject && !todayIssue && !todayDaily) return res.status(400).json({ error: "조사할 키워드나 주제를 입력해 주세요." });
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
  let newsResearch = [];
  if (category === "daily" && !todayDaily) {
    try {
      newsResearch = await gatherNewsResearch(subject, todayIssue);
    } catch (e) {
      return res.status(502).json({ error: "뉴스 조사 실패: " + e.message });
    }
  }
  const researchText = newsResearch.length ? formatNewsResearch(newsResearch) : "";

  const prompt = [
    category === "daily"
      ? (todayDaily ? "한국어 Threads(스레드)에 올릴 친근하고 공감 가는 일상 수다 글을 작성해." : "한국어 Threads(스레드)에 올릴 사실 기반 일상·정보 게시글을 작성해.")
      : "한국어 Threads(스레드)에 올릴 상품 소개 글을 작성해.",
    category === "daily" ? "오늘 날짜(대한민국 서울 기준): " + today : "",
    researchText ? "실시간 뉴스 조사 자료:\n" + researchText : "",
    category === "daily" && todayIssue
      ? "주제 선택: 아래 Google 뉴스의 주요 기사 목록에서 오늘 대한민국에서 널리 보도되는 뉴스·사건·사회 이슈를 골라라. 여러 언론사가 함께 다룬 사안을 우선하되 객관적으로 확인할 수 없는 인기 순위는 단정하지 마라."
      : "",
    category === "daily" && !todayIssue && !todayDaily
      ? "조사할 키워드: " + subject + ". 아래 Google 뉴스 검색 결과를 바탕으로 이 키워드가 가리키는 사건·이슈가 무엇인지 정리해라. 보도 날짜와 여러 언론사의 공통 사실을 확인하고 검색 결과에 없는 세부 내용은 추측하지 마라."
      : "",
    category === "daily" && !todayDaily
      ? "아래 기사 목록의 제목·언론사·보도 시각·요약을 조사 자료로 사용해라. 오래된 사건을 오늘 발생한 것처럼 쓰지 마라. 여러 언론사의 보도에서 공통으로 확인되는 사실만 단정하고 확인되지 않은 숫자·인명·장소·원인·피해 규모는 만들지 마라. 요약에 없는 원인이나 경과는 추측하지 말고 확인 가능한 범위에서 설명해라. 기사 제목을 베끼지 마라."
      : "",
    category === "daily" && !todayDaily
      ? "문체는 뉴스 기사나 방송 앵커의 보도처럼 쓰지 마. '전해졌습니다', '밝혔습니다', '보도됐습니다' 같은 딱딱한 기사체와 사실을 시간순으로 나열하는 방식은 피하고, 친구에게 이 이슈의 내용을 쉽게 알려주듯 자연스럽게 풀어 설명해. 무슨 일이거나 어떤 내용인지, 왜 관심을 받고 있는지, 우리에게 어떤 의미가 있는지를 쉬운 말로 전달해. 확인된 사실과 추측은 분명히 구분해."
      : "",
    category === "daily" && !todayDaily
      ? "댓글 참여 유도: 정확히 2단락으로 쓰고, 두 번째 단락의 마지막 문장은 해당 이슈와 직접 관련된 자연스러운 질문으로 끝내. 독자가 자기 생각이나 경험을 댓글로 나눌 수 있는 열린 질문을 해. '여러분 생각은 어떠세요?'만 기계적으로 덧붙이지 말고, 글 내용을 읽어야 답할 수 있는 구체적인 질문을 만들어. 질문을 위해 사실을 왜곡하거나 특정 의견을 강요하지 마."
      : "",
    category === "toss" ? "상품명 또는 주제: " + subject : "",
    pageTitle ? "링크 페이지 제목: " + pageTitle : "",
    pageDescription ? "링크 페이지 설명: " + pageDescription : "",
    "게시물 유형: " + (category === "toss" ? "토스 쉐어링크 상품 소개" : "일상/정보 게시글"),
    "말투 설정: " + tone,
    "최우선 글쓰기 스타일: 대한민국 상위권 Threads 전문 카피라이터처럼 써. 독자가 스크롤을 멈추고 끝까지 읽고 싶도록 작성해. 친구에게 직접 이야기하듯 편하고 자연스러운 반말을 기본으로 하고, 딱딱한 설명문·교과서체·과하게 정돈된 AI 말투·뻔한 서론은 절대 쓰지 마. 첫 문장은 반드시 호기심, 공감, 놀라움, 반전 중 주제에 맞는 요소를 활용한 강한 후킹으로 시작해. '와..', '미쳤다', '진짜 소름 돋는 건', '근데 더 놀라운 건', '왜 이게 중요하냐면' 같은 구어체는 문맥에 맞을 때만 자연스럽게 섞고 억지로 반복하지 마. 실제 사람이 흥분하거나 놀라서 이야기하는 듯 생동감 있게 쓰되 과장하거나 사실을 부풀리지 마. 짧고 리듬감 있는 문장과 자연스러운 줄바꿈으로 읽기 쉽게 만들고, 한 문장에 너무 많은 정보를 넣지 마. 구체적인 숫자와 사례는 조사 자료나 확인된 정보에 있을 때만 활용해. 다음 문장이 궁금해지는 흐름을 만들고, 마지막에는 주제에 맞게 독자의 생각이나 경험을 묻거나 저장·공유 등 자연스러운 참여를 유도해. 모든 글을 같은 패턴으로 찍어내지 말고 주제에 맞게 분위기와 표현을 바꿔. 예시 표현은 말투와 리듬만 참고하고 문장이나 구성을 복제하지 마. 이모지는 최대 3개까지만 사용하고, 마크다운 굵은 글씨와 제목 문법은 사용하지 마.",
    "출력 형식 우선 규칙: 사용자가 정한 기존 형식을 유지해. 본문은 반드시 정확히 2단락으로 작성하고, 각 단락은 줄바꿈 기준 최대 3줄(1~3줄)로 제한해. 한 줄에는 짧은 문장 하나만 넣고, 문장이 길면 자연스럽게 나눠 써. 4~9개 번호 목록이나 소제목은 사용하지 마. 두 단락 사이에는 빈 줄을 하나 넣어. 두 단락이라는 형식 외에는 주제에 따라 표현과 전개를 유연하게 바꿔.",
    category === "daily"
      ? (todayDaily ? "친구와 가볍게 수다 떨듯 자연스럽고 편하게 써. 소소한 일상에서 누구나 공감할 만한 순간, 귀찮음, 날씨, 잠, 식사, 주말, 집안일 같은 소재를 하나 골라 이야기해. 과장된 감정이나 억지 교훈은 피하고, 실제 작성자의 개인 경험인 것처럼 특정 경험을 지어내지는 마. ㅋㅋ, ㅠㅠ 같은 표현은 자연스러울 때만 사용해."
        : "말투는 친구에게 알려주듯 자연스럽고 이해하기 쉽게. 사실을 가볍게 왜곡하거나 선정적으로 과장하지 마.")
      : "핵심 말투는 친구에게 수다 떨듯 편하고 생생한 생활형 후기 스타일이야. 딱딱한 광고 문구나 쇼핑몰 상세페이지 말투는 쓰지 마.",
    category === "toss"
      ? "예시의 문체 특징을 적용해: '이런 거 숨겨두는 게 국룰인 거 알지? ㅋㅋ'처럼 일상 공감으로 시작하고, 상품을 발견한 순간의 반응을 자연스럽게 말한 다음, 확인된 특징을 감각적이고 구체적인 표현으로 풀어줘."
      : "",
    category === "toss"
      ? "짧은 문장과 줄바꿈으로 리듬을 만들고, 중간중간 '진짜 요물임', '장난 아님', '나도 모르게 눈길 감', 'ㅠㅠ', 'ㅋㅋ' 같은 구어체 반응을 과하지 않게 섞어줘."
      : "",
    category === "toss" ? "마무리는 친구에게 이야기하듯 가벼운 농담이나 솔직한 한마디로 끝내." : "첫 단락은 관심을 끄는 핵심 요약, 두 번째 단락은 확인된 사실과 배경 및 독자에게 중요한 점으로 마무리해.",
    todayDaily ? "억지스럽지 않은 일상 수다 글로 작성하고, 독자에게 말을 거는 듯한 자연스러운 호흡을 유지해." : "",
    "게시글은 반드시 정확히 2개의 단락으로만 작성해. 각 단락은 줄바꿈 기준 최대 3줄이야. 한 줄에 짧은 문장 하나씩 배치하고, 4줄 이상 절대 쓰지 마. 단락 사이에는 빈 줄을 하나만 넣어. 소제목, 번호, 목록은 쓰지 마.",
    "첫 번째 단락은 스크롤을 멈추게 하는 후킹 문장으로 시작하고, 두 번째 단락은 확인된 사실이나 상품 특징과 핵심 의미를 자연스럽게 설명하며 마무리해.",
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
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = data.error?.message || "Gemini 요청 실패 (" + r.status + ")";
        if (r.status === 429 && /quota|resource_exhausted|billing|rate limit/i.test(detail)) {
          throw new Error("Gemini API 할당량 또는 요청 한도 초과입니다. Google AI Studio의 프로젝트별 사용량·결제 상태를 확인해 주세요. (" + detail + ")");
        }
        if (r.status === 503 || r.status === 504) {
          throw new Error("Gemini 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요. (" + detail + ")");
        }
        if (r.status === 429) {
          throw new Error("Gemini 요청이 너무 빠릅니다. 잠시 기다렸다 다시 시도해 주세요. (" + detail + ")");
        }
        throw new Error(detail);
      }
      generated = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "";
      if (!generated) throw new Error("AI가 글을 생성하지 못했습니다.");
      mode = "AI (" + GEMINI_MODEL + (category === "daily" ? (todayDaily ? " · 오늘의 일상" : " · Google 뉴스 조사 " + newsResearch.length + "건") : "") + ")";
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

  generated = exactlyTwoParagraphs(generated);

  const commentParts = [];
  if (category === "toss") {
    commentParts.push("상품 링크\n" + [affiliateLink, affiliateLink, affiliateLink].join("\n"));
    commentParts.push(DISCLOSURES.toss);
  }

  res.json({
    text: generated.trim(),
    commentText: commentParts.join("\n\n"),
    mode,
    category,
    productName: subject || (todayDaily ? "오늘의 일상" : "오늘의 이슈"),
    researchCount: newsResearch.length,
    links: { affiliateLink }
  });
});

app.post("/api/publish", async (req, res) => {
  const text = cleanText(req.body.text, 5000);
  const commentText = cleanText(req.body.commentText, 2000);
  const category = ["toss", "daily"].includes(req.body.category) ? req.body.category : "daily";
  const imageSource = cleanText(req.body.imageSource, 3000);
  if (!text) return res.status(400).json({ error: "게시글 내용을 입력해 주세요." });
  try {
    const result = await publish(text, imageSource);
    let replyId = null;
    let commentStatus = commentText ? "댓글 등록 대기" : "댓글 없음";
    let commentError = "";
    let commentDiagnostic = null;
    if (commentText) {
      try {
        replyId = await publishReply(commentText, result.id);
        commentStatus = "댓글 게시 완료";
      } catch (e) {
        commentStatus = "댓글 등록 실패";
        commentError = e.message;
        commentDiagnostic = e.threadsApi || null;
      }
    }
    const createdAt = new Date().toISOString();
    const post = {
      id: result.id, text, username: result.username, category, imageAttached: Boolean(imageSource),
      status: "게시 완료", commentStatus, commentText, replyId, createdAt
    };
    store.posts.unshift(post);
    save();
    res.json({
      ok: true, post, commentPosted: Boolean(replyId), commentError, commentDiagnostic
    });
  } catch (e) {
    const diagnostic = e.threadsApi || null;
    console.error("Threads publish failed:", JSON.stringify({
      message: e.message,
      diagnostic
    }));
    res.status(400).json({ error: e.message, diagnostic });
  }
});

app.post("/api/schedule", (req, res) => {
  const text = cleanText(req.body.text, 5000);
  const commentText = cleanText(req.body.commentText, 2000);
  const category = ["toss", "daily"].includes(req.body.category) ? req.body.category : "daily";
  const imageSource = cleanText(req.body.imageSource, 3000);
  const at = new Date(req.body.at);
  if (!text) return res.status(400).json({ error: "게시글 내용을 먼저 작성해 주세요." });
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return res.status(400).json({ error: "미래 시간을 선택해 주세요." });
  const item = {
    id: String(Date.now()) + Math.random().toString(16).slice(2),
    text, commentText, category, imageSource, at: at.toISOString(), status: "예약 대기"
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
      const result = await publish(item.text, item.imageSource || "");
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
        category: item.category || "daily", imageAttached: Boolean(item.imageSource),
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