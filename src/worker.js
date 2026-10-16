/**
 * samimi Gems — personal Telegram bot (Cloudflare Workers)
 * Like Google Gemini Gems: saved system-prompts ("gems") + chat with byNara router free models.
 * Single-user: only ALLOWED_USER_ID may use it.
 *
 * Secrets (never hardcode): TOKEN, NARA_KEY
 * Vars: NARA_BASE (default https://router.bynara.id/v1), MODEL, ALLOWED_USER_ID
 * KV binding: GEMS_KV
 * Free-model list auto-refresh: GET /refresh-models (cron weekly) -> KV models:<free ids>
 */

const NARA_MODELS_URL = "/models";
const MODELS_CACHE_TTL = 6 * 24 * 3600 * 1000; // 6 days, refreshed weekly by cron

const DEFAULT_MODEL = "nemotron-3.5-lightning-free";
const MAX_HISTORY = 20;          // messages kept (user+assistant)
const MAX_INSTRUCTION = 6000;    // chars per gem instruction
const MAX_KNOWLEDGE = 6000;      // chars extra file context per gem
const STALE_BUF_MS = 120 * 1000; // buffer older than this = separate earlier message, flush alone
const FIRST_WAIT_MS = 2000;      // single msg: wait this long for a possible 2nd part
const LONG_FIRST_WAIT_MS = 6000; // near-limit chunk (>=3500 chars): likely a split, wait longer
const LONG_HINT = 3500;          // Telegram splits at ~4096, so part 1 of a split is always huge
const SECOND_WAIT_MS = 1500;     // 2nd+ part arrived: answer shortly after
const GRACE_MS = 700;            // propagation grace before starting a fresh buffer

function naraBase(env) { return (env.NARA_BASE || "https://router.bynara.id/v1").replace(/\/+$/, ""); }
function isFreeModel(m) {
  if (!m || !m.id) return false;
  if (/video/i.test(m.id)) return false; // video-only models reject text chat
  if (/free/i.test(m.id)) return true;
  const inp = Number(m.input_idr_per_1k ?? m.input_price ?? NaN);
  const out = Number(m.output_idr_per_1k ?? m.output_price ?? NaN);
  return inp === 0 && out === 0;
}
// Static bootstrap (works with zero KV); refreshed+validated weekly into KV by /refresh-models or cron.
// Order = user's combo first, then proven fallbacks. Known-bad excluded: jev (400),
// mimo-v2.6-flash-free + muse-spark-1.3-contributor-free (403 on this key), *-video-* (text rejected).
const FALLBACK_MODELS = [
  "mimo-v2.5-free",
  "muse-spark-1.2-contributor",
  "nemotron-3.5-lightning-free",
  "laguna-s-2.1",
  "space-bunny-alpha",
  "ling-3.0-flash-sante-free",
  "nemotron-3-super-free",
  "nemotron-3-ultra-free",
  "space-bunny-alpha-bynara",
  "ling-3.0-flash-fin-free",
];
function model(env) { return (env.MODEL || DEFAULT_MODEL).trim(); }
function allowedId(env) { return String(env.ALLOWED_USER_ID || "93255700").trim(); }

