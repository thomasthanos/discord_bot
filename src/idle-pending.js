const { QueryType } = require('discord-player');
const { isIdleLiveActive, stopIdleLive, getIdleLiveSession } = require('./idle-live');
const DEBUG_AUDIO = String(process.env.DEBUG_AUDIO || '0') !== '0';

function debugAudioLog(...parts) {
  if (!DEBUG_AUDIO) return;
  console.log('[DEBUG_AUDIO]', ...parts);
}

function getPendingMap(client) {
  if (!client.idlePendingByGuild) client.idlePendingByGuild = new Map();
  return client.idlePendingByGuild;
}

async function enrichPendingItem(client, item) {
  const base = {
    ...item,
    title: item.query || 'Queued track',
    author: 'Pending',
    duration: '--:--',
    thumbnail: null,
    url: ''
  };

  try {
    const result = await client.player.search(item.query, {
      requestedBy: item.requestedBy || client.user,
      searchEngine: item.searchEngine || QueryType.AUTO
    });
    const track = result?.tracks?.[0];
    if (!track) return base;

    return {
      ...base,
      title: track.title || base.title,
      author: track.author || base.author,
      duration: track.duration || base.duration,
      thumbnail: track.thumbnail || null,
      url: track.url || ''
    };
  } catch {
    return base;
  }
}

async function enqueueIdlePending(client, guildId, item) {
  const enriched = await enrichPendingItem(client, item);
  const map = getPendingMap(client);
  const list = map.get(guildId) || [];
  list.push(enriched);
  map.set(guildId, list);
  debugAudioLog(
    'pending:enqueue',
    `guild=${guildId}`,
    `count=${list.length}`,
    `title=${enriched.title || 'n/a'}`
  );
  return list.length;
}

function hasIdlePending(client, guildId) {
  const map = getPendingMap(client);
  return (map.get(guildId) || []).length > 0;
}

function getIdlePendingCount(client, guildId) {
  const map = getPendingMap(client);
  return (map.get(guildId) || []).length;
}

function getIdlePendingList(client, guildId, limit = 20) {
  const map = getPendingMap(client);
  return (map.get(guildId) || []).slice(0, limit);
}

function clearIdlePending(client, guildId) {
  const map = getPendingMap(client);
  if (!guildId) return 0;
  const list = map.get(guildId) || [];
  map.delete(guildId);
  return list.length;
}

function shiftIdlePending(client, guildId) {
  const map = getPendingMap(client);
  const list = map.get(guildId) || [];
  const next = list.shift() || null;
  if (list.length) map.set(guildId, list);
  else map.delete(guildId);
  debugAudioLog(
    'pending:shift',
    `guild=${guildId}`,
    `next=${next ? (next.title || next.query || 'n/a') : 'none'}`,
    `remaining=${list.length}`
  );
  return next;
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function startNextPendingTrack(client, guild, voiceChannel = null, textChannel = null, options = {}) {
  if (!guild) return null;
  const map = getPendingMap(client);
  const list = map.get(guild.id) || [];
  const next = list[0] || null;
  if (!next) return null;
  debugAudioLog(
    'pending:start-next',
    `guild=${guild.id}`,
    `query=${next.query}`,
    `remainingBefore=${list.length}`
  );

  let resolvedVoiceChannel = voiceChannel;
  let resolvedTextChannel = textChannel || next.textChannel || null;

  if (!resolvedVoiceChannel && isIdleLiveActive(client, guild.id)) {
    const session = getIdleLiveSession(client, guild.id);
    const channelId = session?.connection?.joinConfig?.channelId || null;
    if (channelId) {
      resolvedVoiceChannel = guild.channels.cache.get(channelId) || null;
    }
    if (!resolvedTextChannel) resolvedTextChannel = session?.textChannel || null;
  }

  if (isIdleLiveActive(client, guild.id)) {
    debugAudioLog('pending:stopping-idle', `guild=${guild.id}`);
    // Force release to avoid voice adapter conflicts between idle and discord-player.
    const shouldDestroy = options?.destroyIdleConnection !== false;
    await stopIdleLive(client, guild.id, { destroyConnection: shouldDestroy });
  }

  if (!resolvedVoiceChannel) {
    throw new Error('Could not resolve voice channel for pending playback.');
  }

  let queue = client.player.nodes.get(guild.id);
  if (!queue) {
    queue = client.player.nodes.create(guild, {
      metadata: { channel: resolvedTextChannel },
      leaveOnEnd: true,
      leaveOnEndCooldown: 300000,
      leaveOnStop: true,
      leaveOnStopCooldown: 120000,
      volume: 50
    });
  } else {
    queue.metadata = { channel: resolvedTextChannel };
  }

  if (!queue.connection || queue.channel?.id !== resolvedVoiceChannel.id) {
    debugAudioLog('pending:connect-queue', `guild=${guild.id}`, `voice=${resolvedVoiceChannel.id}`);
    await queue.connect(resolvedVoiceChannel);
  }

  debugAudioLog('pending:play', `guild=${guild.id}`, `engine=${next.searchEngine || QueryType.AUTO}`);
  let playResult;
  try {
    playResult = await withTimeout(client.player.play(resolvedVoiceChannel, next.query, {
      requestedBy: next.requestedBy || client.user,
      searchEngine: next.searchEngine || QueryType.AUTO,
      fallbackSearchEngine: QueryType.YOUTUBE_SEARCH,
      nodeOptions: {
        metadata: { channel: resolvedTextChannel },
        leaveOnEnd: true,
        leaveOnEndCooldown: 300000,
        leaveOnStop: true,
        leaveOnStopCooldown: 120000
      }
    }), 15000, 'Timed out while starting pending track playback.');
  } catch (error) {
    debugAudioLog(
      'pending:play-failed',
      `guild=${guild.id}`,
      `query=${next.query}`,
      `error=${error?.message || error}`
    );
    // Do not remove item from pending list when playback fails.
    throw error;
  }

  shiftIdlePending(client, guild.id);
  debugAudioLog(
    'pending:play-success',
    `guild=${guild.id}`,
    `title=${playResult?.track?.title || 'n/a'}`,
    `remainingAfter=${getIdlePendingCount(client, guild.id)}`
  );

  return { playResult, queuedItem: next };
}

module.exports = {
  enqueueIdlePending,
  hasIdlePending,
  getIdlePendingCount,
  getIdlePendingList,
  clearIdlePending,
  startNextPendingTrack
};

