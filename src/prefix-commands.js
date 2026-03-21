const { QueryType } = require('discord-player');
const { canManageAuthorization, isCommandAuthorized } = require('./utils/authorization');
const { startIdleLive, stopIdleLive, isIdleLiveActive } = require('./idle-live');
const { enqueueIdlePending, getIdlePendingCount, clearIdlePending } = require('./idle-pending');

const PREFIX = '!';

function normalizeAlias(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getCommandNameFromAlias(rawAlias) {
  const alias = normalizeAlias(rawAlias);
  if (!alias) return null;

  const aliasMap = new Map([
    [['play', 'p', 'π'], 'play'],
    [['stop', 's', 'σ'], 'stop'],
    [['idlemusic', 'im', 'ιμ'], 'idlemusic'],
    [['volume', 'v', 'β'], 'volume'],
    [['clear', 'c', 'ψ'], 'clear'],
    [['wipe', 'wc', 'ςψ'], 'wipe-channel'],
    [['invite-logger', 'il', 'ιλ'], 'invite-logger'],
    [['help', 'h', 'η'], 'help'],
    [['addauthorized', 'aa', 'αα'], 'addauthorized']
  ]);

  for (const [aliases, commandName] of aliasMap.entries()) {
    if (aliases.includes(alias)) return commandName;
  }

  return null;
}

function parseUserId(raw) {
  if (!raw) return null;
  const mentionMatch = raw.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  return /^\d+$/.test(raw) ? raw : null;
}

function canUseCommand(message, database, commandName) {
  if (!message.guild) return false;
  if (!database.hasAuthorizedEntriesForCommand(message.guild.id, commandName)) return true;
  const pseudoInteraction = {
    inGuild: () => Boolean(message.guild),
    user: message.author,
    guild: message.guild,
    guildId: message.guild.id
  };
  return isCommandAuthorized(pseudoInteraction, database, commandName);
}

async function ensureVoiceQueue(message, client) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply('Join a voice channel first.');
    return null;
  }

  let queue = client.player.nodes.get(message.guild.id);
  if (!queue) {
    queue = client.player.nodes.create(message.guild, {
      metadata: { channel: message.channel },
      leaveOnEnd: true,
      leaveOnEndCooldown: 300000,
      leaveOnStop: true,
      leaveOnStopCooldown: 120000,
      volume: 50
    });
  } else {
    queue.metadata = { channel: message.channel };
  }

  if (!queue.connection || queue.channel?.id !== voiceChannel.id) {
    await queue.connect(voiceChannel);
  }

  return { queue, voiceChannel };
}

async function resolveSpotifyToSearchQuery(url) {
  try {
    const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    const response = await fetch(endpoint);
    if (!response.ok) return null;

    const data = await response.json();
    if (!data?.title || typeof data.title !== 'string') return null;

    const bySeparator = ' by ';
    const idx = data.title.toLowerCase().lastIndexOf(bySeparator);
    if (idx > 0) {
      const title = data.title.slice(0, idx).trim();
      const artist = data.title.slice(idx + bySeparator.length).trim();
      return `${title} ${artist}`.trim();
    }

    return data.title.trim();
  } catch {
    return null;
  }
}

