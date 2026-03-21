const { MessageFlags } = require('discord.js');

function getBotOwnerIds() {
  const raw = [process.env.BOT_OWNER_ID, process.env.BOT_OWNER_IDS]
    .filter(Boolean)
    .join(',');

  return new Set(
    String(raw)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function isBotOwner(userId) {
  if (!userId) return false;
  return getBotOwnerIds().has(String(userId));
}

function isGuildOwner(interaction) {
  return Boolean(interaction?.guild && interaction?.user && interaction.guild.ownerId === interaction.user.id);
}

function canManageAuthorization(interaction) {
  const userId = interaction?.user?.id || null;
  return isBotOwner(userId) || isGuildOwner(interaction);
}

function isCommandAuthorized(interaction, database, commandName) {
  if (!interaction?.inGuild?.()) return false;
  if (!commandName) return false;

  if (canManageAuthorization(interaction)) return true;

  return database.isAuthorizedUser(interaction.guildId, commandName, interaction.user.id);
}

async function replyUnauthorized(interaction, commandLabel = 'this command') {
  const payload = {
    content: `You are not authorized to use ${commandLabel}.`,
    flags: MessageFlags.Ephemeral
  };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

module.exports = {
  isBotOwner,
  isGuildOwner,
  canManageAuthorization,
  isCommandAuthorized,
  replyUnauthorized
};
