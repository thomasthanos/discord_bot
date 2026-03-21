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
    [['play', 'p', 'Ï€', 'Ï€Î±Î¹Î¾Îµ', 'paikse'], 'play'],
    [['stop', 'stp', 'x', 'stopmusic', 'stopsong'], 'stop'],
    [['idlemusic', 'idle', 'im', 'Ï‡Î±Î»Î±ÏÎ¿', 'iremia'], 'idlemusic'],
    [['volume', 'vol', 'v', 'ÎµÎ½Ï„Î±ÏƒÎ·', 'entasi'], 'volume'],
    [['nowplaying', 'np', 'Ï„Ï‰ÏÎ±', 'torapaizei'], 'nowplaying'],
    [['stats', 'st', 'ÏƒÏ„Î±Ï„Ï‚', 'stat'], 'stats'],
    [['clear', 'cl', 'ÎºÎ±Î¸Î±ÏÎ¹ÏƒÎµ', 'katharise'], 'clear'],
    [['wipe', 'wipechannel', 'wc', 'ÏƒÎºÎ¿Ï…Ï€Î±', 'skoupa'], 'wipe-channel'],
    [['invite', 'invites', 'invitelogger', 'il', 'Ï€ÏÎ¿ÏƒÎºÎ»Î·ÏƒÎµÎ¹Ï‚'], 'invite-logger'],
    [['help', 'h', 'helpmenu', 'Î²Î¿Î·Î¸ÎµÎ¹Î±', 'voitheia'], 'help-menu'],
    [['addauthorized', 'auth', 'authorize', 'ÎµÎ¾Î¿Ï…ÏƒÎ¹Î¿Î´Î¿Ï„Î·ÏƒÎ·'], 'addauthorized']
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
    await message.reply('ÎœÏ€ÎµÏ‚ Ï€ÏÏŽÏ„Î± ÏƒÎµ voice channel.');
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
    await message.reply(`Î”ÎµÎ½ ÎµÎ¯ÏƒÎ±Î¹ ÎµÎ¾Î¿Ï…ÏƒÎ¹Î¿Î´Î¿Ï„Î·Î¼Î­Î½Î¿Ï‚ Î³Î¹Î± \`!${rawAlias}\`.`);
    return true;
  }

  database.logCommand(commandName, message.author, message.guild, message.channel.id);
  emitCommandLogsSync();

  try {
    if (commandName === 'play') {
      if (!argsText) {
        await message.reply('Usage: `!play <query>` Î® `!p <query>`');
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

      // Switch to normal playback mode when user explicitly uses !play.
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
          await message.reply('Î”ÎµÎ½ Î¼Ï€ÏŒÏÎµÏƒÎ± Î½Î± Ï€Î±Î¯Î¾Ï‰ Î±Ï…Ï„ÏŒ Ï„Î¿ query.');
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
        Boolean(queue.currentTrack) ||
        Boolean(queue.isPlaying?.()) ||
        Number(queue.size || 0) > 0;
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
      const pendingCleared = clearIdlePending(client, guildId);
      client.autoIdleGuilds?.delete(guildId);

      if (queue) {
        try {
          queue.clear();
        } catch {}
        try {
          queue.node.stop();
        } catch {}
        try {
          queue.delete();
        } catch {}
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
        await message.reply('Î”ÎµÎ½ Ï…Ï€Î¬ÏÏ‡ÎµÎ¹ ÎµÎ½ÎµÏÎ³Î® Î¼Î¿Ï…ÏƒÎ¹ÎºÎ® Î¿Ï…ÏÎ¬.');
        return true;
      }

      if (!argsText) {
        await message.reply(`Volume: **${queue.node.volume}%**`);
        return true;
      }

      const level = Number.parseInt(argsText, 10);
      if (!Number.isInteger(level) || level < 0 || level > 100) {
        await message.reply('Usage: `!volume <0-100>`');
        return true;
      }

      const changed = queue.node.setVolume(level);
      await message.reply(changed ? `Volume set: **${level}%**` : 'Î”ÎµÎ½ Î¬Î»Î»Î±Î¾Îµ Ï„Î¿ volume.');
      emitDashboardSync();
      return true;
    }

    if (commandName === 'help-menu') {
      await message.reply([
        '**Prefix Commands**',
        '`!play <query>` (`!p`, `!Ï€`, `!Ï€Î±Î¹Î¾Îµ`)',
        '`!stop` (`!stp`, `!x`)',
        '`!idlemusic` (`!idle`, `!im`)',
        '`!volume [0-100]` (`!v`, `!ÎµÎ½Ï„Î±ÏƒÎ·`)',
        '`!nowplaying` (`!np`)',
        '`!stats` (`!st`)',
        '`!clear <amount>` (`!cl`)',
        '`!wipe` (`!wc`)',
        '`!invite` (`!il`)'
      ].join('\n'));
      return true;
    }

    if (commandName === 'nowplaying') {
      const track = client.currentTrack;
      if (!track || track.guildId !== message.guild.id) {
        await message.reply('Î¤ÏŽÏÎ± Î´ÎµÎ½ Ï€Î±Î¯Î¶ÎµÎ¹ ÎºÎ¬Ï„Î¹ ÏƒÎµ Î±Ï…Ï„ÏŒ Ï„Î¿ server.');
      } else {
        await message.reply(`Now playing: **${track.title}** - **${track.author}**`);
      }
      return true;
    }

    if (commandName === 'stats') {
      const stats = database.getStats();
      const users = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
      await message.reply([
        `Servers: ${client.guilds.cache.size}`,
        `Users: ${users}`,
        `Commands used: ${stats.totalCommands}`,
        `Songs played: ${stats.songsPlayed}`,
        `Messages cleared: ${stats.totalCleared}`
      ].join('\n'));
      return true;
    }

    if (commandName === 'clear') {
      const amount = Number.parseInt(rawArgs[0], 10);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
        await message.reply('Usage: `!clear <1-100>`');
        return true;
      }
      const clearCmd = client.commands.get('clear');
      if (!clearCmd) {
        await message.reply('Î¤Î¿ command clear Î´ÎµÎ½ Î²ÏÎ­Î¸Î·ÎºÎµ.');
        return true;
      }
      await message.reply('Î§ÏÎ·ÏƒÎ¹Î¼Î¿Ï€Î¿Î¯Î·ÏƒÎµ `/clear` Î³Î¹Î± Ï€Î»Î®ÏÎ· transcript logging.');
      return true;
    }

    if (commandName === 'wipe-channel') {
      await message.reply('Î§ÏÎ·ÏƒÎ¹Î¼Î¿Ï€Î¿Î¯Î·ÏƒÎµ `/wipe-channel` (Î­Ï‡ÎµÎ¹ confirm buttons Î³Î¹Î± Î±ÏƒÏ†Î¬Î»ÎµÎ¹Î±).');
      return true;
    }

    if (commandName === 'invite-logger') {
      const guildId = message.guild.id;
      const recent = database.getInviteLogsByGuild(guildId, 5);
      if (!recent.length) {
        await message.reply('Î”ÎµÎ½ Ï…Ï€Î¬ÏÏ‡Î¿Ï…Î½ invite logs Î±ÎºÏŒÎ¼Î±.');
        return true;
      }
      const lines = recent.map((row) => `- ${row.inviter_tag} -> ${row.invited_tag} (${row.invite_code || 'N/A'})`);
      await message.reply(['**Invite Logs**', ...lines].join('\n'));
      return true;
    }

    if (commandName === 'addauthorized') {
      const pseudoInteraction = {
        user: message.author,
        guild: message.guild
      };
      if (!canManageAuthorization(pseudoInteraction)) {
        await message.reply('ÎœÏŒÎ½Î¿ Î¿ owner Ï„Î¿Ï… server Î¼Ï€Î¿ÏÎµÎ¯ Î½Î± ÎºÎ¬Î½ÎµÎ¹ authorize.');
        return true;
      }

      const targetCommand = (rawArgs[0] || '').toLowerCase();
      const targetUserId = parseUserId(rawArgs[1] || '');
      const mode = (rawArgs[2] || 'add').toLowerCase();

      if (!targetCommand || !targetUserId || !['add', 'remove'].includes(mode)) {
        await message.reply('Usage: `!addauthorized <command> <@user|userId> [add|remove]`');
        return true;
      }

      const user = await client.users.fetch(targetUserId).catch(() => null);
      if (!user) {
        await message.reply('Î”ÎµÎ½ Î²ÏÎ­Î¸Î·ÎºÎµ Î¿ user.');
        return true;
      }

      if (!client.commands.has(targetCommand)) {
        await message.reply(`Î”ÎµÎ½ Ï…Ï€Î¬ÏÏ‡ÎµÎ¹ Ï„Î¿ command \`${targetCommand}\`.`);
        return true;
      }

      if (mode === 'remove') {
        const removed = database.removeAuthorizedUser(message.guild.id, targetCommand, user.id);
        await message.reply(removed
          ? `Î‘Ï†Î±Î¹ÏÎ­Î¸Î·ÎºÎµ authorize Î³Î¹Î± <@${user.id}> ÏƒÏ„Î¿ \`/${targetCommand}\`.`
          : `<@${user.id}> Î´ÎµÎ½ ÎµÎ¯Ï‡Îµ authorize ÏƒÏ„Î¿ \`/${targetCommand}\`.`);
      } else {
        database.addAuthorizedUser(message.guild.id, targetCommand, user, message.author);
        await message.reply(`Authorize: <@${user.id}> ÏƒÏ„Î¿ \`/${targetCommand}\`.`);
      }

      return true;
    }

    return false;
  } catch (error) {
    console.error('prefix command error:', error);
    await message.reply('ÎˆÎ³Î¹Î½Îµ ÏƒÏ†Î¬Î»Î¼Î± ÏƒÏ„Î¿ prefix command.');
    return true;
  }
}

module.exports = {
  PREFIX,
  handlePrefixMessage
};




