const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Shows the current playing track from the dashboard sync state.'),

  async execute(interaction, client) {
    if (!client.currentTrack) {
      await interaction.reply('No track is playing right now.');
      return;
    }

    const track = client.currentTrack;
    await interaction.reply({
      content: [
        `Now playing: ${track.title}`,
        `Artist: ${track.author}`,
        `Duration: ${track.duration || 'Unknown'}`,
        track.url ? `URL: ${track.url}` : null
      ].filter(Boolean).join('\n')
    });
  }
};
