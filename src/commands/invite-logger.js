const { SlashCommandBuilder, MessageFlags } = require('discord.js');

function formatTimeAgo(timestamp) {
  const then = new Date(timestamp).getTime();
  const diffMs = Math.max(0, Date.now() - then);
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `about ${days} day(s) ago`;
  if (hours > 0) return `about ${hours} hour(s) ago`;
  if (mins > 0) return `${mins} minute(s) ago`;
  return 'just now';
}

module.exports = {
  category: 'Invites',
  data: new SlashCommandBuilder()
    .setName('invite-logger')
    .setDescription('Show invite tracker data (recent joins + leaderboard) for this server.')
    .addIntegerOption((option) =>
      option
        .setName('limit')
        .setDescription('How many rows to show (3-10)')
        .setRequired(false)
        .setMinValue(3)
        .setMaxValue(10)
    ),

  async execute(interaction, client, database) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command works only inside servers.', flags: MessageFlags.Ephemeral });
      return;
    }

    const limit = interaction.options.getInteger('limit') || 5;
    const guildId = interaction.guildId;

    const recent = database.getInviteLogsByGuild(guildId, limit);
    const leaderboard = database.getInviteLeaderboardByGuild(guildId, limit);

    if (!recent.length && !leaderboard.length) {
      await interaction.reply('No invite logs yet for this server.');
      return;
    }

    const recentLines = recent.length
      ? recent.map((row) => {
        const inviter = row.inviter_tag || 'Unknown';
        const invited = row.invited_tag || 'Unknown';
        const code = row.invite_code || 'unknown';
        const ago = formatTimeAgo(row.timestamp);
        return `- ${inviter} -> ${invited} (${code}) - ${ago}`;
      }).join('\n')
      : '- No recent joins';

    const topLines = leaderboard.length
      ? leaderboard.map((row, index) => `- #${index + 1} ${row.inviter_tag}: ${row.total_invites}`).join('\n')
      : '- No leaderboard data';

    await interaction.reply([
      `**Invite Tracker (${interaction.guild.name})**`,
      '',
      '**Top Inviters**',
      topLines,
      '',
      '**Recent Joins**',
      recentLines
    ].join('\n'));

    client.emit('dashboard:sync');
  }
};
