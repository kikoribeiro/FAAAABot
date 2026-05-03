require("dotenv").config();

const fs = require("fs");
const {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const {
  AudioPlayerStatus,
  VoiceConnectionDisconnectReason,
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
  connecting: false,
  connectAttemptId: 0,
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

const detectVoiceDependencies = () => {
  let opus = null;
  let sodium = null;

  try {
    require("@discordjs/opus");
    opus = "@discordjs/opus";
  } catch (error) {
    try {
      require("opusscript");
      opus = "opusscript";
    } catch (innerError) {
      opus = null;
    }
  }

  try {
    require("libsodium-wrappers");
    sodium = "libsodium-wrappers";
  } catch (error) {
    try {
      require("sodium-native");
      sodium = "sodium-native";
    } catch (innerError) {
      sodium = null;
    }
  }

  return { opus, sodium };
};

const voiceDeps = detectVoiceDependencies();

const isVoiceChannel = (channel) =>
  channel &&
  (channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice);

const getVoicePermissionError = (voiceChannel) => {
  const me = voiceChannel.guild.members.me;
  if (!me) {
    return "I cannot read my permissions yet. Try again in a moment.";
  }

  const permissions = voiceChannel.permissionsFor(me);
  if (!permissions) {
    return "I cannot read permissions for that channel.";
  }

  const missing = [];
  if (!permissions.has(PermissionsBitField.Flags.Connect)) {
    missing.push("Connect");
  }
  if (!permissions.has(PermissionsBitField.Flags.Speak)) {
    missing.push("Speak");
  }

  return missing.length ? `Missing permissions: ${missing.join(", ")}.` : null;
};

const getPermissionSummary = (voiceChannel) => {
  if (!isVoiceChannel(voiceChannel)) {
    return "n/a";
  }

  const me = voiceChannel.guild.members.me;
  if (!me) {
    return "unknown";
  }

  const permissions = voiceChannel.permissionsFor(me);
  if (!permissions) {
    return "unknown";
  }

  const canConnect = permissions.has(PermissionsBitField.Flags.Connect);
  const canSpeak = permissions.has(PermissionsBitField.Flags.Speak);
  return `connect=${canConnect}, speak=${canSpeak}`;
};

const safeEditReply = async (interaction, payload) => {
  try {
    await interaction.editReply(payload);
  } catch (error) {
    if (error?.code === 10008) {
      try {
        await interaction.followUp(payload);
      } catch (followError) {
        console.warn("Failed to send follow-up reply.", followError);
      }
      return;
    }

    console.warn("Failed to edit interaction reply.", error);
  }
};

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

const getBotVoiceChannel = async (guild) => {
  if (!guild) {
    return null;
  }

  const member =
    guild.members.me || (await guild.members.fetchMe().catch(() => null));
  return member?.voice?.channel || null;
};

const connectToChannel = async (voiceChannel) => {
  const permissionError = getVoicePermissionError(voiceChannel);
  if (permissionError) {
    throw new Error(permissionError);
  }

  if (state.connecting) {
    throw new Error("Already connecting to a voice channel.");
  }

  state.connecting = true;
  const attemptId = ++state.connectAttemptId;
  stopPlayback();
  setDesiredChannel(voiceChannel);

  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    state.connection = connection;
    attachConnectionListeners(connection);

    if (state.connectAttemptId !== attemptId) {
      connection.destroy();
      throw new Error("Connection attempt was cancelled.");
    }

    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);

    if (state.connectAttemptId !== attemptId) {
      connection.destroy();
      throw new Error("Connection attempt was cancelled.");
    }

    if (!state.audioPlayer) {
      state.audioPlayer = createPlayer();
    }
    connection.subscribe(state.audioPlayer);
    state.lastPlayedAt = Date.now();
    scheduleNext();
  } catch (error) {
    if (state.connection === connection) {
      state.connection = null;
    }
    if (connection) {
      connection.destroy();
    }
    throw error;
  } finally {
    state.connecting = false;
  }
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
  connection.on(
    VoiceConnectionStatus.Disconnected,
    async (oldState, newState) => {
      // If we are already reconnecting, or we chose to leave, STOP.
      if (!state.desiredChannelId || state.reconnecting) return;

      // If the disconnect was manual, or the channel/kick caused close, stop and clear.
      if (
        newState.reason === VoiceConnectionDisconnectReason.Manual ||
        newState.closeCode === 4014
      ) {
        stopPlayback({ clearDesired: true });
        return;
      }

      state.reconnecting = true;
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
    },
  );
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
      .setName("debug")
      .setDescription("Show voice state and permissions for debugging."),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Leave the voice channel and stop playing."),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(config.token);

  if (config.commandGuildIds.length) {
    for (const guildId of config.commandGuildIds) {
      const route = Routes.applicationGuildCommands(client.user.id, guildId);
      await rest.put(route, { body: commands });
      console.log(`Registered guild commands in ${guildId}.`);
    }
    return;
  }

  const route = Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: commands });
  console.log("Registered global commands (may take up to 1 hour to appear).");
};

