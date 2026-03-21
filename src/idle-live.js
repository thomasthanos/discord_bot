const { spawn } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');

const IDLE_MUSIC_URL = 'https://www.youtube.com/watch?v=4xDzrJKXOOY';
const DEBUG_AUDIO = String(process.env.DEBUG_AUDIO || '0') !== '0';

function debugAudioLog(...parts) {
  if (!DEBUG_AUDIO) return;
  console.log('[DEBUG_AUDIO]', ...parts);
}

function getSessionsMap(client) {
  if (!client.idleLiveSessions) client.idleLiveSessions = new Map();
  return client.idleLiveSessions;
}

async function resolveLiveStream() {
  const info = await youtubedl(IDLE_MUSIC_URL, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificates: true,
    skipDownload: true,
    preferFreeFormats: true,
    format: 'bestaudio/best'
  });

  if (!info?.url) {
    throw new Error('Could not resolve live stream URL.');
  }

  return {
    streamUrl: info.url,
    title: info.title || 'Idle Live Music',
    author: info.uploader || 'Unknown',
    thumbnail: info.thumbnail || info?.thumbnails?.[0]?.url || null
  };
}

async function stopIdleLive(client, guildId, options = {}) {
  const { destroyConnection = true } = options;
  const sessions = getSessionsMap(client);
  const session = sessions.get(guildId);
  if (!session) return false;

  session.stopping = true;
  try {
    if (session.restartTimer) clearTimeout(session.restartTimer);
    session.player?.stop(true);
    session.ffmpeg?.kill('SIGKILL');
    if (destroyConnection) {
      session.connection?.destroy();
    }
  } catch {}

  sessions.delete(guildId);
  if (client.currentTrack?.guildId === guildId) {
    client.currentTrack = null;
    client.emit('dashboard:sync');
  }
  debugAudioLog('idle-live:stopped', `guild=${guildId}`);
  return true;
}

async function startIdleLive(client, guild, voiceChannel, textChannel, requestedBy) {
  const sessions = getSessionsMap(client);
  await stopIdleLive(client, guild.id);

  const queue = client.player?.nodes?.get(guild.id);
  if (queue) {
    try { queue.delete(); } catch {}
  }

  let connection = getVoiceConnection(guild.id);
  if (connection) {
    try { connection.destroy(); } catch {}
  }

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 15000);

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play }
  });
  connection.subscribe(player);

  const session = {
    guildId: guild.id,
    connection,
    player,
    ffmpeg: null,
    resource: null,
    restartTimer: null,
    stopping: false,
    paused: false,
    volume: 50,
    textChannel,
    requestedBy
  };
  sessions.set(guild.id, session);

  const playFromSource = async () => {
    if (session.stopping) return;

    const source = await resolveLiveStream();
    debugAudioLog(
      'idle-live:resolved',
      `guild=${guild.id}`,
      `title=${source.title}`,
      `stream=${source.streamUrl.slice(0, 96)}...`
    );

    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', source.streamUrl,
      '-vn',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    session.ffmpeg = ffmpeg;
    ffmpeg.stderr.on('data', (chunk) => {
      if (!DEBUG_AUDIO) return;
      const line = chunk.toString().trim();
      if (line) console.log('[DEBUG_AUDIO] idle-live:ffmpeg', line);
    });

    ffmpeg.on('close', (code) => {
      debugAudioLog('idle-live:ffmpeg-close', `guild=${guild.id}`, `code=${code}`);
    });

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    if (resource.volume) {
      resource.volume.setVolume(Math.max(0, Math.min(1, session.volume / 100)));
    }
    session.resource = resource;
    player.play(resource);

    client.currentTrack = {
      title: source.title,
      author: source.author,
      url: IDLE_MUSIC_URL,
      thumbnail: source.thumbnail,
      duration: 'LIVE',
      guildId: guild.id,
      requestedBy: requestedBy?.username || requestedBy?.tag || 'Unknown',
      startedAt: Date.now()
    };
    client.emit('dashboard:sync');

    return {
      track: {
        title: source.title,
        author: source.author,
        url: IDLE_MUSIC_URL,
        duration: 'LIVE',
        thumbnail: source.thumbnail
      }
    };
  };

  player.on(AudioPlayerStatus.Idle, async () => {
    if (session.stopping) return;
    debugAudioLog('idle-live:player-idle', `guild=${guild.id}`);
    session.restartTimer = setTimeout(async () => {
      try { await playFromSource(); }
      catch (error) { console.error('idle-live restart failed:', error?.message || error); }
    }, 1500);
  });

  player.on('error', async (error) => {
    if (session.stopping) return;
    console.error('idle-live player error:', error?.message || error);
    session.restartTimer = setTimeout(async () => {
      try { await playFromSource(); }
      catch (restartError) { console.error('idle-live restart after error failed:', restartError?.message || restartError); }
    }, 1500);
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    debugAudioLog('idle-live:voice-disconnected', `guild=${guild.id}`);
  });

  const result = await playFromSource();
  if (textChannel) {
    textChannel.send(`Now playing: **${result.track.title}** by **${result.track.author}**`).catch(() => {});
  }

  return result;
}

function isIdleLiveActive(client, guildId) {
  return getSessionsMap(client).has(guildId);
}

function getIdleLiveSession(client, guildId) {
  return getSessionsMap(client).get(guildId) || null;
}

function setIdleLiveVolume(client, guildId, volume) {
  const session = getIdleLiveSession(client, guildId);
  if (!session) return false;
  const safe = Math.max(0, Math.min(100, Math.round(Number(volume))));
  session.volume = safe;
  if (session.resource?.volume) {
    session.resource.volume.setVolume(safe / 100);
  }
  return true;
}

function toggleIdleLivePause(client, guildId) {
  const session = getIdleLiveSession(client, guildId);
  if (!session) return null;
  if (session.paused) {
    session.player.unpause();
    session.paused = false;
  } else {
    session.player.pause();
    session.paused = true;
  }
  return { paused: session.paused };
}

module.exports = {
  startIdleLive,
  stopIdleLive,
  isIdleLiveActive,
  getIdleLiveSession,
  setIdleLiveVolume,
  toggleIdleLivePause
};
