const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { version: discordPlayerVersion } = require('discord-player');
const {
  isIdleLiveActive,
  getIdleLiveSession,
  stopIdleLive,
  setIdleLiveVolume,
  toggleIdleLivePause
} = require('../idle-live');
const { hasIdlePending, startNextPendingTrack, getIdlePendingList, clearIdlePending } = require('../idle-pending');
const { DATA_DIR } = require('../utils/attachments');
const DEBUG_AUDIO = String(process.env.DEBUG_AUDIO || '0') !== '0';

function debugAudioLog(...parts) {
  if (!DEBUG_AUDIO) return;
  console.log('[DEBUG_AUDIO]', ...parts);
}

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function buildStats(client, database) {
  const stats = database.getStats();
  const uptime = Date.now() - stats.startTime;
  return {
    servers: client.guilds.cache.size,
    users: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0),
    songsPlayed: stats.songsPlayed,
    commands: client.commands?.size || 0,
    commandUses: stats.totalCommands,
    cleared: stats.totalCleared,
    uptime: formatUptime(uptime)
  };
}

function buildSystemHealth(client) {
  const wsPing = Number(client.ws?.ping);
  const voiceNodes = client.player?.nodes?.cache?.size || 0;
  return {
    bot: client.isReady() ? 'Online' : 'Connecting',
    latency: Number.isFinite(wsPing) && wsPing >= 0 ? `${wsPing} ms` : 'N/A',
    voiceQueues: voiceNodes.toString(),
    dashboard: 'Online'
  };
}

function buildConfig(client) {
  const intents = client.options?.intents;
  const hasInviteIntent = Boolean(intents?.has?.(GatewayIntentBits.GuildInvites));
  const hasMembersIntent = Boolean(intents?.has?.(GatewayIntentBits.GuildMembers));
  const spotifyEnabled = Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
  const dashboardPort = client.dashboardInfo?.port || Number(process.env.PORT || 3000);
  return {
    prefix: process.env.COMMAND_PREFIX || '!',
    musicEngine: `discord-player v${discordPlayerVersion}`,
    spotifySupport: spotifyEnabled ? 'Active' : 'Missing Credentials',
    inviteTracking: (hasInviteIntent && hasMembersIntent) ? 'Active' : 'Disabled (Intents)',
    dashboardPort: dashboardPort.toString()
  };
}

