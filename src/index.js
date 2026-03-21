require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, REST, Routes, MessageFlags } = require('discord.js');
const { Player, QueryType } = require('discord-player');
const { YoutubeiExtractor } = require('discord-player-youtubei');
const { Log } = require('youtubei.js');
const { DefaultExtractors } = require('@discord-player/extractor');
const database = require('./database');
const startDashboard = require('./dashboard/server');
const { isCommandAuthorized } = require('./utils/authorization');
const { handlePrefixMessage, PREFIX } = require('./prefix-commands');
const { startIdleLive, isIdleLiveActive } = require('./idle-live');
const { hasIdlePending, startNextPendingTrack } = require('./idle-pending');

const INSTANCE_LOCK_FILE = path.join(__dirname, '..', '.bot.instance.lock');
const DEBUG_AUDIO = String(process.env.DEBUG_AUDIO || '0') !== '0';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;

function debugAudioLog(...parts) {
  if (!DEBUG_AUDIO) return;
  console.log('[DEBUG_AUDIO]', ...parts);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireInstanceLock() {
  try {
    if (fs.existsSync(INSTANCE_LOCK_FILE)) {
      const raw = fs.readFileSync(INSTANCE_LOCK_FILE, 'utf8').trim();
      const existingPid = Number.parseInt(raw, 10);
      if (isPidAlive(existingPid) && existingPid !== process.pid) {
        throw new Error(`Another bot instance is already running (PID ${existingPid}). Stop it first.`);
      }
    }

    fs.writeFileSync(INSTANCE_LOCK_FILE, String(process.pid), 'utf8');
  } catch (error) {
    throw new Error(`Failed to acquire instance lock: ${error.message}`);
  }
}

function releaseInstanceLock() {
  try {
    if (!fs.existsSync(INSTANCE_LOCK_FILE)) return;
    const raw = fs.readFileSync(INSTANCE_LOCK_FILE, 'utf8').trim();
    const lockPid = Number.parseInt(raw, 10);
    if (lockPid === process.pid) {
      fs.unlinkSync(INSTANCE_LOCK_FILE);
    }
  } catch {}
}

acquireInstanceLock();
process.on('exit', releaseInstanceLock);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

// Reduce noisy youtubei parser warnings in production logs.
Log.setLevel(Log.Level.ERROR);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ]
});

client.commands = new Collection();
client.inviteCache = new Collection();
client.currentTrack = null;
client.trackFallbackAttempts = new Set();
client.pendingStreamFallbacks = 0;
client.lastAnnouncedTrackByGuild = new Map();
client.autoIdleGuilds = new Set();
let dashboardStarted = false;

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = [];

function loadCommands(dir) {
  if (!fs.existsSync(dir)) {
    console.warn(`[commands] Directory not found: ${dir}`);
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      loadCommands(fullPath);
      continue;
    }

    if (entry.name.endsWith('.js')) {
      commandFiles.push(fullPath);
    }
  }
}

function emitDashboardSync() {
  client.emit('dashboard:sync');
}

function emitCommandLogsSync() {
  client.emit('dashboard:commandLogs');
}

loadCommands(commandsPath);

const slashCommands = [];
for (const filePath of commandFiles) {
  try {
    const command = require(filePath);
    if (command?.data && typeof command.execute === 'function') {
      client.commands.set(command.data.name, command);
      slashCommands.push(command.data.toJSON());
      continue;
    }

    console.warn(`[commands] Skipped invalid command module: ${filePath}`);
  } catch (error) {
    console.error(`[commands] Failed to load ${filePath}:`, error);
  }
}

const player = new Player(client);
client.player = player;

player.extractors.register(YoutubeiExtractor, {
  disablePlayer: true,
  overrideBridgeMode: 'yt',
  useServerAbrStream: true,
  useYoutubeDL: true,
  logLevel: 'NONE',
  cookie: process.env.YT_COOKIE || undefined,
  streamOptions: {
    useClient: 'ANDROID',
    highWaterMark: 1 << 25
  }
});

