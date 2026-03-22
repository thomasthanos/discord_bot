const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { QueryType } = require('discord-player');
const { isIdleLiveActive } = require('../idle-live');
const { enqueueIdlePending, getIdlePendingCount } = require('../idle-pending');
const DEBUG_AUDIO = String(process.env.DEBUG_AUDIO || '0') !== '0';

function debugAudioLog(...parts) {
  if (!DEBUG_AUDIO) return;
  console.log('[DEBUG_AUDIO]', ...parts);
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

function ensureVoiceQueue(message, client) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return null;

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
    return queue.connect(voiceChannel).then(() => ({ queue, voiceChannel }));
  }

  return Promise.resolve({ queue, voiceChannel });
}

module.exports = {
  category: 'Music',
  aliases: ['p', 'π'],
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song in your current voice channel.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Song URL or search query')
        .setRequired(true)
    ),

  async execute(interaction, client) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command works only inside servers.', flags: MessageFlags.Ephemeral });
      return;
    }

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: 'Join a voice channel first.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    const looksLikeUrl = /^https?:\/\//i.test(query);
    const isSpotifyUrl = /open\.spotify\.com\/(track|album|playlist)\//i.test(query);

    let effectiveQuery = query;
    if (isSpotifyUrl) {
      const mapped = await resolveSpotifyToSearchQuery(query);
      if (mapped) effectiveQuery = mapped;
    }

    // Switch to normal playback mode when user explicitly uses /play.
    client.autoIdleGuilds?.delete(interaction.guildId);

    if (isIdleLiveActive(client, interaction.guildId)) {
      const searchEngine = isSpotifyUrl
        ? QueryType.YOUTUBE_SEARCH
        : (looksLikeUrl ? QueryType.AUTO : QueryType.YOUTUBE_SEARCH);
      await enqueueIdlePending(client, interaction.guildId, {
        query: effectiveQuery,
        searchEngine,
        requestedBy: interaction.user,
        textChannel: interaction.channel
      });
      const pending = getIdlePendingCount(client, interaction.guildId);
      debugAudioLog(
        'play:queued-during-idle',
        `guild=${interaction.guildId}`,
        `pending=${pending}`,
        `query=${effectiveQuery.slice(0, 80)}`
      );
      await interaction.reply({
        content: `Queued while idle is playing. Pending: **${pending}**. Use skip to start.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply();

    const playOptions = {
      requestedBy: interaction.user,
      searchEngine: isSpotifyUrl
        ? QueryType.YOUTUBE_SEARCH
        : (looksLikeUrl ? QueryType.AUTO : QueryType.YOUTUBE_SEARCH),
      fallbackSearchEngine: QueryType.YOUTUBE_SEARCH,
      nodeOptions: {
        metadata: { channel: interaction.channel },
        leaveOnEnd: true,
        leaveOnEndCooldown: 300000,
        leaveOnStop: true,
        leaveOnStopCooldown: 120000
      }
    };

    try {
      const { track } = await client.player.play(voiceChannel, effectiveQuery, playOptions);
      await interaction.editReply(`Now playing: **${track.title}**`);
    } catch (error) {
      console.error('play primary attempt failed:', error.message || error);
      try {
        const { track } = await client.player.play(voiceChannel, effectiveQuery, {
          ...playOptions,
          searchEngine: QueryType.YOUTUBE_SEARCH
        });
        await interaction.editReply(`Now playing (fallback): **${track.title}**`);
      } catch (fallbackError) {
        console.error('play fallback failed:', fallbackError.message || fallbackError);
        await interaction.editReply('Could not play that query. Try another URL or search phrase.');
      }
    }
  },

  async prefixExecute(message, argsText, client) {
    if (!argsText) {
      await message.reply('Usage: `!play <query>` or `!p`');
      return;
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      await message.reply('Join a voice channel first.');
      return;
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
      return;
    }

    const result = await ensureVoiceQueue(message, client);
    if (!result) {
      await message.reply('Join a voice channel first.');
      return;
    }

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

    client.emit('dashboard:sync');
  }
};
