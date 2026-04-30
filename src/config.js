const path = require("path");

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const minDelayMs = Math.max(1000, toInt(process.env.MIN_DELAY_MS, 10000));
const maxDelayMs = Math.max(minDelayMs, toInt(process.env.MAX_DELAY_MS, 300000));
const hardMaxMs = Math.max(maxDelayMs, toInt(process.env.HARD_MAX_MS, 1800000));

const audioFilePath = path.resolve(
  process.cwd(),
  process.env.AUDIO_FILE_PATH || "./audio/faaaaaa.mp3"
);

module.exports = {
  token: process.env.DISCORD_TOKEN,
  commandGuildId: process.env.COMMAND_GUILD_ID || null,
  audioFilePath,
  minDelayMs,
  maxDelayMs,
  hardMaxMs,
};
