/**
 * RiftTome — Riftbound Telegram Card Bot
 */

const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const PILTOVER_BASE = "https://piltoverarchive.com/api/external/v1";
const PA_HEADERS = {
  "User-Agent": "RiftTome/1.0 (Telegram card lookup bot for Riftbound TCG)",
  "Accept": "application/json",
};

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Escape for Telegram MarkdownV2 ──────────────────────────────────────────
function esc(text) {
  if (!text) return "";
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// ─── Replace Riftbound symbol tags with emoji ─────────────────────────────────
function replaceSymbols(text) {
  if (!text) return "";
  return text
    .replace(/:rb_rune_rainbow:/gi, "🔘")
    .replace(/:rb_rune_fury:/gi,    "🔴")
    .replace(/:rb_rune_calm:/gi,    "🟢")
    .replace(/:rb_rune_mind:/gi,    "🔵")
    .replace(/:rb_rune_body:/gi,    "🟠")
    .replace(/:rb_rune_chaos:/gi,   "🟣")
    .replace(/:rb_rune_order:/gi,   "🟡")
    .replace(/:rb_might:/gi,        "💪🏼")
    .replace(/:rb_energy:/gi,       "⚡")
    .replace(/:rb_power:/gi,        "🔋")
    .replace(/:rb_[a-z_0-9]+:/gi,  "");
}

function stripHtml(str) {
  if (!str) return "";
  return str
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// ─── Colour → Domain mapping ──────────────────────────────────────────────────
const COLOUR_TO_DOMAIN = {
  red: "Fury", orange: "Body",
  green: "Calm", teal: "Calm",
  blue: "Mind",
  purple: "Chaos",
  yellow: "Order", gold: "Order",
  white: "Body", grey: "Body", gray: "Body",
};

// ─── Parse [[card name c:colour]] or {{card name c:colour}} ──────────────────
function parseCardQuery(raw) {
  let name = raw.trim();
  let domain = null;

  // Extract c:colour
  const colourMatch = name.match(/\bc:(\w+)/i);
  if (colourMatch) {
    domain = COLOUR_TO_DOMAIN[colourMatch[1].toLowerCase()] ?? null;
    name = name.replace(colourMatch[0], "").trim();
  }

  // Old plain colour word at end e.g. [[Kennen yellow]]
  if (!domain) {
    const words = name.split(/\s+/);
    const last = words[words.length - 1].toLowerCase();
    if (COLOUR_TO_DOMAIN[last]) {
      domain = COLOUR_TO_DOMAIN[last];
      name = words.slice(0, -1).join(" ");
    }
  }

  console.log(`[parse] raw="${raw}" → name="${name.trim()}" domain=${domain}`);
  return { name: name.trim(), domain };
}

// ─── Card lookup cache ────────────────────────────────────────────────────────
const cardCache = new Map();
const CARD_CACHE_TTL = 24 * 60 * 60 * 1000;

function getCachedCard(key) {
  const entry = cardCache.get(key.toLowerCase());
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CARD_CACHE_TTL) { cardCache.delete(key.toLowerCase()); return null; }
  return entry.card;
}

function setCachedCard(key, card) {
  cardCache.set(key.toLowerCase(), { card, fetchedAt: Date.now() });
  if (cardCache.size > 500) cardCache.delete(cardCache.keys().next().value);
}

// ─── Card Lookup (Piltover Archive) ──────────────────────────────────────────
async function lookupCard(rawQuery, forceLegend) {
  const { name, domain } = parseCardQuery(rawQuery);
  const cacheKey = `${name}:${domain ?? ""}:${forceLegend ? "legend" : "unit"}`;

  const cached = getCachedCard(cacheKey);
  if (cached) { console.log(`[lookup] Cache hit: "${cached.card.name}"`); return cached; }

  // Build query params
  const params = new URLSearchParams();
  params.set("name", name);
  params.set("limit", "20");

  // Type filter
  if (forceLegend) {
    params.set("types", "Legend");
  } else {
    params.set("types", "Unit,Spell,Gear,Battlefield,Rune,Token");
  }

  // Domain/colour filter
  if (domain) params.set("colors", domain);

  const url = `${PILTOVER_BASE}/cards?${params.toString()}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[lookup] GET ${url} (attempt ${attempt})`);
      const res = await fetch(url, { headers: PA_HEADERS });
      const text = await res.text();

      if (text.trim().startsWith("<")) {
        console.log(`[lookup] Got HTML, waiting 5s...`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const json = JSON.parse(text);
      console.log(`[lookup] Response: ${JSON.stringify(json).slice(0, 300)}`);

      const variants = json.data;
      if (!variants || variants.length === 0) {
        console.log(`[lookup] No results for "${name}"`);
        return null;
      }

      // Find best matching variant by name similarity
      const nameLower = name.toLowerCase();
      const match = variants.find(v =>
        v.card?.name?.toLowerCase() === nameLower
      ) ?? variants.find(v =>
        v.card?.name?.toLowerCase().includes(nameLower.split(/[\s,]/)[0].toLowerCase())
      ) ?? variants[0];

      console.log(`[lookup] Match: "${match.card?.name}" (${match.variantNumber})`);
      setCachedCard(cacheKey, match);
      return match;
    } catch (err) {
      console.error(`[lookup] Error (attempt ${attempt}): ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
    }
  }

  return null;
}

// ─── Format Money ─────────────────────────────────────────────────────────────
function fmtMoney(amount, symbol) {
  return esc(`${symbol}${amount.toFixed(2)}`);
}

// ─── Build Caption from Piltover Archive variant ──────────────────────────────
function buildCaption(variant, errata) {
  const card = variant.card ?? {};
  const name = card.name ?? "Unknown";
  const type = card.type ?? "";
  const supertype = card.super ?? "";
  const rarity = variant.rarity ?? "";
  const colors = (card.colors ?? []).map(c => c.name).join(", ");
  const energy = card.energy;
  const might = card.might;
  const power = card.power;
  const set = variant.set?.name ?? "";
  const variantLabel = variant.variantLabel ?? "";
  const rawText = replaceSymbols(stripHtml(card.description ?? ""));
  const flavour = card.flavor ?? "";

  const typeLine = [supertype, type].filter(Boolean).join(" ");
  const stats = [
    energy != null ? `⚡ ${energy}` : null,
    might != null ? `💪🏼 ${might}` : null,
    power != null ? `🔋 ${power}` : null,
  ].filter(Boolean).join("  ");

  let caption = `*${esc(name)}*`;
  if (variantLabel) caption += ` _\\(${esc(variantLabel)}\\)_`;
  if (typeLine) caption += `\n_${esc(typeLine)}_`;
  if (rarity || colors) caption += `\n${esc([rarity, colors].filter(Boolean).join(" · "))}`;
  if (stats) caption += `\n${stats}`;
  if (set) caption += `\n📦 ${esc(set)}`;
  if (rawText) caption += `\n\n${esc(rawText.slice(0, 500))}`;
  if (flavour) caption += `\n\n_${esc(flavour.slice(0, 150))}_`;

  // Errata section
  if (errata) {
    caption += `\n\n⚠️ *ERRATA*`;
    caption += `\n~${esc(errata.old.slice(0, 300))}~`;
    caption += `\n\n✅ *Corrected Text:*`;
    caption += `\n*${esc(errata.new.slice(0, 300))}*`;
  }

  // Prices — already in the Piltover Archive response
  const cmPrice = variant.cardmarketPrice;
  const tcgPrice = variant.tcgplayerPrice;

  if (cmPrice || tcgPrice) {
    caption += `\n`;
    if (cmPrice) {
      caption += `\n🌍 Cardmarket: ${fmtMoney(cmPrice, "€")}`;
    }
    if (tcgPrice) {
      caption += `\n💵 TCGPlayer: ${fmtMoney(tcgPrice, "$")}`;
    }
  }

  return caption;
}

// ─── Errata ───────────────────────────────────────────────────────────────────
// PA already includes official errata text on cards — no manual list needed.
function findErrata(_errata, _cardName) { return null; }

// ─── Extract card queries from message ───────────────────────────────────────
function extractCardNames(text) {
  const results = [];
  for (const m of text.matchAll(/\{\{(.+?)\}\}/g)) {
    results.push({ raw: m[1].trim(), forceLegend: true });
  }
  for (const m of text.matchAll(/\[\[(.+?)\]\]/g)) {
    results.push({ raw: m[1].trim(), forceLegend: false });
  }
  return results;
}

// ─── Help Text ────────────────────────────────────────────────────────────────
const HELP_TEXT = [
  "*📖 RiftTome — How to Use*",
  "",
  "*Basic card lookup:*",
  "`\\[\\[Card Name\\]\\]` → Units, Spells, Gears, Champions",
  "`\\{\\{Card Name\\}\\}` → Legend cards",
  "",
  "Example: `\\[\\[Kai'Sa\\]\\]` → Kai'Sa \\(non\\-legend\\)",
  "Example: `\\{\\{Kai'Sa\\}\\}` → Kai'Sa, Daughter of the Void \\(legend\\)",
  "",
  "*Multiple cards in one message:*",
  "`\\[\\[Irelia, Fervent\\]\\] \\[\\[Tianna Crownguard\\]\\]`",
  "",
  "*Filter by colour* \\(champions with multiple domain versions\\)*:*",
  "`\\[\\[Card Name c:colour\\]\\]`",
  "",
  "🔴 `red` → Fury",
  "🟢 `green` → Calm",
  "🔵 `blue` → Mind",
  "🟣 `purple` → Chaos",
  "🟡 `yellow` → Order",
  "🟠 `orange` → Body",
  "",
  "Example: `\\[\\[Kennen c:yellow\\]\\]` → Keeper of Balance",
  "Example: `\\[\\[Kennen c:purple\\]\\]` → Storm of Shuriken",
  "",
  "*Commands:*",
  "`/rthelp` — show this message",
].join("\n");

bot.onText(/\/rthelp/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT, {
    parse_mode: "MarkdownV2",
    reply_to_message_id: msg.message_id,
  }).catch(err => console.error("[rthelp] Error:", err.message));
});

// ─── Message Handler ──────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const text = msg.text ?? "";
  const chatId = msg.chat.id;

  const hasBrackets = /\[\[.+?\]\]|\{\{.+?\}\}/.test(text);
  if (!hasBrackets && !text.startsWith("/rtbot")) return;

  const cardQueries = extractCardNames(text);
  if (cardQueries.length === 0) return;

  for (const { raw, forceLegend } of cardQueries.slice(0, 5)) {
    try {
      const variant = await lookupCard(raw, forceLegend);

      if (!variant) {
        await bot.sendMessage(chatId,
          `❌ Card not found: *${esc(raw)}*\nCheck the spelling and try again`,
          { parse_mode: "MarkdownV2", reply_to_message_id: msg.message_id }
        ).catch(() => {});
        continue;
      }

      const imageUrl = variant.imageUrl;
      const caption = buildCaption(variant, null);

      try {
        if (imageUrl) {
          await bot.sendPhoto(chatId, imageUrl, {
            caption,
            parse_mode: "MarkdownV2",
            reply_to_message_id: msg.message_id,
          });
        } else {
          await bot.sendMessage(chatId, caption, {
            parse_mode: "MarkdownV2",
            reply_to_message_id: msg.message_id,
          });
        }
      } catch (sendErr) {
        console.error(`[send_error] "${raw}": ${sendErr.message}`);
        console.error(`[caption_dump] ${caption}`);
        await bot.sendMessage(chatId,
          `Found: ${esc(variant.card?.name ?? raw)} — formatting error, try again`,
          { parse_mode: "MarkdownV2", reply_to_message_id: msg.message_id }
        ).catch(() => {});
      }
    } catch (err) {
      console.error(`Error looking up "${raw}":`, err.message);
      await bot.sendMessage(chatId,
        `⚠️ Error fetching *${esc(raw)}* — try again later`,
        { parse_mode: "MarkdownV2", reply_to_message_id: msg.message_id }
      ).catch(() => {});
    }
  }
});

// ─── Polling error handler ────────────────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error(`[polling_error] ${err.code}: ${err.message}`);
});

// ─── Keep-alive ping ──────────────────────────────────────────────────────────
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("RiftTome is running!");
}).listen(PORT, () => {
  console.log(`✅ RiftTome is running on port ${PORT}. Listening for card lookups...`);
});

const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    fetch(RENDER_URL)
      .then(() => console.log(`[keep-alive] Pinged ${RENDER_URL}`))
      .catch((err) => console.error(`[keep-alive] Ping failed: ${err.message}`));
  }, 14 * 60 * 1000);
}
