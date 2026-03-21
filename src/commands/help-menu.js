const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  category: 'General',
  data: new SlashCommandBuilder()
    .setName('help-menu')
    .setDescription('Show a modern help menu with command categories.'),

  async execute(interaction, client) {
    const grouped = new Map();
    client.commands.forEach((command) => {
      const category = command.category || command.meta?.category || 'General';
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(command.data.name);
    });

    const fields = Array.from(grouped.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, names]) => ({
        name: `${category} (${names.length})`,
        value: names.sort().map((name) => `\`/${name}\``).join(' '),
        inline: false
      }));

    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle('Help Menu')
      .setDescription('Available commands grouped by category.')
      .addFields(fields.slice(0, 25))
      .setFooter({ text: `Total Commands: ${client.commands.size}` })
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [embed] });
  }
};
