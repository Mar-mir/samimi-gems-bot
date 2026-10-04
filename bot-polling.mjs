#!/usr/bin/env node
// Local polling fallback (same pattern as samimi-markdown-bot/bot-polling-v2.mjs).
// Reads secrets from env: TOKEN, NARA_KEY (never hardcode).
//   TOKEN=xxx NARA_KEY=yyy node bot-polling.mjs
const TOKEN = process.env.TOKEN;
const NARA_KEY = process.env.NARA_KEY;
if (!TOKEN || !NARA_KEY) { console.error("Set TOKEN and NARA_KEY env first"); process.exit(1); }
const API = `https://api.telegram.org/bot${TOKEN}`;

const workerMod = await import("./src/worker.js");
const worker = workerMod.default;

const memKV = new Map();
const env = {
  TOKEN,
  NARA_KEY,
  NARA_BASE: process.env.NARA_BASE || "https://router.bynara.id/v1",
  MODEL: process.env.MODEL || "nemotron-3.5-lightning-free",
  ALLOWED_USER_ID: process.env.ALLOWED_USER_ID || "93255700",
  GEMS_KV: {
    async get(k) { return memKV.has(k) ? memKV.get(k) : null; },
    async put(k, v) { memKV.set(k, v); },
    async delete(k) { memKV.delete(k); },
  },
};

let offset = 0;
console.log(`samimi Gems polling (nara) — ${new Date().toISOString()}`);
try {
  const r = await fetch(`${API}/deleteWebhook?drop_pending_updates=false`);
  console.log("deleteWebhook:", (await r.text()).slice(0, 200));
} catch (e) { console.log("deleteWebhook err", e.message); }

while (true) {
  try {
    const r = await fetch(`${API}/getUpdates?offset=${offset}&timeout=25`);
    const j = await r.json();
    if (!j.ok) { console.log("getUpdates", JSON.stringify(j).slice(0, 300)); await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const upd of j.result || []) {
      offset = upd.update_id + 1;
      const req = new Request("https://polling.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(upd) });
      try { await worker.fetch(req, env, { waitUntil: (p) => p.catch(() => {}) }); }
      catch (e) { console.log("handle err", e.stack?.slice(0, 500) || e.message); }
    }
  } catch (e) { console.log("loop err", e.message); await new Promise((r) => setTimeout(r, 3000)); }
}