async function initializeExtractors() {
  const extractorOptions = {};
  const extractors = DefaultExtractors.filter(
    (Extractor) => Extractor.identifier !== 'com.discord-player.soundcloudextractor'
  );

  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    extractorOptions['com.discord-player.spotifyextractor'] = {
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      bridgeSearch: true
    };
  }

  await player.extractors.loadMulti(extractors, extractorOptions);
}

player.events.on('playerStart', (queue, track) => {
  debugAudioLog(
    'event:playerStart',
    `guild=${queue?.guild?.id || 'n/a'}`,
    `voice=${queue?.channel?.id || 'n/a'}`,
    `queueSize=${Number(queue?.size || 0)}`,
    `isPlaying=${Boolean(queue?.isPlaying?.())}`,
    `title=${track?.title || 'n/a'}`,
    `duration=${track?.duration || 'n/a'}`,
    `url=${track?.url || 'n/a'}`
  );

  const announceKey = track.url || `${track.title}|${track.author}`;
  const last = client.lastAnnouncedTrackByGuild.get(queue.guild.id);
  const isDuplicateStart = last && last.key === announceKey && Date.now() - last.at < 45000;

  if (!isDuplicateStart) {
    queue.metadata?.channel?.send(`Now playing: **${track.title}** by **${track.author}**`);
    database.logSong(track.title, track.author, track.url, track.requestedBy?.username || 'Unknown', queue.guild.id);
    client.lastAnnouncedTrackByGuild.set(queue.guild.id, { key: announceKey, at: Date.now() });
  }

  client.currentTrack = {
    title: track.title,
    author: track.author,
    url: track.url,
    thumbnail: track.thumbnail,
    duration: track.duration,
    guildId: queue.guild.id,
    requestedBy: track.requestedBy?.username || track.requestedBy?.tag || 'Unknown',
    startedAt: Date.now()
  };

  emitDashboardSync();
});

player.events.on('playerFinish', () => {
  debugAudioLog('event:playerFinish');
  client.currentTrack = null;
  emitDashboardSync();
});

player.events.on('audioTrackAdd', () => {
  emitDashboardSync();
});

player.events.on('audioTracksAdd', () => {
  emitDashboardSync();
});

player.events.on('audioTrackRemove', () => {
  emitDashboardSync();
});

player.events.on('audioTracksRemove', () => {
  emitDashboardSync();
});

player.events.on('emptyQueue', (queue) => {
  debugAudioLog(
    'event:emptyQueue',
    `guild=${queue?.guild?.id || 'n/a'}`,
    `voice=${queue?.channel?.id || 'n/a'}`,
    `size=${Number(queue?.size || 0)}`
  );
  if (client.pendingStreamFallbacks > 0) {
    return;
  }

  if (queue?.guild?.id && hasIdlePending(client, queue.guild.id)) {
    const voiceChannel =
      queue.channel ||
      queue.guild?.members?.me?.voice?.channel ||
      null;
    const textChannel = queue.metadata?.channel || null;
    if (voiceChannel) {
      setTimeout(async () => {
        try {
          await startNextPendingTrack(client, queue.guild, voiceChannel, textChannel);
          emitDashboardSync();
        } catch (error) {
          console.error('Pending-next failed:', error?.message || error);
        }
      }, 800);
      return;
    }

    console.warn(`Pending queue exists for guild ${queue.guild.id} but no voice channel could be resolved.`);
    queue.metadata?.channel?.send('Pending queue exists but I lost the voice channel. Rejoin a voice channel and run `/play` again.');
    return;
  }

  if (queue?.guild?.id && client.autoIdleGuilds?.has(queue.guild.id) && !isIdleLiveActive(client, queue.guild.id)) {
    const voiceChannel = queue.channel;
    const textChannel = queue.metadata?.channel || null;
    if (voiceChannel) {
      setTimeout(async () => {
        try {
          await startIdleLive(client, queue.guild, voiceChannel, textChannel, client.user);
        } catch (error) {
          console.error('Auto-idle restart failed:', error?.message || error);
        }
      }, 1000);
      return;
    }
  }

  queue.metadata?.channel?.send('Queue finished. No more songs to play.');
  client.currentTrack = null;
  emitDashboardSync();
});

