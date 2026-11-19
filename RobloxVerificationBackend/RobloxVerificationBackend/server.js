require("dotenv").config();

const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const required = [
  "DISCORD_TOKEN",
  "GUILD_ID",
  "CITIZEN_ROLE_ID",
  "BACKEND_API_KEY",
  "ROBLOX_API_KEY"
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.use(express.json({ limit: "10kb" }));

const db = new Database(process.env.DB_PATH || "./verification.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS link_codes (
    code TEXT PRIMARY KEY,
    roblox_user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS account_links (
    roblox_user_id TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL UNIQUE,
    linked_at INTEGER NOT NULL
  );
`);

const insertCode = db.prepare(
  "INSERT INTO link_codes (code, roblox_user_id, expires_at, used) VALUES (?, ?, ?, 0)"
);
const getCode = db.prepare(
  "SELECT * FROM link_codes WHERE code = ?"
);
const consumeCode = db.prepare(
  "UPDATE link_codes SET used = 1 WHERE code = ? AND used = 0"
);
const getLinkByRoblox = db.prepare(
  "SELECT discord_user_id FROM account_links WHERE roblox_user_id = ?"
);
const getLinkByDiscord = db.prepare(
  "SELECT roblox_user_id FROM account_links WHERE discord_user_id = ?"
);
const saveLink = db.prepare(`
  INSERT INTO account_links (roblox_user_id, discord_user_id, linked_at)
  VALUES (?, ?, ?)
  ON CONFLICT(roblox_user_id) DO UPDATE SET
    discord_user_id = excluded.discord_user_id,
    linked_at = excluded.linked_at
`);

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireSecret(expectedEnv, headerName) {
  return (req, res, next) => {
    const supplied = req.get(headerName) || "";
    if (!safeEqual(supplied, process.env[expectedEnv])) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
    next();
  };
}

const requireBotKey = requireSecret("BACKEND_API_KEY", "authorization");
const requireRobloxKey = (req, res, next) => {
  const auth = req.get("x-api-key") || "";
  if (!safeEqual(auth, process.env.ROBLOX_API_KEY)) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
};

// Confirm current server membership AND the required role using Discord's API.
async function discordHasCitizenRole(discordUserId) {
  const url = `https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/members/${encodeURIComponent(discordUserId)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    signal: AbortSignal.timeout(8000)
  });

  if (response.status === 404) return false;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord API error ${response.status}: ${body}`);
  }

  const member = await response.json();
  return Array.isArray(member.roles) &&
    member.roles.includes(process.env.CITIZEN_ROLE_ID);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "roblox-discord-verification" });
});

// Roblox server requests a short-lived code for the joining player.
app.post("/roblox/create-code", requireRobloxKey, (req, res) => {
  const userId = String(req.body?.robloxUserId || "");
  if (!/^\d{1,20}$/.test(userId)) {
    return res.status(400).json({ ok: false, message: "Invalid Roblox user ID" });
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;

  // Retry in the extremely unlikely event of a code collision.
  try {
    insertCode.run(code, userId, expiresAt);
  } catch {
    return res.status(503).json({ ok: false, message: "Could not create code; retry" });
  }

  res.json({ ok: true, code, expiresAt });
});

// Discord bot submits the code. Role is checked again against Discord, server-side.
app.post("/discord/verify", requireBotKey, async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const discordUserId = String(req.body?.discordUserId || "");
    const guildId = String(req.body?.guildId || "");

    if (!/^\d{6}$/.test(code) || !/^\d{15,22}$/.test(discordUserId)) {
      return res.status(400).json({ ok: false, message: "كود أو حساب غير صالح." });
    }
    if (guildId !== process.env.GUILD_ID) {
      return res.status(403).json({ ok: false, message: "هذا ليس سيرفر الديسكورد المعتمد." });
    }

    const row = getCode.get(code);
    if (!row || row.used || row.expires_at < Date.now()) {
      return res.status(400).json({ ok: false, message: "الكود غير صحيح أو انتهت صلاحيته." });
    }

    const allowed = await discordHasCitizenRole(discordUserId);
    if (!allowed) {
      return res.status(403).json({ ok: false, message: "لازم تكون داخل السيرفر وعندك رول مواطن رسمي." });
    }

    const existingDiscord = getLinkByDiscord.get(discordUserId);
    if (existingDiscord && existingDiscord.roblox_user_id !== row.roblox_user_id) {
      return res.status(409).json({ ok: false, message: "حساب Discord مربوط بحساب Roblox آخر." });
    }

    const existingRoblox = getLinkByRoblox.get(row.roblox_user_id);
    if (existingRoblox && existingRoblox.discord_user_id !== discordUserId) {
      return res.status(409).json({ ok: false, message: "حساب Roblox مربوط بحساب Discord آخر." });
    }

    const result = db.transaction(() => {
      const consumed = consumeCode.run(code);
      if (consumed.changes !== 1) throw new Error("CODE_ALREADY_USED");
      saveLink.run(row.roblox_user_id, discordUserId, Date.now());
    });

    try {
      result();
    } catch (error) {
      if (error.message === "CODE_ALREADY_USED") {
        return res.status(409).json({ ok: false, message: "تم استخدام هذا الكود بالفعل." });
      }
      throw error;
    }

    return res.json({ ok: true, message: "تم ربط حسابك بنجاح. ارجع إلى Roblox." });
  } catch (error) {
    console.error("Discord verify error:", error);
    return res.status(503).json({ ok: false, message: "تعذر التحقق حالياً. حاول مرة ثانية." });
  }
});

// Roblox checks on every join. A removed role or server departure blocks entry.
app.post("/roblox/check", requireRobloxKey, async (req, res) => {
  try {
    const robloxUserId = String(req.body?.robloxUserId || "");
    if (!/^\d{1,20}$/.test(robloxUserId)) {
      return res.status(400).json({ ok: false, allowed: false, message: "Invalid Roblox user ID" });
    }

    const link = getLinkByRoblox.get(robloxUserId);
    if (!link) {
      return res.json({ ok: true, allowed: false, reason: "not_linked" });
    }

    const allowed = await discordHasCitizenRole(link.discord_user_id);
    return res.json({
      ok: true,
      allowed,
      reason: allowed ? "verified" : "missing_membership_or_role"
    });
  } catch (error) {
    console.error("Roblox check error:", error);
    return res.status(503).json({ ok: false, allowed: false, reason: "verification_unavailable" });
  }
});

app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  console.log(`Verification backend listening on port ${process.env.PORT || 3000}`);
});