function getGuildOptions(client) {
  return client.guilds.cache.map((guild) => ({
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ size: 64, forceStatic: false }) || null
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function resolveGuildId(rawGuildId, client) {
  if (!rawGuildId) return null;
  const guildId = String(rawGuildId).trim();
  if (!guildId) return null;
  return client.guilds.cache.has(guildId) ? guildId : null;
}

function resolvePermissionLabel(defaultPermissions) {
  if (!defaultPermissions) return null;
  try {
    const perms = new PermissionsBitField(BigInt(defaultPermissions)).toArray();
    if (!perms.length) return null;
    return perms.map((p) => p.replace(/_/g, ' ')).join(', ');
  } catch {
    return null;
  }
}

function formatDurationFromMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function resolveTrackDuration(trackLike) {
  const label = trackLike?.duration;
  if (typeof label === 'string' && label.trim()) return label.trim();
  const ms =
    trackLike?.durationMS ?? trackLike?.durationMs ??
    trackLike?.source?.durationMS ?? trackLike?.source?.durationMs ??
    trackLike?.raw?.durationMS ?? trackLike?.raw?.durationMs ?? null;
  return formatDurationFromMs(ms);
}

function serializeTrack(track, index = 0) {
  return {
    index,
    title: track?.title || 'Unknown title',
    author: track?.author || 'Unknown artist',
    duration: resolveTrackDuration(track),
    url: track?.url || '',
    thumbnail: track?.thumbnail || null
  };
}

function collectionToArray(collection) {
  if (!collection) return [];
  if (typeof collection.toArray === 'function') return collection.toArray();
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === 'function') return Array.from(collection.values());
  return Array.from(collection);
}

function buildMusicLists(queue) {
  if (!queue) return { queue: [], history: [] };
  const upcoming = collectionToArray(queue.tracks).slice(0, 20).map((track, index) => serializeTrack(track, index + 1));
  const history = collectionToArray(queue.history?.tracks).slice(-20).reverse().map((track, index) => serializeTrack(track, index + 1));
  return { queue: upcoming, history };
}

function buildIdlePendingList(client, guildId) {
  return getIdlePendingList(client, guildId, 20).map((item, index) => ({
    index: index + 1,
    title: item.title || item.query || 'Queued track',
    author: item.author || 'Pending',
    duration: resolveTrackDuration(item),
    thumbnail: item.thumbnail || null,
    url: item.url || ''
  }));
}

function buildCombinedUpcomingList(client, guildId, queueList) {
  const base = Array.isArray(queueList) ? queueList : [];
  if (!guildId || !hasIdlePending(client, guildId)) return base;

  const seenUrls = new Set(base.map((item) => String(item?.url || '').trim()).filter(Boolean));
  const pending = buildIdlePendingList(client, guildId).map((item, index) => ({
    ...item,
    index: base.length + index + 1,
    author: `${item.author || 'Pending'} (pending)`
  })).filter((item) => {
    const urlKey = String(item?.url || '').trim();
    if (urlKey && seenUrls.has(urlKey)) return false;
    return true;
  });

  return [...base, ...pending];
}

function buildSyncPayload(client, database, guildId = null) {
  const queue = getActiveQueue(client, guildId);
  let lists = buildMusicLists(queue);
  const recentCommands = guildId ? database.getCommandLogsByGuild(guildId, 4) : database.getCommandLogs().slice(0, 4);
  const commandUsage = guildId ? database.getCommandUsageByGuild(guildId, 4) : database.getCommandUsage(4);
  const timestamp = queue?.node?.getTimestamp ? queue.node.getTimestamp() : null;
  const progress = timestamp ? {
    currentLabel: timestamp.current?.label || '0:00',
    currentValue: Number(timestamp.current?.value || 0),
    totalLabel: timestamp.total?.label || (queue.currentTrack?.duration || '--:--'),
    totalValue: Number(timestamp.total?.value || 0),
    percent: Number(timestamp.progress || 0)
  } : null;

  let state = queue ? {
    guildId: queue.guild?.id || null,
    isPlaying: Boolean(queue.isPlaying?.()),
    isPaused: Boolean(queue.node?.isPaused?.()),
    volume: Number.isFinite(Number(queue.node?.volume)) ? Number(queue.node.volume) : 50,
    canBack: queue.history?.isEmpty ? !queue.history.isEmpty() : false,
    canSkip: Number(queue.size || 0) > 0 || (guildId ? hasIdlePending(client, guildId) : false),
    canStop: true,
    progress
  } : null;

  if (!queue && guildId && isIdleLiveActive(client, guildId)) {
    const idleSession = getIdleLiveSession(client, guildId);
    state = {
      guildId,
      isPlaying: true,
      isPaused: Boolean(idleSession?.paused),
      volume: Number.isFinite(Number(idleSession?.volume)) ? Number(idleSession.volume) : 50,
      canBack: false,
      canSkip: hasIdlePending(client, guildId),
      canStop: true,
      progress: { currentLabel: 'LIVE', currentValue: 0, totalLabel: 'LIVE', totalValue: 0, percent: 0 }
    };
    lists = { queue: buildIdlePendingList(client, guildId), history: [] };
  }

  return {
    selectedGuildId: guildId,
    stats: buildStats(client, database),
    health: buildSystemHealth(client),
    config: buildConfig(client),
    guildOptions: getGuildOptions(client),
    recentCommands,
    commandUsage,
    currentTrack: (guildId && client.currentTrack?.guildId !== guildId) ? null : (client.currentTrack || null),
    playerState: state,
    queueList: buildCombinedUpcomingList(client, guildId, lists.queue),
    historyList: lists.history
  };
}

function getActiveQueue(client, guildId = null) {
  if (!client?.player?.nodes) return null;
  if (guildId) return client.player.nodes.get(guildId) || null;
  if (client.currentTrack?.guildId) {
    const queueByTrack = client.player.nodes.get(client.currentTrack.guildId);
    if (queueByTrack) return queueByTrack;
  }
  const fromCache = client.player.nodes.cache;
  if (!fromCache || fromCache.size === 0) return null;
  return fromCache.find((queue) => queue.isPlaying()) || fromCache.first();
}

function listenWithFallback(server, startPort, maxAttempts = 20) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let port = Number(startPort);
    const onError = (error) => {
      if (error.code !== 'EADDRINUSE') { reject(error); return; }
      attempt += 1;
      if (attempt >= maxAttempts) { reject(new Error(`No available port found after ${maxAttempts} attempts, starting from ${startPort}.`)); return; }
      port += 1;
      server.listen(port);
    };
    server.on('error', onError);
    server.once('listening', () => { server.off('error', onError); resolve(port); });
    server.listen(port);
  });
}

