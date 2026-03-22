const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { canManageAuthorization } = require('../utils/authorization');

// Commands that can be restricted — addauthorized and help are always public
const AUTHORIZABLE_COMMANDS = [
  'wipe-channel',
  'invite-logger',
];

function parseUserId(raw) {
  if (!raw) return null;
  const mentionMatch = raw.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  return /^\d+$/.test(raw) ? raw : null;
}

module.exports = {
  category: 'Admin',
  aliases: ['aa', 'αα'],
  data: new SlashCommandBuilder()
    .setName('addauthorized')
    .setDescription('Authorize or remove a user for a specific command (server owner only).')
    .addStringOption((option) =>
      option
        .setName('command')
        .setDescription('Which command to restrict')
        .setRequired(true)
        .setAutocomplete(true)
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
        .setDescription('Add or remove authorization')
        .setRequired(false)
        .addChoices(
          { name: '✅ Add', value: 'add' },
          { name: '❌ Remove', value: 'remove' }
        )
    ),

  async autocomplete(interaction, client, database) {
    const focused = interaction.options.getFocused().toLowerCase();

    const choices = AUTHORIZABLE_COMMANDS
      .filter((cmd) => cmd.includes(focused))
      .map((cmd) => ({ name: `/${cmd}`, value: cmd }));

    await interaction.respond(choices);
  },

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

    if (!AUTHORIZABLE_COMMANDS.includes(commandName)) {
      await interaction.reply({
        content: `\`/${commandName}\` cannot be restricted. Choose from: ${AUTHORIZABLE_COMMANDS.map((c) => `\`/${c}\``).join(', ')}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (mode === 'remove') {
      const removed = database.removeAuthorizedUser(interaction.guildId, commandName, user.id);

      const embed = new EmbedBuilder()
        .setColor(removed ? 0xe74c3c : 0x95a5a6)
        .setDescription(removed
          ? `✅ Removed authorization: <@${user.id}> can no longer use \`/${commandName}\`.`
          : `⚠️ <@${user.id}> was not authorized for \`/${commandName}\`.`
        );

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    database.addAuthorizedUser(interaction.guildId, commandName, user, interaction.user);

    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setDescription(`✅ <@${user.id}> is now authorized to use \`/${commandName}\`.`)
      .setFooter({ text: `Use /addauthorized again with mode: Remove to undo.` });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },

  async prefixExecute(message, argsText, client, database) {
    const pseudoInteraction = { user: message.author, guild: message.guild };
    if (!canManageAuthorization(pseudoInteraction)) {
      await message.reply('Only the server owner can manage authorization.');
      return;
    }

    const args = argsText.split(/\s+/);
    const targetCommand = (args[0] || '').toLowerCase();
    const targetUserId = parseUserId(args[1] || '');
    const mode = (args[2] || 'add').toLowerCase();

    if (!targetCommand || !targetUserId || !['add', 'remove'].includes(mode)) {
      await message.reply('Usage: `!aa <command> <@user|userId> [add|remove]`');
      return;
    }

    const user = await client.users.fetch(targetUserId).catch(() => null);
    if (!user) {
      await message.reply('User not found.');
      return;
    }

    if (!client.commands.has(targetCommand)) {
      await message.reply(`Command \`${targetCommand}\` does not exist.`);
      return;
    }

    if (!AUTHORIZABLE_COMMANDS.includes(targetCommand)) {
      await message.reply(`\`${targetCommand}\` cannot be restricted. Allowed: ${AUTHORIZABLE_COMMANDS.map(c => `\`${c}\``).join(', ')}`);
      return;
    }

    if (mode === 'remove') {
      const removed = database.removeAuthorizedUser(message.guild.id, targetCommand, user.id);
      await message.reply(removed
        ? `Removed authorization for <@${user.id}> on \`/${targetCommand}\`.`
        : `<@${user.id}> was not authorized for \`/${targetCommand}\`.`);
    } else {
      database.addAuthorizedUser(message.guild.id, targetCommand, user, message.author);
      await message.reply(`Authorized <@${user.id}> for \`/${targetCommand}\`.`);
    }
  }
};
