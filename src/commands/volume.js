const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  category: 'Music',
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
  }
};