// ---------- answer constraints (hard-enforced, model can't override) ----------
function maxCharsFromInstruction(instr) {
  const s = String(instr || "");
  const nums = [];
  let m;
  const re1 = /(\d{2,4})\s*(characters|chars|حرف|کاراکتر)/gi;
  while ((m = re1.exec(s))) nums.push(Number(m[1]));
  const re2 = /(?:never exceed|max(?:imum)?|up to|upto|زیر|حداکثر)\D{0,20}(\d{2,4})/gi;
  while ((m = re2.exec(s))) nums.push(Number(m[1]));
  if (!nums.length) return 0;
  return Math.min(...nums);
}
function sanitizeAnswer(text, instruction) {
  let s = String(text || "").replace(/\r/g, "").trim();
  const instr = String(instruction || "");
  if (/only lowercase/i.test(instr)) s = s.toLowerCase();
  // short-reply gems: plain words only — strip math/dash symbols that models sneak in
  if (maxCharsFromInstruction(instr) > 0) {
    s = s.replace(/[><+]/g, " ");
    s = s.replace(/[–—−‐‑]/g, " ");
    s = s.replace(/-/g, " ");
    s = s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (/no emojis/i.test(instr)) {
    s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "").replace(/[ \t]{2,}/g, " ").trim();
  }
  const max = maxCharsFromInstruction(instr);
  if (max > 0 && s.length > max) {
    let cut = s.slice(0, max);
    // prefer a complete sentence: cut at last . ! ? inside the limit
    const lastEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (lastEnd >= Math.floor(max * 0.4)) {
      s = cut.slice(0, lastEnd + 1).trim();
    } else {
      const lastSpace = cut.lastIndexOf(" ");
      if (lastSpace >= Math.floor(max * 0.55)) cut = cut.slice(0, lastSpace);
      s = cut.trim();
    }
  }
  return s;
}

// ---------- Telegram ----------
async function tg(token, method, payload, isForm = false) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, isForm
    ? { method: "POST", body: payload }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.log(`TG ${method} failed`, JSON.stringify(j).slice(0, 500));
  return j;
}
// ---------- one-tap copy (Telegram CopyTextButton; answer text untouched, only a button row added) ----------
const COPY_LIMIT = 250; // CopyTextButton.text max is 256 chars — stay safe
function copyKeyboardFor(text) {
  const t = String(text || "");
  if (!t.trim()) return undefined;
  const parts = [];
  let s = t;
  while (s.length > COPY_LIMIT) {
    let i = s.lastIndexOf("\n", COPY_LIMIT);
    if (i < 60) i = COPY_LIMIT;
    const head = s.slice(0, i);
    if (head.trim()) parts.push(head);
    s = s.slice(i);
  }
  if (s.trim()) parts.push(s);
  if (!parts.length) return undefined;
  if (parts.length === 1) {
    return { inline_keyboard: [[{ text: "📋 کپی", copy_text: { text: parts[0] } }]] };
  }
  // long answer: numbered copy buttons, 4 per row
  const rows = [];
  let row = [];
  parts.forEach((p, idx) => {
    row.push({ text: `📋 ${idx + 1}/${parts.length}`, copy_text: { text: p } });
    if (row.length === 4) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}
async function sendLong(token, chatId, text, extra = {}) {
  const chunks = [];
  let s = String(text || "");
  if (!s.trim()) s = "…";
  while (s.length > 4000) {
    let i = s.lastIndexOf("\n", 4000);
    if (i < 1000) i = 4000;
    chunks.push(s.slice(0, i));
    s = s.slice(i);
  }
  chunks.push(s);
  for (const c of chunks) {
    const kb = copyKeyboardFor(c);
    let res = await tg(token, "sendMessage", { chat_id: chatId, text: c, disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}), ...extra });
    if (kb && !res.ok) {
      // older client / API hiccup: retry as plain message so the answer is never lost
      await tg(token, "sendMessage", { chat_id: chatId, text: c, disable_web_page_preview: true, ...extra });
    }
  }
}

// ---------- KV store ----------
function memKV() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}
function kv(env) { return env.GEMS_KV || memKV(); }
const kGems = (u) => `gems:${u}`;
const kGem = (u, n) => `gem:${u}:${n.toLowerCase()}`;
const kActive = (u) => `active:${u}`;
const kHist = (u) => `hist:${u}`;
const kPending = (u) => `pending:${u}`;
const kBuf = (u) => `buf:${u}`;
const kLastModel = (u) => `lastmodel:${u}`;

