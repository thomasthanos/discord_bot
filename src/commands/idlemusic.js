const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { startIdleLive, isIdleLiveActive } = require('../idle-live');

const DEBUG_AUDIO = String(process.env.DEBUG_AUDIO || '0') !== '0';

function debugAudioLog(...parts) {
  if (!DEBUG_AUDIO) return;
  console.log('[DEBUG_AUDIO]', ...parts);
}

module.exports = {
  category: 'Music',
  aliases: ['im', 'ιμ'],
  data: new SlashCommandBuilder()
    .setName('idlemusic')
    .setDescription('Play the fixed idle music track.'),

  async execute(interaction, client) {
    debugAudioLog('idlemusic:command', `guild=${interaction.guildId || 'n/a'}`, `user=${interaction.user?.id || 'n/a'}`);

    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command works only inside servers.', flags: MessageFlags.Ephemeral });
      return;
    }

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      await interaction.deferReply();
    } catch (error) {
      if (error?.code === 10062 || error?.code === 40060) {
        return;
      }
      throw error;
    }

    try {
      const existingQueue = client.player.nodes.get(interaction.guild.id);
      const currentTrack = existingQueue?.currentTrack;
      debugAudioLog(
        'idlemusic:queue-state-before',
        `hasQueue=${Boolean(existingQueue)}`,
        `hasConnection=${Boolean(existingQueue?.connection)}`,
        `current=${currentTrack?.title || 'none'}`
      );

      if (isIdleLiveActive(client, interaction.guild.id)) {
        await interaction.editReply('Idle music is already playing.');
        return;
      }

      if (existingQueue && (!existingQueue.connection || existingQueue.channel?.id !== voiceChannel.id)) {
        try {
          await existingQueue.connect(voiceChannel);
        } catch {
          await interaction.editReply('Could not move to your voice channel.');
          return;
        }
      }

      const hasActivePlayback =
        Boolean(existingQueue?.currentTrack) ||
        Boolean(existingQueue?.isPlaying?.()) ||
        Number(existingQueue?.size || 0) > 0;
      if (hasActivePlayback) {
        await interaction.editReply('Queue is active. Use `/stop` first, then run `/idlemusic`.');
        return;
      }

      const { track } = await startIdleLive(
        client,
        interaction.guild,
        voiceChannel,
        interaction.channel,
        interaction.user
      );
      client.autoIdleGuilds?.add(interaction.guild.id);
      debugAudioLog(
        'idlemusic:command-success',
        `title=${track?.title || 'n/a'}`,
        `author=${track?.author || 'n/a'}`,
        `duration=${track?.duration || 'n/a'}`,
        `url=${track?.url || 'n/a'}`
      );
      await interaction.editReply(`Idle music enabled: **${track.title}**`);
    } catch (error) {
      console.error('idlemusic command error:', error);
      await interaction.editReply('Could not start idle music.');
    }
  },

  async prefixExecute(message, argsText, client) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      await message.reply('Join a voice channel first.');
      return;
    }

    if (isIdleLiveActive(client, message.guild.id)) {
      await message.reply('Idle music is already playing.');
      return;
    }

    const queue = client.player?.nodes?.get(message.guild.id) || null;
    if (queue && (!queue.connection || queue.channel?.id !== voiceChannel.id)) {
      try {
        await queue.connect(voiceChannel);
      } catch {
        await message.reply('Could not move to your voice channel.');
        return;
      }
    }

    const hasActivePlayback =
      Boolean(queue?.currentTrack) ||
      Boolean(queue?.isPlaying?.()) ||
      Number(queue?.size || 0) > 0;
    if (hasActivePlayback) {
      await message.reply('Queue is active. Use `/stop` first, then run `!idlemusic`.');
      return;
    }

    try {
      const { track } = await startIdleLive(
        client,
        message.guild,
        voiceChannel,
        message.channel,
        message.author,
      );
      client.autoIdleGuilds?.add(message.guild.id);
      await message.reply(`Idle music enabled: **${track.title}**`);
      client.emit('dashboard:sync');
    } catch (error) {
      console.error('idlemusic prefix error:', error?.message || error);
      await message.reply('Could not start idle music.');
    }
  }
};