async function handlePrefixMessage(message, client, database, emitCommandLogsSync, emitDashboardSync) {
  if (!message.guild || message.author.bot) return false;
  if (!message.content.startsWith(PREFIX)) return false;

  const withoutPrefix = message.content.slice(PREFIX.length).trim();
  if (!withoutPrefix) return false;

  const [rawAlias, ...rawArgs] = withoutPrefix.split(/\s+/);
  const argsText = withoutPrefix.slice(rawAlias.length).trim();
  const commandName = getCommandNameFromAlias(rawAlias);
  if (!commandName) return false;

  if (!canUseCommand(message, database, commandName)) {
    await message.reply(`You are not authorized to use \`!${rawAlias}\`.`);
    return true;
  }

  database.logCommand(commandName, message.author, message.guild, message.channel.id);
  emitCommandLogsSync();

  try {
    if (commandName === 'play') {
      if (!argsText) {
        await message.reply('Usage: `!play <query>` or `!p`');
        return true;
      }

      const query = argsText;
      const looksLikeUrl = /^https?:\/\//i.test(query);
      const isSpotifyUrl = /open\.spotify\.com\/(track|album|playlist)\//i.test(query);
      let effectiveQuery = query;
      if (isSpotifyUrl) {
        const mapped = await resolveSpotifyToSearchQuery(query);
        if (mapped) effectiveQuery = mapped;
      }

      client.autoIdleGuilds?.delete(message.guild.id);

      if (isIdleLiveActive(client, message.guild.id)) {
        const searchEngine = isSpotifyUrl
          ? QueryType.YOUTUBE_SEARCH
          : (looksLikeUrl ? QueryType.AUTO : QueryType.YOUTUBE_SEARCH);
        await enqueueIdlePending(client, message.guild.id, {
          query: effectiveQuery,
          searchEngine,
          requestedBy: message.author,
          textChannel: message.channel
        });
        const pending = getIdlePendingCount(client, message.guild.id);
        await message.reply(`Queued while idle is playing. Pending: **${pending}**. Use skip to start.`);
        return true;
      }

      const result = await ensureVoiceQueue(message, client);
      if (!result) return true;

      const playOptions = {
        requestedBy: message.author,
        searchEngine: isSpotifyUrl
          ? QueryType.YOUTUBE_SEARCH
          : (looksLikeUrl ? QueryType.AUTO : QueryType.YOUTUBE_SEARCH),
        fallbackSearchEngine: QueryType.YOUTUBE_SEARCH,
        nodeOptions: {
          metadata: { channel: message.channel },
          leaveOnEnd: true,
          leaveOnEndCooldown: 300000,
          leaveOnStop: true,
          leaveOnStopCooldown: 120000
        }
      };

      try {
        const { track } = await client.player.play(result.voiceChannel, effectiveQuery, playOptions);
        await message.reply(`Now playing: **${track.title}**`);
      } catch (error) {
        console.error('prefix play primary failed:', error.message || error);
        try {
          const { track } = await client.player.play(result.voiceChannel, effectiveQuery, {
            ...playOptions,
            searchEngine: QueryType.YOUTUBE_SEARCH
          });
          await message.reply(`Now playing (fallback): **${track.title}**`);
        } catch {
          await message.reply('Could not play that query.');
        }
      }

      emitDashboardSync();
      return true;
    }

    if (commandName === 'idlemusic') {
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        await message.reply('Join a voice channel first.');
        return true;
      }

      if (isIdleLiveActive(client, message.guild.id)) {
        await message.reply('Idle music is already playing.');
        return true;
      }

      const queue = client.player?.nodes?.get(message.guild.id) || null;
      if (queue && (!queue.connection || queue.channel?.id !== voiceChannel.id)) {
        try {
          await queue.connect(voiceChannel);
        } catch {
          await message.reply('Could not move to your voice channel.');
          return true;
        }
      }

      const hasActivePlayback =
        Boolean(queue?.currentTrack) ||
        Boolean(queue?.isPlaying?.()) ||
        Number(queue?.size || 0) > 0;
      if (hasActivePlayback) {
        await message.reply('Queue is active. Use `/stop` first, then run `!idlemusic`.');
        return true;
      }

      const { track } = await startIdleLive(
        client,
        message.guild,
        voiceChannel,
        message.channel,
        message.author,
      );
      client.autoIdleGuilds?.add(message.guild.id);

      await message.reply(`Idle music enabled: **${track.title}**`);
      emitDashboardSync();
      return true;
    }

    if (commandName === 'stop') {
      const guildId = message.guild.id;
      const queue = client.player?.nodes?.get(guildId) || null;
      const idleActive = isIdleLiveActive(client, guildId);

      // Nothing to stop
      if (!queue && !idleActive && !client.currentTrack) {
        await message.reply('Nothing is playing right now.');
        return true;
      }

      const pendingCleared = clearIdlePending(client, guildId);
      client.autoIdleGuilds?.delete(guildId);

      if (queue) {
        try { queue.clear(); } catch {}
        try { queue.node.stop(); } catch {}
        try { queue.delete(); } catch {}
      }

      if (idleActive) {
        await stopIdleLive(client, guildId, { destroyConnection: true });
      }

      if (client.currentTrack?.guildId === guildId) {
        client.currentTrack = null;
      }
      emitDashboardSync();
      await message.reply(`Stopped. Cleared queue and pending (${pendingCleared}).`);
      return true;
    }

    if (commandName === 'volume') {
      const queue = client.player?.nodes?.get(message.guild.id);
      if (!queue || (!queue.currentTrack && !queue.isPlaying())) {
        await message.reply('No active music queue in this server.');
        return true;
      }

      if (!argsText) {
        await message.reply(`Volume: **${queue.node.volume}%**`);
        return true;
      }

      const level = Number.parseInt(argsText, 10);
      if (!Number.isInteger(level) || level < 0 || level > 100) {
        await message.reply('Usage: `!v <0-100>`');
        return true;
      }

      const changed = queue.node.setVolume(level);
      await message.reply(changed ? `Volume set: **${level}%**` : 'Volume did not change.');
      emitDashboardSync();
      return true;
    }

    if (commandName === 'help') {
      const helpCmd = client.commands.get('help');
      if (helpCmd) {
        const pseudoInteraction = {
          inGuild: () => Boolean(message.guild),
          user: message.author,
          guild: message.guild,
          guildId: message.guild?.id || null,
          channel: message.channel,
          replied: false,
          deferred: false,
          reply: (payload) => message.reply(payload)
        };
        await helpCmd.execute(pseudoInteraction, client);
      }
      return true;
    }

    if (commandName === 'clear') {
      const amount = Number.parseInt(rawArgs[0], 10);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
        await message.reply('Usage: `!c <1-100>`');
        return true;
      }
      const clearCmd = client.commands.get('clear');
      if (!clearCmd) {
        await message.reply('The clear command module was not found.');
        return true;
      }
      await message.reply('Use `/clear` for full transcript logging.');
      return true;
    }

    if (commandName === 'wipe-channel') {
      await message.reply('Use `/wipe-channel` (includes confirmation buttons).');
      return true;
    }

    if (commandName === 'invite-logger') {
      const inviteCmd = client.commands.get('invite-logger');
      if (inviteCmd) {
        const pseudoInteraction = {
          inGuild: () => Boolean(message.guild),
          user: message.author,
          guild: message.guild,
          guildId: message.guild?.id || null,
          channel: message.channel,
          replied: false,
          deferred: false,
          options: { getInteger: () => null },
          reply: (payload) => message.reply(payload)
        };
        await inviteCmd.execute(pseudoInteraction, client, database);
      }
      return true;
    }

    if (commandName === 'addauthorized') {
      const pseudoInteraction = {
        user: message.author,
        guild: message.guild
      };
      if (!canManageAuthorization(pseudoInteraction)) {
        await message.reply('Only the server owner can manage authorization.');
        return true;
      }

      const targetCommand = (rawArgs[0] || '').toLowerCase();
      const targetUserId = parseUserId(rawArgs[1] || '');
      const mode = (rawArgs[2] || 'add').toLowerCase();

      if (!targetCommand || !targetUserId || !['add', 'remove'].includes(mode)) {
        await message.reply('Usage: `!aa <command> <@user|userId> [add|remove]`');
        return true;
      }

      const user = await client.users.fetch(targetUserId).catch(() => null);
      if (!user) {
        await message.reply('User not found.');
        return true;
      }

      if (!client.commands.has(targetCommand)) {
        await message.reply(`Command \`${targetCommand}\` does not exist.`);
        return true;
      }

      if (mode === 'remove') {
        const removed = database.removeAuthorizedUser(message.guild.id, targetCommand, user.id);
        await message.reply(removed
          ? `Removed authorization for <@${user.id}> on \`/${targetCommand}\`.`
          : `<@${user.id}> was not authorized for \`/${targetCommand}\`.`);
      } else {
        database.addAuthorizedUser(message.guild.id, targetCommand, user, message.author);
        await message.reply(`Authorized <@${user.id}> for \`/${targetCommand}\`.`);
      }

      return true;
    }

    return false;
  } catch (error) {
    console.error('prefix command error:', error);
    await message.reply('Prefix command failed.');
    return true;
  }
}

module.exports = {
  PREFIX,
  handlePrefixMessage
};
