const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { stopIdleLive, isIdleLiveActive } = require('../idle-live');
const { clearIdlePending } = require('../idle-pending');

module.exports = {
  category: 'Music',
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop music and clear the queue/pending list.'),

  async execute(interaction, client) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command works only inside servers.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guildId = interaction.guildId;
    const queue = client.player?.nodes?.get(guildId) || null;
    const idleActive = isIdleLiveActive(client, guildId);
    const pendingCleared = clearIdlePending(client, guildId);
    client.autoIdleGuilds?.delete(guildId);

    try {
      if (queue) {
        try {
          queue.clear();
        } catch {}
        try {
          queue.node.stop();
        } catch {}
        try {
          queue.delete();
        } catch {}
      }

      if (idleActive) {
        await stopIdleLive(client, guildId, { destroyConnection: true });
      }

      if (client.currentTrack?.guildId === guildId) {
        client.currentTrack = null;
      }
      client.emit('dashboard:sync');

      await interaction.reply(
        `Stopped. Cleared queue and pending (${pendingCleared}).`
      );
    } catch (error) {
      console.error('stop command error:', error);
      await interaction.reply({
        content: 'Could not stop music right now.',
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