player.events.on('error', (_, error) => {
  const isAbortError =
    error?.name === 'AbortError' ||
    /operation was aborted/i.test(error?.message || '');
  if (isAbortError) {
    debugAudioLog('event:error:ignored-abort', error?.message || 'AbortError');
    return;
  }

  console.error(`Player error: ${error.message}`);
  debugAudioLog('event:error', error?.stack || error?.message || String(error));
});

player.events.on('playerError', async (queue, error, track) => {
  const isAbortError =
    error?.name === 'AbortError' ||
    /operation was aborted/i.test(error?.message || '');
  if (isAbortError) {
    debugAudioLog(
      'event:playerError:ignored-abort',
      `guild=${queue?.guild?.id || 'n/a'}`,
      `track=${track?.title || 'n/a'}`
    );
    return;
  }

  console.error(`Player error: ${error.message}`);
  debugAudioLog(
    'event:playerError',
    `guild=${queue?.guild?.id || 'n/a'}`,
    `voice=${queue?.channel?.id || 'n/a'}`,
    `track=${track?.title || 'n/a'}`,
    `trackUrl=${track?.url || 'n/a'}`,
    `message=${error?.message || 'n/a'}`
  );

  const isStreamExtractError = /extract stream/i.test(error.message || '');
  if (!isStreamExtractError) {
    queue.metadata?.channel?.send(`Error: ${error.message}`);
  }

  if (!track || !queue?.channel) return;

  const fallbackKey = track.url || `${track.title}|${track.author}`;
  if (client.trackFallbackAttempts.has(fallbackKey)) return;
  client.trackFallbackAttempts.add(fallbackKey);

  const fallbackQuery = [track.title, track.author].filter(Boolean).join(' ').trim();
  if (!fallbackQuery) return;

  try {
    client.pendingStreamFallbacks += 1;
    queue.metadata?.channel?.send('Stream source failed. Trying fallback...');

    const { track: fallbackTrack } = await client.player.play(queue.channel, fallbackQuery, {
      requestedBy: track.requestedBy || null,
      searchEngine: QueryType.YOUTUBE_SEARCH,
      nodeOptions: {
        metadata: queue.metadata,
        leaveOnEnd: true,
        leaveOnEndCooldown: 300000,
        leaveOnStop: true,
        leaveOnStopCooldown: 120000
      }
    });

    queue.metadata?.channel?.send(`Fallback stream: **${fallbackTrack.title}**`);
  } catch (fallbackError) {
    console.error('Fallback playback failed:', fallbackError.message || fallbackError);
    queue.metadata?.channel?.send('Fallback failed for this track.');
  } finally {
    client.pendingStreamFallbacks = Math.max(0, client.pendingStreamFallbacks - 1);
    setTimeout(() => client.trackFallbackAttempts.delete(fallbackKey), 300000);
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  database.db.prepare('UPDATE bot_stats SET value = ? WHERE key = ?').run(Date.now().toString(), 'start_time');

  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      client.inviteCache.set(guild.id, new Collection(invites.map((inv) => [inv.code, inv.uses])));
    } catch {
      console.log(`Could not cache invites for ${guild.name}`);
    }
  }

  if (!process.env.CLIENT_ID) {
    console.warn('CLIENT_ID is missing. Slash command registration was skipped.');
  } else {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
      console.log('Registering slash commands...');
      // Remove legacy global commands to avoid duplicate command entries in Discord UI.
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });

      const explicitGuildId = process.env.GUILD_ID;
      if (explicitGuildId) {
        await rest.put(
          Routes.applicationGuildCommands(process.env.CLIENT_ID, explicitGuildId),
          { body: slashCommands }
        );
        console.log(`Registered ${slashCommands.length} guild commands for ${explicitGuildId}.`);
      } else {
        const guildIds = [...client.guilds.cache.keys()];
        for (const guildId of guildIds) {
          await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
            { body: slashCommands }
          );
        }
        console.log(`Registered ${slashCommands.length} commands in ${guildIds.length} guild(s).`);
      }
    } catch (error) {
      console.error('Error registering commands:', error);
    }
  }

  if (!dashboardStarted) {
    try {
      await startDashboard(client, database);
      dashboardStarted = true;
    } catch (error) {
      console.error('Failed to start dashboard:', error);
    }
  }

  emitDashboardSync();
  emitCommandLogsSync();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    if (
      interaction.inGuild() &&
      interaction.commandName !== 'addauthorized' &&
      database.hasAuthorizedEntriesForCommand(interaction.guildId, interaction.commandName) &&
      !isCommandAuthorized(interaction, database, interaction.commandName)
    ) {
      await interaction.reply({
        content: `You are not authorized to use \`/${interaction.commandName}\`.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    database.logCommand(interaction.commandName, interaction.user, interaction.guild, interaction.channelId);
    emitCommandLogsSync();

    await command.execute(interaction, client, database);
    emitDashboardSync();
  } catch (error) {
    console.error(`Error executing ${interaction.commandName}:`, error);
    const reply = { content: 'An error occurred while executing this command.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
        return;
      }

      await interaction.reply(reply);
    } catch (responseError) {
      const code = responseError?.code;
      if (code !== 40060 && code !== 10062) {
        console.error('Failed to send interaction error response:', responseError);
      }
    }
  }
});

client.on('messageCreate', async (message) => {
  try {
    const handled = await handlePrefixMessage(
      message,
      client,
      database,
      emitCommandLogsSync,
      emitDashboardSync
    );

    if (handled) {
      emitDashboardSync();
    }
  } catch (error) {
    console.error('prefix message handler error:', error);
  }
});

client.on('inviteCreate', async (invite) => {
  const invites = client.inviteCache.get(invite.guild.id) || new Collection();
  invites.set(invite.code, invite.uses);
  client.inviteCache.set(invite.guild.id, invites);
});

client.on('inviteDelete', async (invite) => {
  const invites = client.inviteCache.get(invite.guild.id);
  if (invites) invites.delete(invite.code);
});

client.on('guildMemberAdd', async (member) => {
  try {
    const cachedInvites = client.inviteCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch();

    const usedInvite = newInvites.find((inv) => {
      const oldUses = cachedInvites?.get(inv.code) || 0;
      return inv.uses > oldUses;
    });

    client.inviteCache.set(member.guild.id, new Collection(newInvites.map((inv) => [inv.code, inv.uses])));

    if (usedInvite && usedInvite.inviter) {
      const totalInvites = newInvites
        .filter((inv) => inv.inviter?.id === usedInvite.inviter.id)
        .reduce((acc, inv) => acc + inv.uses, 0);

      database.logInvite(usedInvite.inviter, member.user, usedInvite.code, member.guild, totalInvites);
    }
  } catch (error) {
    console.error('Error tracking invite:', error);
  } finally {
    emitDashboardSync();
  }
});

client.on('guildMemberRemove', () => emitDashboardSync());
client.on('guildCreate', () => emitDashboardSync());
client.on('guildDelete', () => emitDashboardSync());

if (!DISCORD_TOKEN) {
  throw new Error('Missing DISCORD_TOKEN (or DISCORD_BOT_TOKEN) in .env');
}

async function bootstrap() {
  console.log(`Prefix commands enabled with prefix: ${PREFIX}`);
  await initializeExtractors();
  await client.login(DISCORD_TOKEN);
}

bootstrap().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});