async function startDashboard(client, database) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server);
  const preferredPort = Number(process.env.PORT || 3000);
  const idleSkipInFlightByGuild = new Set();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));
  // Serve saved attachments (images, videos, files from /clear and /wipe-channel)
  app.use('/attachments', express.static(path.join(DATA_DIR, 'attachments')));
  app.use(express.json());

  app.get('/favicon.ico', (req, res) => { res.status(204).end(); });

  function selectedGuildFromRequest(req) {
    const explicit = resolveGuildId(req.query?.guildId, client);
    if (explicit) return explicit;
    const firstGuild = getGuildOptions(client)[0];
    return firstGuild?.id || null;
  }

  function viewModel(req, page, extras = {}) {
    const selectedGuildId = selectedGuildFromRequest(req);
    const currentTrack = (selectedGuildId && client.currentTrack?.guildId !== selectedGuildId) ? null : (client.currentTrack || null);
    return { page, currentPath: req.path, selectedGuildId, guildOptions: getGuildOptions(client), currentTrack, ...extras };
  }

  app.get('/', (req, res) => {
    const selectedGuildId = selectedGuildFromRequest(req);
    res.render('dashboard', viewModel(req, 'dashboard', {
      stats: buildStats(client, database),
      health: buildSystemHealth(client),
      config: buildConfig(client),
      recentCommands: selectedGuildId ? database.getCommandLogsByGuild(selectedGuildId, 4) : database.getCommandLogs().slice(0, 4),
      commandUsage: selectedGuildId ? database.getCommandUsageByGuild(selectedGuildId, 4) : database.getCommandUsage(4)
    }));
  });

  app.get('/commands', (req, res) => {
    const selectedGuildId = selectedGuildFromRequest(req);
    const commands = [];
    client.commands.forEach((cmd) => {
      const category = cmd.category || cmd.meta?.category || 'General';
      const permissionLabel = resolvePermissionLabel(cmd.data.default_member_permissions);
      commands.push({
        name: cmd.data.name,
        description: cmd.data.description,
        category,
        options: cmd.data.options?.map((option) => ({ name: option.name, required: option.required })) || [],
        permissions: cmd.data.default_member_permissions || null,
        permissionLabel
      });
    });
    res.render('commands', viewModel(req, 'commands', {
      commands,
      logs: selectedGuildId ? database.getCommandLogsByGuild(selectedGuildId, 100) : database.getCommandLogs()
    }));
  });

  app.get('/clearlogs', (req, res) => {
    const selectedGuildId = selectedGuildFromRequest(req);
    res.render('clearlogs', viewModel(req, 'clearlogs', {
      logs: selectedGuildId ? database.getClearLogsByGuild(selectedGuildId) : database.getClearLogs()
    }));
  });

  app.get('/transcript/:id', (req, res) => {
    const log = database.getClearLog(parseInt(req.params.id, 10));
    if (!log) { res.status(404).send('Not found'); return; }
    res.render('transcript', viewModel(req, 'clearlogs', { log, messages: JSON.parse(log.messages) }));
  });

  app.get('/invites', (req, res) => {
    const selectedGuildId = selectedGuildFromRequest(req);
    const logs = selectedGuildId ? database.getInviteLogsByGuild(selectedGuildId, 50) : database.getInviteLogs();
    const leaderboard = selectedGuildId ? database.getInviteLeaderboardByGuild(selectedGuildId, 10) : database.getInviteLeaderboard(10);
    res.render('invites', viewModel(req, 'invites', { logs, leaderboard }));
  });

  app.get('/api/stats', (req, res) => {
    const selectedGuildId = selectedGuildFromRequest(req);
    res.json(buildSyncPayload(client, database, selectedGuildId));
  });

  app.get('/api/command-logs', (req, res) => {
    const selectedGuildId = selectedGuildFromRequest(req);
    const logs = selectedGuildId ? database.getCommandLogsByGuild(selectedGuildId, 50) : database.getCommandLogs().slice(0, 50);
    res.json(logs);
  });

  app.get('/api/clear-logs', (req, res) => {
    const selectedGuildId = selectedGuildFromRequest(req);
    const logs = selectedGuildId ? database.getClearLogsByGuild(selectedGuildId) : database.getClearLogs();
    res.json(logs);
  });

  app.delete('/api/clear-logs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ ok: false, message: 'Invalid id.' }); return; }
    const deleted = database.deleteClearLog(id);
    if (deleted) client.emit('dashboard:clearLogs');
    res.json({ ok: deleted });
  });

  app.post('/api/player/control', async (req, res) => {
    const action = req.body?.action;
    const requestedGuildId = resolveGuildId(req.body?.guildId || req.query?.guildId, client);
    const selectedGuildId = requestedGuildId || resolveGuildId(client.currentTrack?.guildId, client);
    const queue = getActiveQueue(client, selectedGuildId);

    try {
      const idleActive = selectedGuildId ? isIdleLiveActive(client, selectedGuildId) : false;
      debugAudioLog('control:request', `action=${action || 'n/a'}`, `guild=${selectedGuildId || 'n/a'}`, `idleActive=${Boolean(idleActive)}`);

      if (action === 'skip' && selectedGuildId && idleActive) {
        if (idleSkipInFlightByGuild.has(selectedGuildId)) {
          res.status(409).json({ ok: false, message: 'Idle skip already in progress.' });
          return;
        }
        idleSkipInFlightByGuild.add(selectedGuildId);
        try {
          if (!hasIdlePending(client, selectedGuildId)) {
            res.status(400).json({ ok: false, message: 'No next track in pending queue.' });
            return;
          }
          const guild = client.guilds.cache.get(selectedGuildId);
          const session = getIdleLiveSession(client, selectedGuildId);
          const voiceChannelId = session?.connection?.joinConfig?.channelId || null;
          const voiceChannel = (guild && voiceChannelId) ? guild.channels.cache.get(voiceChannelId) : null;
          const textChannel = session?.textChannel || null;
          await startNextPendingTrack(client, guild, voiceChannel, textChannel, { destroyIdleConnection: true });
          client.emit('dashboard:sync');
          res.json({ ok: true, payload: buildSyncPayload(client, database, selectedGuildId) });
          return;
        } finally {
          idleSkipInFlightByGuild.delete(selectedGuildId);
        }
      }

      if (action === 'stop' && selectedGuildId) {
        const pendingCleared = clearIdlePending(client, selectedGuildId);
        client.autoIdleGuilds?.delete(selectedGuildId);
        if (client.emptyQueueTimers?.has(selectedGuildId)) {
          clearTimeout(client.emptyQueueTimers.get(selectedGuildId));
          client.emptyQueueTimers.delete(selectedGuildId);
        }
        if (queue) {
          try { queue.clear(); } catch {}
          try { queue.node.stop(); } catch {}
          try { queue.delete(); } catch {}
        }
        if (idleActive) await stopIdleLive(client, selectedGuildId, { destroyConnection: true });
        if (client.currentTrack?.guildId === selectedGuildId) client.currentTrack = null;
        client.musicEmbedByGuild?.delete(selectedGuildId);
        client.emit('dashboard:sync');
        res.json({ ok: true, pendingCleared, payload: buildSyncPayload(client, database, selectedGuildId) });
        return;
      }

      if (!queue) {
        if (selectedGuildId && idleActive) {
          if (action === 'toggle-pause') {
            toggleIdleLivePause(client, selectedGuildId);
            client.emit('dashboard:sync');
            res.json({ ok: true, payload: buildSyncPayload(client, database, selectedGuildId) });
            return;
          }
          if (action === 'set-volume') {
            const rawValue = Number(req.body?.value);
            if (!Number.isFinite(rawValue)) throw new Error('Invalid volume value.');
            const safeVol = Math.max(0, Math.min(100, Math.round(rawValue)));
            database.setGuildVolume(selectedGuildId, safeVol);
            setIdleLiveVolume(client, selectedGuildId, safeVol);
            client.emit('dashboard:sync');
            res.json({ ok: true, payload: buildSyncPayload(client, database, selectedGuildId) });
            return;
          }
        }
        res.status(404).json({ ok: false, message: 'No active queue.' });
        return;
      }

      switch (action) {
        case 'toggle-pause':
          if (queue.node.isPaused()) queue.node.resume(); else queue.node.pause();
          break;
        case 'skip': {
          if (queue.size <= 0) { queue.node.stop(); break; }
          const skipped = queue.node.skip();
          if (!skipped) queue.node.stop();
          break;
        }
        case 'back':
          if (queue.history.isEmpty()) throw new Error('No previous track in the queue.');
          await queue.history.back();
          break;
        case 'set-volume': {
          const rawValue = Number(req.body?.value);
          if (!Number.isFinite(rawValue)) throw new Error('Invalid volume value.');
          const safeVol = Math.max(0, Math.min(100, Math.round(rawValue)));
          database.setGuildVolume(selectedGuildId, safeVol);
          queue.node.setVolume(safeVol);
          break;
        }
        default:
          res.status(400).json({ ok: false, message: 'Unknown action.' });
          return;
      }

      client.emit('dashboard:sync');
      res.json({ ok: true, payload: buildSyncPayload(client, database, selectedGuildId) });
    } catch (error) {
      console.error('player control error:', error);
      res.status(500).json({ ok: false, message: error.message || 'Player action failed.' });
    }
  });

  io.on('connection', (socket) => {
    const selectedGuildId = resolveGuildId(socket.handshake.query?.guildId, client);
    socket.data.selectedGuildId = selectedGuildId;
    socket.emit('dashboard:sync', buildSyncPayload(client, database, selectedGuildId));
    socket.emit('dashboard:commandLogs', selectedGuildId
      ? database.getCommandLogsByGuild(selectedGuildId, 50)
      : database.getCommandLogs().slice(0, 50));
  });

  client.on('dashboard:sync', () => {
    io.sockets.sockets.forEach((socket) => {
      const selectedGuildId = socket.data?.selectedGuildId || null;
      socket.emit('dashboard:sync', buildSyncPayload(client, database, selectedGuildId));
    });
  });

  client.on('dashboard:commandLogs', () => {
    io.sockets.sockets.forEach((socket) => {
      const selectedGuildId = socket.data?.selectedGuildId || null;
      const logs = selectedGuildId
        ? database.getCommandLogsByGuild(selectedGuildId, 50)
        : database.getCommandLogs().slice(0, 50);
      socket.emit('dashboard:commandLogs', logs);
    });
  });

  client.on('dashboard:clearLogs', () => {
    io.sockets.sockets.forEach((socket) => {
      const selectedGuildId = socket.data?.selectedGuildId || null;
      const logs = selectedGuildId
        ? database.getClearLogsByGuild(selectedGuildId)
        : database.getClearLogs();
      socket.emit('dashboard:clearLogs', logs);
    });
  });

  const activePort = await listenWithFallback(server, preferredPort);
  client.dashboardInfo = { port: activePort };
  if (activePort !== preferredPort) console.warn(`Port ${preferredPort} is busy. Dashboard started on port ${activePort}.`);
  console.log(`Dashboard running at http://localhost:${activePort}`);

  return { app, server, io };
}

module.exports = startDashboard;
