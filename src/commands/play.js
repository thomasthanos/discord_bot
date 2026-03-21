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

module.exports = {
  category: 'Music',
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
  }
};
