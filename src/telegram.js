import axios from "axios";

export function telegramApi(botToken) {
  const base = `https://api.telegram.org/bot${botToken}`;
  return {
    sendMessage: (chat_id, text) =>
      axios.post(`${base}/sendMessage`, { chat_id, text }),
    setWebhook: (url) =>
      axios.post(`${base}/setWebhook`, { url }),
  };
}