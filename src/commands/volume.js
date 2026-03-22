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

  async execute(interaction, client, database) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const { isIdleLiveActive, setIdleLiveVolume } = require('../idle-live');
    const queue = client.player?.nodes?.get(interaction.guildId);
    const idleActive = isIdleLiveActive(client, interaction.guildId);

    if (!queue && !idleActive) {
      await interaction.reply({ content: 'No active music in this server right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    const level = interaction.options.getInteger('level', false);
    if (level === null) {
      const current = queue ? queue.node.volume : database.getGuildVolume(interaction.guildId);
      await interaction.reply(`Current volume: **${current}%**`);
      return;
    }

    database.setGuildVolume(interaction.guildId, level);
    if (queue) queue.node.setVolume(level);
    if (idleActive) setIdleLiveVolume(client, interaction.guildId, level);

    client.emit('dashboard:sync');
    await interaction.reply(`Volume set to **${level}%**`);
  },

  async prefixExecute(message, argsText, client, database) {
    const { isIdleLiveActive, setIdleLiveVolume } = require('../idle-live');
    const queue = client.player?.nodes?.get(message.guild.id);
    const idleActive = isIdleLiveActive(client, message.guild.id);

    if (!queue && !idleActive) {
      await message.reply('No active music in this server.');
      return;
    }

    if (!argsText) {
      const current = queue ? queue.node.volume : database.getGuildVolume(message.guild.id);
      await message.reply(`Volume: **${current}%**`);
      return;
    }

    const level = Number.parseInt(argsText, 10);
    if (!Number.isInteger(level) || level < 0 || level > 100) {
      await message.reply('Usage: `!v <0-100>`');
      return;
    }

    database.setGuildVolume(message.guild.id, level);
    if (queue) queue.node.setVolume(level);
    if (idleActive) setIdleLiveVolume(client, message.guild.id, level);

    await message.reply(`Volume set: **${level}%**`);
    client.emit('dashboard:sync');
  }
};
