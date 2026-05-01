require("dotenv").config();

const fs = require("fs");
const {
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require("@discordjs/voice");

const config = require("./config");

const ffmpegPath = require("ffmpeg-static");
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const state = {
  connection: null,
  audioPlayer: null,
  playTimeout: null,
  lastPlayedAt: 0,
  nextPlayAt: null,
  desiredChannelId: null,
  desiredGuildId: null,
  reconnecting: false,
};

const randomDelay = (minMs, maxMs) => {
  const min = Math.floor(minMs);
  const max = Math.floor(maxMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const ensureConfig = () => {
  if (!config.token) {
    console.error("Missing DISCORD_TOKEN in .env");
    return false;
  }
  return true;
};

const isVoiceChannel = (channel) =>
  channel &&
  (channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice);

const setDesiredChannel = (channel) => {
  state.desiredChannelId = channel.id;
  state.desiredGuildId = channel.guild.id;
};

const clearDesiredChannel = () => {
  state.desiredChannelId = null;
  state.desiredGuildId = null;
};

const clearSchedule = () => {
  if (state.playTimeout) {
    clearTimeout(state.playTimeout);
    state.playTimeout = null;
  }
  state.nextPlayAt = null;
};

const playSound = () => {
  if (!state.audioPlayer) {
    return;
  }

  if (!fs.existsSync(config.audioFilePath)) {
    console.error(`Audio file not found: ${config.audioFilePath}`);
    state.lastPlayedAt = Date.now();
    clearSchedule();
    scheduleNext();
    return;
  }

  console.log("Playing faaaaaa");
  const resource = createAudioResource(config.audioFilePath);
  state.audioPlayer.play(resource);
  state.lastPlayedAt = Date.now();
};

const scheduleNext = () => {
  if (!state.audioPlayer) {
    return;
  }

  const now = Date.now();
  const elapsed = state.lastPlayedAt ? now - state.lastPlayedAt : 0;
  const maxAllowed = Math.max(0, config.hardMaxMs - elapsed);
  const upper = Math.min(config.maxDelayMs, maxAllowed);
  const delay =
    upper < config.minDelayMs ? 0 : randomDelay(config.minDelayMs, upper);

  clearSchedule();
  state.playTimeout = setTimeout(playSound, delay);
  state.nextPlayAt = Date.now() + delay;
  console.log(`Next faaaaaa in ${(delay / 1000).toFixed(1)}s`);
};

const createPlayer = () => {
  const player = createAudioPlayer();
  player.on(AudioPlayerStatus.Idle, scheduleNext);
  player.on("error", (error) => {
    console.error("Audio player error:", error);
    scheduleNext();
  });
  return player;
};

const stopPlayback = ({ clearDesired = false } = {}) => {
  clearSchedule();
  if (state.audioPlayer) {
    state.audioPlayer.stop(true);
    state.audioPlayer = null;
  }
  if (state.connection) {
    state.connection.destroy();
    state.connection = null;
  }
  state.lastPlayedAt = 0;
  state.nextPlayAt = null;
  if (clearDesired) {
    clearDesiredChannel();
  }
};

const formatMs = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "now";
  }

  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
};

const attachConnectionListeners = (connection) => {
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (!state.desiredChannelId || state.reconnecting) {
      return;
    }

    state.reconnecting = true;
    console.warn("Voice connection lost. Reconnecting...");

    try {
      const channel = await client.channels
        .fetch(state.desiredChannelId)
        .catch(() => null);

      if (!isVoiceChannel(channel)) {
        console.error("Stored voice channel is no longer available.");
        stopPlayback({ clearDesired: true });
        return;
      }

      const newConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });

      try {
        await entersState(newConnection, VoiceConnectionStatus.Ready, 30_000);
      } catch (error) {
        console.error("Failed to reconnect to voice channel.", error);
        newConnection.destroy();
        return;
      }

      if (state.connection && state.connection !== newConnection) {
        state.connection.destroy();
      }

      state.connection = newConnection;
      attachConnectionListeners(newConnection);

      if (!state.audioPlayer) {
        state.audioPlayer = createPlayer();
      }

      newConnection.subscribe(state.audioPlayer);
      if (!state.lastPlayedAt) {
        state.lastPlayedAt = Date.now();
      }
      scheduleNext();
      console.log("Reconnected to voice channel.");
    } finally {
      state.reconnecting = false;
    }
  });
};

const registerCommands = async () => {
  const commands = [
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("Join your voice channel and start playing faaaaaa."),
    new SlashCommandBuilder()
      .setName("fa")
      .setDescription("Play the faaaaaa sound immediately."),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show current channel and timer info."),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Leave the voice channel and stop playing."),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(config.token);
  const route = config.commandGuildId
    ? Routes.applicationGuildCommands(client.user.id, config.commandGuildId)
    : Routes.applicationCommands(client.user.id);

  await rest.put(route, { body: commands });
  console.log(
    config.commandGuildId
      ? `Registered guild commands in ${config.commandGuildId}.`
      : "Registered global commands (may take up to 1 hour to appear).",
  );
};

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error("Failed to register commands.", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "join") {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "Use this command in a server.",
        ephemeral: true,
      });
      return;
    }

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: "Join a voice channel first, then run /join.",
        ephemeral: true,
      });
      return;
    }

    if (!isVoiceChannel(voiceChannel)) {
      await interaction.reply({
        content: "The current channel is not a voice channel.",
        ephemeral: true,
      });
      return;
    }

    if (
      state.connection &&
      state.connection.joinConfig.channelId === voiceChannel.id
    ) {
      await interaction.reply({
        content: `Already in ${voiceChannel.name}.`,
        ephemeral: true,
      });
      return;
    }

    stopPlayback();
    setDesiredChannel(voiceChannel);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (error) {
      console.error("Failed to connect to voice channel.", error);
      connection.destroy();
      await interaction.reply({
        content: "Failed to join the voice channel.",
        ephemeral: true,
      });
      return;
    }

    state.connection = connection;
    attachConnectionListeners(connection);
    state.audioPlayer = createPlayer();
    connection.subscribe(state.audioPlayer);
    state.lastPlayedAt = Date.now();
    scheduleNext();

    await interaction.reply(`Joined ${voiceChannel.name} and started playing.`);
    return;
  }

  if (interaction.commandName === "fa") {
    if (!state.connection || !state.audioPlayer) {
      await interaction.reply({
        content: "I am not in a voice channel yet. Use /join first.",
        ephemeral: true,
      });
      return;
    }

    clearSchedule();
    playSound();
    await interaction.reply("Faaaaaa!");
    return;
  }

  if (interaction.commandName === "status") {
    if (!state.connection || !state.audioPlayer) {
      await interaction.reply({
        content: "Not in a voice channel. Use /join first.",
        ephemeral: true,
      });
      return;
    }

    const channel = await client.channels
      .fetch(state.connection.joinConfig.channelId)
      .catch(() => null);

    const channelName = channel?.name || "Unknown";
    const nextInMs = state.nextPlayAt ? state.nextPlayAt - Date.now() : 0;

    await interaction.reply({
      content:
        `Channel: ${channelName}\n` +
        `Next faaaaaa: ${formatMs(nextInMs)}\n` +
        `Delay range: ${Math.round(config.minDelayMs / 1000)}s-${Math.round(
          config.maxDelayMs / 1000,
        )}s\n` +
        `Hard max: ${Math.round(config.hardMaxMs / 1000)}s`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "leave") {
    stopPlayback({ clearDesired: true });
    await interaction.reply("Left the voice channel and stopped playing.");
  }
});

if (ensureConfig()) {
  client.login(config.token);
}
