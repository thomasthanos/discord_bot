const { SlashCommandBuilder } = require('discord.js');

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Shows bot and dashboard statistics.'),

  async execute(interaction, client, database) {
    const stats = database.getStats();
    const users = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

    await interaction.reply({
      content: [
        `Servers: ${client.guilds.cache.size}`,
        `Users: ${users}`,
        `Commands used: ${stats.totalCommands}`,
        `Songs played: ${stats.songsPlayed}`,
        `Messages cleared: ${stats.totalCleared}`,
        `Uptime: ${formatUptime(Date.now() - stats.startTime)}`
      ].join('\n')
    });
  }
};