client.once(Events.ClientReady, async () => {
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
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: "Join a voice channel first, then run /join.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isVoiceChannel(voiceChannel)) {
      await interaction.reply({
        content: "The current channel is not a voice channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      state.connection &&
      state.connection.joinConfig.channelId === voiceChannel.id
    ) {
      await interaction.reply({
        content: `Already in ${voiceChannel.name}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (state.connecting) {
      await interaction.reply({
        content: "Still connecting. Try again in a few seconds.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    try {
      await connectToChannel(voiceChannel);
    } catch (error) {
      console.error("Failed to connect to voice channel.", error);
      stopPlayback();
      await safeEditReply(interaction, {
        content: error?.message || "Failed to join the voice channel.",
      });
      return;
    }

    await safeEditReply(interaction, {
      content: `Joined ${voiceChannel.name} and started playing.`,
    });
    return;
  }

  if (interaction.commandName === "fa") {
    if (state.connecting) {
      await interaction.reply({
        content: "Still connecting. Try again in a few seconds.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!state.connection || !state.audioPlayer) {
      const botChannel = await getBotVoiceChannel(interaction.guild);
      if (!isVoiceChannel(botChannel)) {
        await interaction.reply({
          content: "I am not in a voice channel yet. Use /join first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await connectToChannel(botChannel);
      } catch (error) {
        console.error("Failed to reattach to voice channel.", error);
        stopPlayback();
        await safeEditReply(interaction, {
          content:
            error?.message ||
            "I could not rejoin the voice channel. Use /join again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      clearSchedule();
      playSound();
      await safeEditReply(interaction, {
        content: "Faaaaaa!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    clearSchedule();
    playSound();
    await interaction.reply("Faaaaaa!");
    return;
  }

  if (interaction.commandName === "status") {
    if (state.connecting) {
      await interaction.reply({
        content: "Connecting to voice. Try again in a few seconds.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!state.connection || !state.audioPlayer) {
      const botChannel = await getBotVoiceChannel(interaction.guild);
      if (!isVoiceChannel(botChannel)) {
        await interaction.reply({
          content: "Not in a voice channel. Use /join first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content:
          `I look connected to ${botChannel.name}, but my audio session ` +
          "is not initialized. Run /join to re-sync.",
        flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "debug") {
    const guild = interaction.guild;
    const botMember = guild
      ? guild.members.me || (await guild.members.fetchMe().catch(() => null))
      : null;
    const botChannel = botMember?.voice?.channel || null;
    const userChannel = interaction.member?.voice?.channel || null;
    const botVoiceState = botMember?.voice;

    const lines = [
      `Guild: ${guild?.name || "unknown"} (${guild?.id || "n/a"})`,
      `Bot voice: ${botChannel ? botChannel.name : "none"}`,
      `User voice: ${userChannel ? userChannel.name : "none"}`,
      `Connection: ${state.connection ? state.connection.state.status : "none"}`,
      `Audio player: ${state.audioPlayer ? state.audioPlayer.state.status : "none"}`,
      `Desired channel id: ${state.desiredChannelId || "none"}`,
      `Bot serverMute: ${botVoiceState?.serverMute ?? "n/a"}`,
      `Bot serverDeaf: ${botVoiceState?.serverDeaf ?? "n/a"}`,
      `Voice deps: opus=${voiceDeps.opus || "missing"}, ` +
        `sodium=${voiceDeps.sodium || "missing"}`,
      `Permissions (bot channel): ${getPermissionSummary(botChannel)}`,
      `Permissions (user channel): ${getPermissionSummary(userChannel)}`,
    ];

    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "leave") {
    state.connectAttemptId += 1;
    state.connecting = false;
    stopPlayback({ clearDesired: true });
    await interaction.reply("Left the voice channel and stopped playing.");
  }
});

if (ensureConfig()) {
  client.login(config.token);
}