async function loadJson(store, key, fb) {
  try {
    const v = await store.get(key);
    if (!v) return fb;
    return JSON.parse(v);
  } catch { return fb; }
}
async function getGemNames(store, u) {
  const custom = await loadJson(store, kGems(u), []);
  const out = [...custom];
  for (const n of Object.keys(BUILT_IN_GEMS)) if (!out.map((x) => x.toLowerCase()).includes(n.toLowerCase())) out.push(n);
  return out;
}
async function getGem(store, u, name) {
  const custom = await loadJson(store, kGem(u, name), null);
  if (custom) return custom;
  const key = Object.keys(BUILT_IN_GEMS).find((k) => k.toLowerCase() === String(name || "").toLowerCase());
  return key ? BUILT_IN_GEMS[key] : null;
}
async function saveGem(store, u, name, gem) {
  await store.put(kGem(u, name), JSON.stringify(gem));
  const names = await getGemNames(store, u);
  if (!names.map((x) => x.toLowerCase()).includes(name.toLowerCase())) {
    names.push(name);
    await store.put(kGems(u), JSON.stringify(names));
  }
}
async function delGem(store, u, name) {
  await store.delete(kGem(u, name));
  const names = (await getGemNames(store, u)).filter((x) => x.toLowerCase() !== name.toLowerCase());
  await store.put(kGems(u), JSON.stringify(names));
  const act = await store.get(kActive(u));
  if (act && act.toLowerCase() === name.toLowerCase()) await store.delete(kActive(u));
}
function validName(n) {
  const s = (n || "").trim();
  return s.length >= 1 && s.length <= 32 && !/[\n\r|]/.test(s) && !s.startsWith("/");
}

// Built-in gem (survives restarts, works before KV is set up)
const BUILT_IN_GEMS = {
  "reply guy ✍️": {
    instruction: `Role:

You are my Twitter reply assistant.
Language & vibe

Always reply in English.

Tone must be friendly, casual, and naturally bullish.

Sound like a real crypto Twitter user, not an assistant.

Replies can be imperfect, relaxed, and conversational.
Length rules

Each reply must be 85 characters max.

Never exceed 85 characters. One single short complete sentence, never cut off mid-sentence.

If the reply feels stiff, shorten it instead of formalizing it.
Style rules

Use contractions like: we're, it's, that's, can't.

Short reactions are allowed.

Light confidence, subtle hype, natural flow.

No filler, no explanations.
Content rules

Stay fully on-topic with the project.

Use uploaded project docs as source of truth.

No links unless asked.
Emoji rule

No emojis at all.
Formatting rules

Do not overuse em dashes.

Avoid emoji-heavy formatting.

Use only lowercase letters. Never use capital letters or caps lock.

Forbidden words & phrases

Never use these words, phrases, or close variants:
Exactly

fact

huge

game changer

Finally

This is the kind

No noise, no hype, just X

Let's talk about

In an ever-changing world

Paradigm shift

Let's dive in

Buzzwords

Chaos

Matters

Shift

Real

Feels

Feels like

Unlock
If unsure, choose the most natural, tweet-like wording.`,
    knowledge: "",
  },
};

const HELP = `🤖 *راهنما — samimi Gems*

/newgem اسم | دستور — ساخت دستیار جدید
(یا فقط: /newgem اسم — بعد دستورش رو بفرست)
/mygems — لیست دستیارها
/use اسم — انتخاب دستیار فعال
/delgem اسم — حذف دستیار
/reset — پاک کردن حافظه مکالمه
/model — دیدن مدل فعلی
/help — همین راهنما

📎 فایل .txt / .md بفرستی به دانش دستیار فعال اضافه میشه.
💬 هر پیام عادی = چت با دستیار فعال، با مدل‌های رایگان نارا.`;

const START = `✨ *samimi Gems* — دستیارهای شخصی تو

مثل Gemهای جمینای: یک بار دستور هر دستیار رو تعریف کن، بعد هر بار باهاش حرف بزن.

مثال:
/newgem مربی‌زبان | تو مربی زبان انگلیسی منی. کوتاه جواب بده، اشتباهام رو اصلاح کن، فارسی توضیح بده.

بعد هر پیامی بفرستی با همین شخصیت جواب میده.

${HELP}`;

