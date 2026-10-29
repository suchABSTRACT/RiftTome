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

// ─── Errata Data ──────────────────────────────────────────────────────────────
const ERRATA_DATA = {
  "ava achiever": { old: "When I attack, you may pay [C] to play a card with [Hidden] from your hand here, ignoring its cost.", new: "When I attack, you may pay [C] to play a card with [Hidden] from your hand, ignoring its cost. If it's a unit, play it here." },
  "baited hook": { old: "[1][C], [E]: Kill a friendly unit. Look at the top 5 cards of your Main Deck. You may play a unit from among them that has the same name as the killed unit, ignoring its cost. Recycle the rest.", new: "[1][C], [E]: Kill a friendly unit. Look at the top 5 cards of your Main Deck. You may banish a unit from among them that has the same name as the killed unit, then play it, ignoring its cost. Recycle the rest." },
  "blind fury": { old: "[Action] (Play on your turn or in showdowns.)\nEach opponent reveals the top card of their Main Deck. Choose one and play it, ignoring its cost.", new: "[Action] (Play on your turn or in showdowns.)\nEach opponent reveals the top card of their Main Deck. Choose one and banish it, then play it, ignoring its cost." },
  "clockwork keeper": { old: "As you play me, you may pay [C] as an additional cost. If you do, draw 1.", new: "You may pay [C] as an additional cost to play me.\nWhen you play me, if you paid the additional cost, draw 1." },
  "convergent mutation": { old: "[Reaction] (Play any time, even before spells and abilities resolve.)\nChoose a friendly unit. Increase its Might until it equals the Might of the strongest enemy unit here.", new: "[Reaction] (Play any time, even before spells and abilities resolve.)\nChoose a friendly unit. This turn, increase its Might until it equals the Might of the strongest enemy unit here." },
  "dark child - starter": { old: "At the end of your turn, ready 2 runes.", new: "At the end of your turn, ready up to 2 runes." },
  "dazzling aurora": { old: "At the end of your turn, reveal cards from the top of your Main Deck until you reveal a unit. Play it, ignoring its cost. Recycle the rest.", new: "At the end of your turn, reveal cards from the top of your Main Deck until you reveal a unit and banish it. Play it, ignoring its cost. Recycle the rest." },
  "disintegrate": { old: "[Action] (Play on your turn or in showdowns.)\nDeal 3 to a unit at a battlefield. If this kills it, draw 1.", new: "Action (Play on your turn or in showdowns.)\nDeal 3 to a unit at a battlefield. If this kills it, do this: draw 1." },
  "dragon's rage": { old: "Move an enemy unit. Then choose another enemy unit at its destination. They deal damage equal to their Mights to each other.", new: "Move an enemy unit. Then do this: Choose another enemy unit at its destination. They deal damage equal to their Mights to each other." },
  "dune drake": { old: "When I attack, give me +2 [M] if there is a ready enemy unit here.", new: "When I attack, give me +2 [M] this turn if there is a ready enemy unit here." },
  "highlander": { old: "[Reaction] (Play any time, even before spells and abilities resolve.)\nChoose a friendly unit. The next time it dies this turn, recall it instead.", new: "[Reaction] (Play any time, even before spells and abilities resolve.)\nChoose a friendly unit. The next time it would die this turn, recall it instead." },
  "karma, channeler": { old: "[Vision] (When you play me, look at the top card of your Main Deck. You may recycle it.)\nWhen you recycle one or more cards, draw 1. (Limit once per turn.)", new: "[Vision] (When you play me, look at the top card of your Main Deck. You may recycle it.)\nWhen you recycle one or more cards, do this: draw 1. (Limit once per turn.)" },
  "kinkou monk": { old: "When you play me, buff two other friendly units. (Each one that doesn't have a buff gets a +1 [M] buff.)", new: "When you play me, buff up to two other friendly units. (Each one that doesn't have a buff gets a +1 [M] buff.)" },
  "nocturne, horrifying": { old: "[Ganking] (I can move from battlefield to battlefield.)\nWhen you look at cards from the top of your deck (and don't draw them), you may banish me from among them and play me.", new: "[Ganking] (I can move from battlefield to battlefield.)\nAs you look at or reveal me from the top of your deck, you may banish me, then play me." },
  "pack of wonders": { old: "[E]: Return another friendly gear, unit, or [Hidden] card to its owner's hand.", new: "[E]: Return another friendly gear, unit, or facedown card to its owner's hand." },
  "portal rescue": { old: "[Action] (Play on your turn or in showdowns.)\nBanish a friendly unit, then play it to base, ignoring its cost.", new: "[Action] (Play on your turn or in showdowns.)\nBanish a friendly unit, then its owner plays it to their base, ignoring its cost." },
  "promising future": { old: "Each player looks at the top 5 cards of their Main Deck, chooses one, then recycles the rest. Starting with the next player, each player plays the chosen card, ignoring its cost.", new: "Each player looks at the top 5 cards of their Main Deck, banishes one of them, then recycles the rest. Starting with the next player, each player plays the banished card, ignoring its cost." },
  "ravenborn tome": { old: "[E]: The next spell you play deals 1 Bonus Damage. (Each instance of damage the spell deals is increased by 1.)", new: "[E]: The next spell you play this turn deals 1 Bonus Damage. (Each instance of damage the spell deals is increased by 1.)" },
  "salvage": { old: "[Action] (Play on your turn or in showdowns.)\nYou may kill a gear. Draw 1.", new: "[Action] (Play on your turn or in showdowns.)\nYou may kill up to one gear. Draw 1." },
  "sigil of the storm": { old: "When you conquer here, you must recycle one of your runes. (This doesn't choose anything.)", new: "When you conquer here, you must recycle one of your runes. (This doesn't choose anything.) [Functional errata — rules clarification applied]" },
  "sona, harmonious": { old: "While I'm at a battlefield, ready 4 friendly runes at the end of your turn.", new: "At the end of your turn, if I'm at a battlefield, ready up to 4 friendly runes." },
  "targon's peak": { old: "When you conquer here, ready 2 runes at the end of this turn.", new: "When you conquer here, ready up to 2 runes at the end of this turn." },
  "teemo, strategist": { old: "[Hidden] (Hide now for [A] to react with later for [0].)\nWhen I defend or I'm played from [Hidden], reveal the top 5 cards of your Main Deck. You may play a unit from among them, ignoring its cost. Recycle the rest.", new: "[Hidden] (Hide now for [A] to react with later for [0].)\nWhen I defend, choose an enemy unit here and reveal the top 5 cards of your Main Deck. You may banish a unit from among them, then play it here, ignoring its cost. Recycle the rest." },
  "the boss": { old: "When a buffed unit you control would die, you may pay [C] and exhaust me to spend its buff and recall it exhausted instead.", new: "If a buffed unit you control would die, you may pay [C], exhaust me, and spend its buff to heal it, exhaust it, and recall it instead." },
  "the dreaming tree": { old: "The first time you choose a friendly unit with a spell here each turn, draw 1.", new: "When a player chooses a friendly unit here with a spell for the first time each turn, they draw 1." },
  "the syren": { old: "[1], [E]: Move a friendly unit at a battlefield to your base.", new: "[1], [E]: Move a friendly unit at a battlefield to its base." },
  "tideturner": { old: "[Hidden] (Hide now for [A] to react with later for [0].)\nWhen you play me, you may choose a friendly unit. Move me to its battlefield.", new: "[Hidden] (Hide now for [A] to react with later for [0].)\nWhen you play me, you may choose a unit you control at another battlefield. Move me there." },
  "unforgiven": { old: "[2], [E]: Move a friendly unit to or from your base.", new: "[2], [E]: Move a friendly unit to or from its base." },
  "unlicensed armory": { old: "Discard 1, [E]: Choose a friendly unit. The next time it dies this turn, you may pay [C] to recall it exhausted instead.", new: "Discard 1, [E]: Choose a friendly unit. The next time it would die this turn, you may pay [C] to heal it, exhaust it, and recall it instead." },
  "void gate": { old: "Spells and abilities affecting units here each deal 1 Bonus Damage. (Each instance of damage the spell deals is increased by 1.)", new: "Spells and abilities deal 1 Bonus Damage to units here. (Each instance of damage the spell deals to a unit here is increased by 1.)" },
  "zhonya's hourglass": { old: "[Hidden] (Hide now for [A] to react with later for [0].)\nThe next time a friendly unit would die, kill this instead. Recall that unit.", new: "[Hidden] (Hide now for [A] to react with later for [0].)\nIf a friendly unit would die, kill this instead. Heal that unit and recall it." },
  "falling star": { old: "Do this twice:\nDeal 3 to a unit. (You can choose different units.)", new: "Deal 3 to a unit.\nDeal 3 to a unit." },
  "icathian rain": { old: "Do this 6 times:\nDeal 2 to a unit. (You can choose different units.)", new: "Deal 2 to a unit.\nDeal 2 to a unit.\nDeal 2 to a unit.\nDeal 2 to a unit.\nDeal 2 to a unit.\nDeal 2 to a unit." },
  "reinforce": { old: "Look at the top 5 cards of your Main Deck. You may play a unit from among them. Its Energy cost is reduced by [5]. Then recycle the rest.", new: "Look at the top 5 cards of your Main Deck. You may banish a unit from among them, then play it, reducing its cost by [5]. Recycle the rest." },
  "arise!": { old: "Play a 2 [M] Sand Soldier unit token for each Equipment you control. Then ready two of them.", new: "Play a 2 [M] Sand Soldier unit token for each Equipment you control. Then do this: Ready up to two of them." },
  "blood rush": { old: "[Action] (Play on your turn or in showdowns.)\n[Repeat] [1]\nGive a friendly unit +2 [M] this turn.", new: "[Action] (Play on your turn or in showdowns.)\n[Repeat] [1]\nGive a friendly unit +2 [M] this turn. [Functional errata — see riftwatcher.com]" },
  "deathgrip": { old: "[Reaction]\nKill a friendly unit to give +[M] equal to its Might to another friendly unit this turn.", new: "[Reaction]\nKill a friendly unit. If you do, give +[M] equal to its Might to another friendly unit this turn." },
  "edge of night": { old: "[Hidden]\nWhen you play this from face down, attach it to a unit you control.", new: "[Hidden]\nWhen you play this from face down, attach it to a unit you control. [Functional errata — see riftwatcher.com]" },
  "janna, savior": { old: "[Reaction]\nWhen you play me, choose a friendly unit here. Move it to another battlefield.", new: "[Reaction]\nWhen you play me, choose a friendly unit here. Move it to another battlefield. [Functional errata — see riftwatcher.com]" },
  "jax, unmatched": { old: "[Deflect]\nEach Equipment in your hand has [Quick-Draw].", new: "[Deflect]\nYour Equipment everywhere have [Quick-Draw]." },
  "kato the arm": { old: "[Deflect]\nWhen I move to a battlefield, give a friendly unit here +2 [M] this turn.", new: "[Deflect]\nWhen I move to a battlefield, give another friendly unit here +2 [M] this turn." },
  "rek'sai, swarm queen": { old: "When I attack, you may reveal the top 2 cards of your Main Deck. You may play one. Then recycle the rest. If the played card is a unit, it enters ready.", new: "When I attack, you may reveal the top 2 cards of your Main Deck. You may banish one, then play it. If it is a unit, you may have it enter ready. Recycle the rest." },
  "rell, magnetic": { old: "[Tank]\nWhen I attack, you may play an Equipment with Energy cost no more than [2] from your hand for free.", new: "[Tank]\nWhen I attack, you may play an Equipment with Energy cost no more than [2] from your hand, ignoring its cost." },
  "tianna crownguard": { old: "[Deflect]\nWhile I'm at a battlefield, opponents can't score or gain Power.", new: "[Deflect]\nWhile I'm at a battlefield, opponents can't gain Power." },
  "void burrower": { old: "When you conquer, you may exhaust me to reveal the top 2 cards of your Main Deck. You may play one. Then recycle the rest.", new: "When you conquer, you may exhaust me to reveal the top 2 cards of your Main Deck. You may banish one, then play it. Recycle the rest." },
  "void rush": { old: "Reveal the top 2 cards of your Main Deck. You may play one of them, reducing its cost by [2]. Draw any you did not play.", new: "Reveal the top 2 cards of your Main Deck. You may banish one, then play it, reducing its cost by [2]. Draw any you didn't banish." },
  "yone, blademaster": { old: "[Weaponmaster] [Functional errata — see riftwatcher.com]", new: "[Weaponmaster] [Functional errata — see riftwatcher.com]" },
  "guards!": { old: "Play a 2 [M] Sand Soldier unit token. You may pay [C] to ready it.", new: "Play a 2 [M] Sand Soldier unit token. Then do this: You may pay [C] to ready it." },
  "relentless pursuit": { old: "Move a friendly unit. You may attach an Equipment with the same controller to it.", new: "Move a friendly unit. You may attach up to one Equipment with the same controller to it." },
  "draven, vanquisher": { old: "When I win a combat, play a Gold gear token exhausted.\nWhen I attack or defend, you may pay [F]. If you do, give me +2 [M] this turn.", new: "When I win a combat, play a Gold gear token exhausted.\nWhen I attack or defend, you may pay [F] to give me +2 [M] this turn." },
  "emperor's dais": { old: "When you conquer here, you may pay [1] and return a unit you control here to its owner's hand. If you do, play a 2 [M] Sand Soldier unit token here.", new: "When you conquer here, you may pay [1] and return a unit you control here to its owner's hand to play a 2 [M] Sand Soldier unit token here." },
  "fizz, trickster": { old: "When you play me, you may play a spell from your trash with Energy cost no more than [3], ignoring its Energy cost. Recycle it.", new: "When you play me, you may play a spell from your trash with Energy cost no more than [3], ignoring its Energy cost. Then recycle it." },
  "death from below": { old: "Kill a unit at a battlefield. Then, if it had 3 [M] or less, you may play this from trash for [A].", new: "Kill a unit at a battlefield. Then, if it had 3 [M] or less, do this: You may play this from trash for [A]." },
  "bone skewer": { old: "When they do, [Stun] it.", new: "If they do, then do this: [Stun] it." },
  "deceiver": { old: "Play a ready Reflection unit token there. It becomes a copy of another unit there.", new: "Play a ready Reflection unit token there. Then do this: It becomes a copy of another unit there." },
  "mirror image": { old: "Play a ready Reflection unit token to your base. It becomes a copy of that unit.", new: "Play a ready Reflection unit token to your base. Then do this: It becomes a copy of that unit." },
  "rengar, trophy hunter": { old: "I can be played to a battlefield where there are enemy units (even if you don't have units there).", new: "I can [Ambush] to a battlefield where there are enemy units, even if you don't have units there." },
  "diana, lunari": { old: "When a showdown begins here, you may pay [1]. If you do, [Predict], then reveal the top card of your Main Deck. If it's a spell, you may play it here, ignoring its cost.", new: "When a showdown begins here, you may pay [1] to [Predict], then reveal the top card of your Main Deck. If it's a spell, you may play it here, ignoring its cost." },
  "stalking wolf": { old: "[Ambush]\nAs an additional cost to play me, kill a friendly unit.", new: "[Ambush]\nAs an additional cost to play me, kill up to one friendly unit." },
  "astral heron": { old: "When you play your first card each turn, if I'm at a battlefield, your next card costs [2][C][C] less.", new: "When you play your first card each turn, if I'm at a battlefield, the next card you play this turn costs [2][C][C] less." },
  "gangplank, naval": { old: "If a spell or ability that chooses me would stun me, give me -[M], or return me to hand, give me +3 [M] instead.", new: "If a spell or ability that chooses me would stun me, give me -[M], or return me to hand, give me +3 [M] this turn instead." },
  "resonating strike": { old: "[Hidden]\n[Reaction] (Play on your turn or in showdowns.)\nChoose a battlefield. Deal 1 to each unit there.", new: "[Hidden]\n[Reaction] (Play any time, even before spells and abilities resolve.)\nChoose a battlefield. Deal 1 to each unit there." },
};

function getErrata() { return ERRATA_DATA; }

function findErrata(errata, cardName) {
  if (!errata || !cardName) return null;
  const name = cardName.toLowerCase();
  if (errata[name]) return errata[name];
  const baseName = name.split(" - ")[0].trim();
  const match = Object.keys(errata).find(k => k === baseName || k.startsWith(baseName));
  return match ? errata[match] : null;
}

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

      const cardErrata = findErrata(getErrata(), variant.card?.name ?? "");
      const imageUrl = variant.imageUrl;
      const caption = buildCaption(variant, cardErrata);

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
