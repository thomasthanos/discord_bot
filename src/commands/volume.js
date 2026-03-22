const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  category: 'Music',
  aliases: ['v', 'β'],
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or change player volume (0-100).')
    .addIntegerOption((option) =>
      option
        .setName('level')
        .setDescription('Volume level from 0 to 100')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(false)
    ),

  async execute(interaction, client) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const queue = client.player?.nodes?.get(interaction.guildId);
    if (!queue || (!queue.currentTrack && !queue.isPlaying())) {
      await interaction.reply({ content: 'No active music queue in this server right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    const level = interaction.options.getInteger('level', false);
    if (level === null) {
      await interaction.reply(`Current volume: **${queue.node.volume}%**`);
      return;
    }

    const changed = queue.node.setVolume(level);
    if (!changed) {
      await interaction.reply({ content: 'Could not change volume right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    client.emit('dashboard:sync');
    await interaction.reply(`Volume set to **${level}%**`);
  },

  async prefixExecute(message, argsText, client) {
    const queue = client.player?.nodes?.get(message.guild.id);
    if (!queue || (!queue.currentTrack && !queue.isPlaying())) {
      await message.reply('No active music queue in this server.');
      return;
    }

    if (!argsText) {
      await message.reply(`Volume: **${queue.node.volume}%**`);
      return;
    }

    const level = Number.parseInt(argsText, 10);
    if (!Number.isInteger(level) || level < 0 || level > 100) {
      await message.reply('Usage: `!v <0-100>`');
      return;
    }

    const changed = queue.node.setVolume(level);
    await message.reply(changed ? `Volume set: **${level}%**` : 'Volume did not change.');
    client.emit('dashboard:sync');
  }
};
