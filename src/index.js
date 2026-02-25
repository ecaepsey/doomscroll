import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { prisma } from "./db.js";
import { telegramApi } from "./telegram.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
if (!BOT_TOKEN || !BOT_USERNAME) throw new Error("BOT_TOKEN / BOT_USERNAME missing in .env");

const tg = telegramApi(BOT_TOKEN);

// Create a user (MVP). Later replace with Sign in with Apple / your auth.
app.post("/users", async (req, res) => {
  const user = await prisma.user.create({ data: {} });
  res.json(user);
});

// 1) Create one-time Telegram link token
app.post("/auth/telegram/link-token", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "user not found" });

  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.telegramLinkToken.create({
    data: { token, userId, expiresAt },
  });

  const deepLink = `https://t.me/${BOT_USERNAME}?start=${token}`;
  res.json({ token, deepLink, expiresAt });
});

// 2) Telegram webhook: user presses Start => we store chat_id
app.post("/telegram/webhook", async (req, res) => {
  try {
    const msg = req.body?.message;
    const text = msg?.text;
    const chatId = msg?.chat?.id;
    const telegramUserId = msg?.from?.id;

    if (!text || !chatId) return res.sendStatus(200);

    if (text.startsWith("/start")) {
      const token = text.split(" ")[1];
      if (!token) {
        await tg.sendMessage(chatId, "Open the app → Connect Telegram again 🙂");
        return res.sendStatus(200);
      }

      const record = await prisma.telegramLinkToken.findUnique({ where: { token } });
      if (!record) {
        await tg.sendMessage(chatId, "Token invalid/expired. Generate a new one in the app.");
        return res.sendStatus(200);
      }

      if (record.expiresAt.getTime() < Date.now()) {
        await prisma.telegramLinkToken.delete({ where: { token } }).catch(() => {});
        await tg.sendMessage(chatId, "Token expired. Generate a new one in the app.");
        return res.sendStatus(200);
      }

      await prisma.user.update({
        where: { id: record.userId },
        data: {
          telegramChatId: BigInt(chatId),
          telegramUserId: telegramUserId ? BigInt(telegramUserId) : null,
          telegramConnected: true,
        },
      });

      await prisma.telegramLinkToken.delete({ where: { token } });

      await tg.sendMessage(chatId, "✅ Connected! I’ll ping you when you hit your limit.");
    }

    res.sendStatus(200);
  } catch (e) {
    // Telegram expects 200; otherwise it retries a lot.
    res.sendStatus(200);
  }
});

// 3) iOS app calls this after notification tap/open
app.post("/events/doomscroll", async (req, res) => {
  const { userId, appName, minutes } = req.body;
  if (!userId || !appName || !minutes) return res.status(400).json({ error: "missing fields" });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.telegramConnected || !user.telegramChatId) {
    return res.status(409).json({ error: "telegram_not_connected" });
  }

  try {
    await tg.sendMessage(user.telegramChatId.toString(), `⚠️ Doomscroll: ${minutes} min in ${appName}.`);
    res.sendStatus(200);
  } catch (e) {
    // If user blocked bot -> mark disconnected
    await prisma.user.update({
      where: { id: userId },
      data: { telegramConnected: false },
    }).catch(() => {});
    res.status(502).json({ error: "telegram_send_failed" });
  }
});

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));