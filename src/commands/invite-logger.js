const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

function formatTimeAgo(timestamp) {
  const then = new Date(timestamp).getTime();
  const diffMs = Math.max(0, Date.now() - then);
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

module.exports = {
  category: 'Invites',
  data: new SlashCommandBuilder()
    .setName('invite-logger')
    .setDescription('Show invite leaderboard and recent joins for this server.')
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

    const limit = interaction.options?.getInteger?.('limit') || 5;
    const guildId = interaction.guildId;

    const recent = database.getInviteLogsByGuild(guildId, limit);
    const leaderboard = database.getInviteLeaderboardByGuild(guildId, limit);

    if (!recent.length && !leaderboard.length) {
      await interaction.reply({ content: 'No invite logs yet for this server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const topValue = leaderboard.length
      ? leaderboard.map((row, i) => `**#${i + 1}** ${row.inviter_tag} — **${row.total_invites}** invites`).join('\n')
      : 'No data yet.';

    const recentValue = recent.length
      ? recent.map((row) => {
          const code = row.invite_code || '?';
          const ago = formatTimeAgo(row.timestamp);
          return `**${row.invited_tag}** invited by ${row.inviter_tag} (${code}) • ${ago}`;
        }).join('\n')
      : 'No recent joins.';

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`📨 Invite Tracker — ${interaction.guild.name}`)
      .addFields(
        { name: '🏆 Top Inviters', value: topValue, inline: false },
        { name: '🕐 Recent Joins', value: recentValue, inline: false }
      )
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [embed] });
    client.emit('dashboard:sync');
  }
};
