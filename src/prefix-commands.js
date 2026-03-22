const { isCommandAuthorized } = require('./utils/authorization');

const PREFIX = '!';

function normalizeAlias(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Built lazily on first prefix message from client.commands
let aliasMap = null;

function getAliasMap(client) {
  if (aliasMap) return aliasMap;
  aliasMap = new Map();

  client.commands.forEach((cmd) => {
    const name = cmd.data.name;
    aliasMap.set(normalizeAlias(name), name);

    if (Array.isArray(cmd.aliases)) {
      for (const alias of cmd.aliases) {
        aliasMap.set(normalizeAlias(alias), name);
      }
    }
  });

  return aliasMap;
}

function canUseCommand(message, database, commandName) {
  if (!message.guild) return false;
  if (!database.hasAuthorizedEntriesForCommand(message.guild.id, commandName)) return true;
  const pseudoInteraction = {
    inGuild: () => Boolean(message.guild),
    user: message.author,
    guild: message.guild,
    guildId: message.guild.id
  };
  return isCommandAuthorized(pseudoInteraction, database, commandName);
}

async function handlePrefixMessage(message, client, database, emitCommandLogsSync, emitDashboardSync) {
  if (!message.guild || message.author.bot) return false;
  if (!message.content.startsWith(PREFIX)) return false;

  const withoutPrefix = message.content.slice(PREFIX.length).trim();
  if (!withoutPrefix) return false;

  const [rawAlias] = withoutPrefix.split(/\s+/);
  const argsText = withoutPrefix.slice(rawAlias.length).trim();

  const map = getAliasMap(client);
  const commandName = map.get(normalizeAlias(rawAlias));
  if (!commandName) return false;

  const command = client.commands.get(commandName);
  if (!command) return false;

  if (!canUseCommand(message, database, commandName)) {
    await message.reply(`You are not authorized to use \`!${rawAlias}\`.`);
    return true;
  }

  database.logCommand(commandName, message.author, message.guild, message.channel.id);
  emitCommandLogsSync();

  try {
    if (typeof command.prefixExecute === 'function') {
      await command.prefixExecute(message, argsText, client, database);
    } else if (command.prefixRedirect) {
      await message.reply(`Use \`/${commandName}\` for this command.`);
    } else {
      await message.reply(`Use \`/${commandName}\` for this command.`);
    }
  } catch (error) {
    console.error(`prefix ${commandName} error:`, error);
    await message.reply('Prefix command failed.');
  }

  emitDashboardSync();
  return true;
}

module.exports = {
  PREFIX,
  handlePrefixMessage
};
