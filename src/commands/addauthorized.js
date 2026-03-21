const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { canManageAuthorization } = require('../utils/authorization');

module.exports = {
  category: 'Admin',
  data: new SlashCommandBuilder()
    .setName('addauthorized')
    .setDescription('Authorize or remove a user for a specific command (server owner only).')
    .addStringOption((option) =>
      option
        .setName('command')
        .setDescription('Command name, e.g. wipe-channel')
        .setRequired(true)
    )
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to authorize/remove')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Whether to add or remove authorization')
        .setRequired(false)
        .addChoices(
          { name: 'add', value: 'add' },
          { name: 'remove', value: 'remove' }
        )
    ),

  async execute(interaction, client, database) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command works only inside servers.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!canManageAuthorization(interaction)) {
      await interaction.reply({
        content: 'Only the server owner can manage command authorization.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const commandName = interaction.options.getString('command', true).trim().toLowerCase();
    const user = interaction.options.getUser('user', true);
    const mode = interaction.options.getString('mode') || 'add';

    if (!client.commands.has(commandName)) {
      await interaction.reply({
        content: `Command \`${commandName}\` does not exist.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (mode === 'remove') {
      const removed = database.removeAuthorizedUser(interaction.guildId, commandName, user.id);
      await interaction.reply({
        content: removed
          ? `Removed authorization: <@${user.id}> can no longer use \`/${commandName}\`.`
          : `<@${user.id}> was not authorized for \`/${commandName}\`.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    database.addAuthorizedUser(interaction.guildId, commandName, user, interaction.user);
    await interaction.reply({
      content: `Authorized <@${user.id}> for \`/${commandName}\`.`,
      flags: MessageFlags.Ephemeral
    });
  }
};