// ---------- OpenRouter ----------
// Known-bad on this key (re-validated on each refresh; excluded from chain even if listed free)
const EXCLUDE_MODELS = new Set([
  "jev",
  "mimo-v2.6-flash-free",
  "muse-spark-1.3-contributor-free",
]);
// Fetch fresh free-model ids from Nara router; store in KV with timestamp
async function refreshFreeModels(env, store) {
  const key = env.NARA_KEY;
  if (!key) throw new Error("NARA_KEY not set");
  const r = await fetch(`${naraBase(env)}${NARA_MODELS_URL}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const j = await r.json().catch(() => ({}));
  const list = j?.data || [];
  if (!r.ok || !Array.isArray(list) || !list.length) throw new Error("model list fetch failed");
  const free = list.filter(isFreeModel).map((m) => m.id).filter((id) => !EXCLUDE_MODELS.has(id));
  if (!free.length) throw new Error("no free models found");
  await store.put("models:free", JSON.stringify({ ids: free, updatedAt: Date.now() }));
  return free;
}
async function freeModels(env, store) {
  try {
    const raw = await store.get("models:free");
    if (raw) {
      const cached = JSON.parse(raw);
      if (Array.isArray(cached.ids) && cached.ids.length && Date.now() - (cached.updatedAt || 0) < MODELS_CACHE_TTL) {
        return cached.ids;
      }
    }
  } catch {}
  // stale/missing -> try live refresh, else static bootstrap
  try {
    if (env.NARA_KEY) return await refreshFreeModels(env, store);
  } catch (e) { console.log("refresh fail", e?.message); }
  return FALLBACK_MODELS;
}
function modelsToTryFromList(primary, freeList) {
  const seen = new Set();
  const out = [];
  for (const m of [primary, ...freeList, ...FALLBACK_MODELS]) {
    if (m && !seen.has(m) && !EXCLUDE_MODELS.has(m)) { seen.add(m); out.push(m); }
  }
  return out;
}

async function askNara(env, store, system, history, userText, maxTokens = 0) {
  const msgs = [{ role: "system", content: system }];
  for (const m of history.slice(-12)) msgs.push(m);
  msgs.push({ role: "user", content: userText });
  const free = await freeModels(env, store);
  const chain = modelsToTryFromList(model(env), free);
  console.log("chain:", chain.join(","));
  let lastErr = null;
  const bodyBase = { messages: msgs, temperature: 0.8 };
  if (maxTokens > 0) bodyBase.max_tokens = maxTokens;
  for (const m of chain) {
    const t0 = Date.now();
    try {
      console.log("try", m);
      const r = await fetch(`${naraBase(env)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.NARA_KEY}`,
        },
        body: JSON.stringify({ model: m, ...bodyBase }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { lastErr = new Error(j?.error?.message || j?.message || `Nara HTTP ${r.status}`); console.log("fail", m, r.status, String(lastErr.message).slice(0, 120)); continue; }
      const text = j?.choices?.[0]?.message?.content?.trim();
      if (!text) { lastErr = new Error("پاسخ خالی از مدل"); console.log("fail", m, "empty"); continue; }
      console.log("ok", m, Date.now() - t0, "ms");
      return { text, model: m };
    } catch (e) { lastErr = e; console.log("err", m, e?.message?.slice(0, 120)); }
  }
  throw lastErr || new Error("همه مدل‌ها خطا دادند");
}

// ---------- multi-part bundling ----------
// Telegram caps one message (~4096 chars); long tweets arrive as 2 rapid messages.
// Debounce normal chat: collect rapid parts, then answer once.
async function answerChat(env, token, store, chatId, u, fullText) {
  let act = await store.get(kActive(u));
  if (!act) {
    const names = await getGemNames(store, u);
    act = names[0] || null;
    if (act) await store.put(kActive(u), act);
  }
  if (!act) { await tg(token, "sendMessage", { chat_id: chatId, text: "اول یه دستیار بساز:\n/newgem اسم | دستور" }); return; }
  const g = await getGem(store, u, act);
  if (!g) { await tg(token, "sendMessage", { chat_id: chatId, text: `❌ دستیار «${act}» پیدا نشد. /mygems رو ببین.` }); return; }
  const system = g.instruction + (g.knowledge ? `\n\n[دانش ضمیمه]:\n${g.knowledge}` : "");
  const hardMax = maxCharsFromInstruction(g.instruction);
  const systemHard = hardMax > 0
    ? system + `\n\n[HARD RULE — must obey]: the entire reply must be a complete thought of ${hardMax} characters or fewer (including spaces). Write short enough to finish the sentence inside the limit — never trail off mid-sentence. Plain words only: never use > < + - or em dashes.`
    : system;
  const hist = await loadJson(store, kHist(u), []);
  try {
    await tg(token, "sendChatAction", { chat_id: chatId, action: "typing" });
    const { text: rawAnswer, model: usedModel } = await askNara(env, store, systemHard, hist, fullText, hardMax > 0 ? Math.ceil(hardMax / 2) : 0);
    try { await store.put(kLastModel(u), usedModel); } catch {}
    const answer = sanitizeAnswer(rawAnswer, g.instruction) || rawAnswer.slice(0, hardMax > 0 ? hardMax : 4000);
    hist.push({ role: "user", content: fullText.slice(0, 2000) }, { role: "assistant", content: answer.slice(0, 4000) });
    await store.put(kHist(u), JSON.stringify(hist.slice(-MAX_HISTORY)));
    await sendLong(token, chatId, answer);
  } catch (e) {
    await tg(token, "sendMessage", { chat_id: chatId, text: `❌ خطا: ${e.message?.slice(0, 300) || e}` });
  }
}

// ---------- update handler ----------
async function handleUpdate(update, env) {
  const token = env.TOKEN;
  const store = kv(env);
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const fromId = String(msg.from?.id ?? chatId);
  if (fromId !== allowedId(env)) {
    await tg(token, "sendMessage", { chat_id: chatId, text: "🔒 این ربات شخصیه و فقط مالک داره باهاش کار میکنه." });
    return;
  }
  const u = fromId;
  const raw = (msg.text || msg.caption || "").trim();

  // file -> knowledge for active gem (or pending new gem)
  if (msg.document) {
    try {
      const fname = msg.document.file_name || "file.txt";
      if (!/\.(txt|md|markdown)$/i.test(fname)) {
        await tg(token, "sendMessage", { chat_id: chatId, text: "❌ فقط فایل .txt / .md قبول میکنم." });
        return;
      }
      const gf = await tg(token, "getFile", { file_id: msg.document.file_id });
      if (!gf.ok) throw new Error("getFile");
      const fr = await fetch(`https://api.telegram.org/file/bot${token}/${gf.result.file_path}`);
      let txt = (await fr.text()).slice(0, MAX_KNOWLEDGE);
      if (!txt.trim()) throw new Error("empty");
      const pending = await store.get(kPending(u));
      if (pending) {
        await saveGem(store, u, pending, { instruction: txt.slice(0, MAX_INSTRUCTION), knowledge: "", updatedAt: Date.now() });
        await store.delete(kPending(u));
        await store.put(kActive(u), pending);
        await tg(token, "sendMessage", { chat_id: chatId, text: `✅ دستیار *${pending}* از روی فایل ساخته و فعال شد.` });
        return;
      }
      const act = await store.get(kActive(u));
      if (!act) { await tg(token, "sendMessage", { chat_id: chatId, text: "اول با /newgem یه دستیار بساز، بعد فایل بفرست." }); return; }
      const g = (await getGem(store, u, act)) || { instruction: "", knowledge: "" };
      g.knowledge = ((g.knowledge || "") + "\n\n" + txt).slice(-MAX_KNOWLEDGE);
      await saveGem(store, u, act, g);
      await tg(token, "sendMessage", { chat_id: chatId, text: `📎 فایل به دانش *${act}* اضافه شد (${txt.length} حرف).` });
    } catch (e) { await tg(token, "sendMessage", { chat_id: chatId, text: "❌ نتونستم فایل رو بخونم." }); }
    return;
  }
  if (!raw) return;
  const low = raw.toLowerCase();

  if (low === "/start" || low.startsWith("/start ")) {
    await tg(token, "sendMessage", { chat_id: chatId, text: START });
    return;
  }
  if (low === "/help" || low.startsWith("/help ")) {
    await tg(token, "sendMessage", { chat_id: chatId, text: HELP });
    return;
  }
  if (low === "/mygems" || low === "/list") {
    const names = await getGemNames(store, u);
    const act = await store.get(kActive(u));
    if (!names.length) { await tg(token, "sendMessage", { chat_id: chatId, text: "📭 هنوز دستیاری نساختی. با /newgem شروع کن." }); return; }
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: "💎 دستیارها:\n" + names.map((n) => `${act === n ? "▶️" : "·"} ${n}`).join("\n") + `\n\nفعال: ${act || "—"}`,
    });
    return;
  }
  if (low.startsWith("/newgem")) {
    const rest = raw.slice(7).trim();
    if (!rest) { await tg(token, "sendMessage", { chat_id: chatId, text: "مثال:\n/newgem مربی‌زبان | تو مربی زبان انگلیسی منی…" }); return; }
    const bar = rest.indexOf("|");
    const nl = rest.indexOf("\n");
    let name, instr = "";
    if (bar > 0) { name = rest.slice(0, bar).trim(); instr = rest.slice(bar + 1).trim(); }
    else if (nl > 0) { name = rest.slice(0, nl).trim(); instr = rest.slice(nl + 1).trim(); }
    else name = rest.trim();
    if (!validName(name)) { await tg(token, "sendMessage", { chat_id: chatId, text: "❌ اسم باید تا ۳۲ حرف باشه: حروف، عدد، _ و -" }); return; }
    if (instr) {
      await saveGem(store, u, name, { instruction: instr.slice(0, MAX_INSTRUCTION), knowledge: "", updatedAt: Date.now() });
      await store.put(kActive(u), name);
      await tg(token, "sendMessage", { chat_id: chatId, text: `✅ دستیار *${name}* ساخته و فعال شد.` });
    } else {
      await store.put(kPending(u), name);
      await tg(token, "sendMessage", { chat_id: chatId, text: `📝 حالا دستور دستیار *${name}* رو بفرست (یه پیام یا فایل .txt):` });
    }
    return;
  }
  // pending instruction received
  const pending = await store.get(kPending(u));
  if (pending && !raw.startsWith("/")) {
    await saveGem(store, u, pending, { instruction: raw.slice(0, MAX_INSTRUCTION), knowledge: "", updatedAt: Date.now() });
    await store.delete(kPending(u));
    await store.put(kActive(u), pending);
    await tg(token, "sendMessage", { chat_id: chatId, text: `✅ دستیار *${pending}* ساخته و فعال شد. حالا باهاش حرف بزن!` });
    return;
  }
  if (low.startsWith("/use ")) {
    const name = raw.slice(5).trim();
    const names = await getGemNames(store, u);
    const canon = names.find((x) => x.toLowerCase() === name.toLowerCase());
    if (!canon) { await tg(token, "sendMessage", { chat_id: chatId, text: `❌ دستیار «${name}» پیدا نشد. /mygems رو ببین.` }); return; }
    await store.put(kActive(u), canon);
    await tg(token, "sendMessage", { chat_id: chatId, text: `▶️ دستیار فعال: *${canon}*` });
    return;
  }
  if (low.startsWith("/delgem ") || low.startsWith("/del ")) {
    const name = raw.replace(/^\/del(gem)?\s+/i, "").trim();
    await delGem(store, u, name);
    await tg(token, "sendMessage", { chat_id: chatId, text: `🗑️ دستیار «${name}» حذف شد.` });
    return;
  }
  if (low === "/reset") {
    await store.delete(kHist(u));
    await store.delete(kBuf(u));
    await tg(token, "sendMessage", { chat_id: chatId, text: "🧹 حافظه مکالمه پاک شد." });
    return;
  }
  if (low === "/model") {
    const last = await store.get(kLastModel(u)).catch(() => null);
    await tg(token, "sendMessage", { chat_id: chatId, text: `🧠 مدل پیشفرض:\n\`${model(env)}\`${last ? `\n\n✅ آخرین جواب از:\n\`${last}\`` : ""}` });
    return;
  }
  if (raw.startsWith("/")) {
    await tg(token, "sendMessage", { chat_id: chatId, text: HELP });
    return;
  }

  // normal chat with active gem — debounce rapid 2-part messages (long tweets
  // split by Telegram) into ONE answer. Commands above answer immediately.
  // KV-backed (works across Workers isolates): buffer parts under kBuf(u);
  // a generation counter decides which invocation owns the flush.
  const now = Date.now();
  const prRaw = await store.get(kBuf(u));
  let prev = null;
  try { prev = prRaw ? JSON.parse(prRaw) : null; } catch { prev = null; }
  if (!prev || !Array.isArray(prev.parts) || !prev.ts || now - prev.ts > STALE_BUF_MS) prev = null;

  const gen = (prev?.gen || 0) + 1;
  const parts = [...(prev ? prev.parts : []), raw];
  await store.put(kBuf(u), JSON.stringify({ parts, ts: prev ? prev.ts : now, gen }));

  const waitMs = parts.length > 1 ? SECOND_WAIT_MS
    : parts[0].length >= LONG_HINT ? LONG_FIRST_WAIT_MS : FIRST_WAIT_MS;
  await new Promise((r) => setTimeout(r, waitMs));

  const latestRaw = await store.get(kBuf(u));
  let latest = null;
  try { latest = latestRaw ? JSON.parse(latestRaw) : null; } catch { latest = null; }
  if (!latest || latest.gen !== gen) return; // a newer part arrived — it owns the flush

  // grace: one last re-read so a part that landed during our wait isn't missed
  await new Promise((r) => setTimeout(r, GRACE_MS));
  const finalRaw = await store.get(kBuf(u));
  let final = null;
  try { final = finalRaw ? JSON.parse(finalRaw) : null; } catch { final = null; }
  if (final && final.gen !== gen) return;
  if (final && Array.isArray(final.parts) && final.parts.length > latest.parts.length) latest = final;

  const fullText = latest.parts.join("\n").slice(0, 8000);
  await store.delete(kBuf(u));
  console.log(`bundle: ${latest.parts.length} part(s) -> ${fullText.length} chars`);
  await answerChat(env, token, store, chatId, u, fullText);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true, bot: "samimi-gems", model: model(env) }), { headers: { "Content-Type": "application/json" } });
      if (url.pathname === "/refresh-models" || url.pathname === "/models") {
        const store = kv(env);
        try {
          const ids = await refreshFreeModels(env, store);
          return new Response(JSON.stringify({ ok: true, count: ids.length, ids }), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e?.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }
      return new Response(`samimi Gems Bot\nstatus: ${env.TOKEN ? "ready" : "TOKEN missing"} · Nara: ${env.NARA_KEY ? "ok" : "missing"} · KV: ${env.GEMS_KV ? "ok" : "missing"}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (request.method !== "POST") return new Response("OK", { headers: { "Content-Type": "text/plain" } });
    if (!env.TOKEN) return new Response(JSON.stringify({ ok: false, error: "TOKEN not set" }), { status: 500 });
    let update;
    try { update = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
    try {
      const m = update.message || update.edited_message || update.callback_query;
      console.log("upd:", JSON.stringify({ from: m?.from?.id, chat: m?.chat?.id, text: (m?.text || m?.caption || "").slice(0, 80) }));
    } catch {}
    // fast ACK, work in background (LLM can be slow)
    if (ctx?.waitUntil) ctx.waitUntil(handleUpdate(update, env).catch((e) => console.log("bg err", e?.message)));
    else await handleUpdate(update, env);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  },
  async scheduled(event, env, ctx) {
    // weekly cron: refresh cached free-model list
    try {
      const store = kv(env);
      const ids = await refreshFreeModels(env, store);
      console.log(`models refreshed: ${ids.length}`, ids.join(",").slice(0, 300));
    } catch (e) { console.log("cron refresh fail", e?.message); }
  },
};
