const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');

// Metadata per category: emoji and color
// Commands are read dynamically from client.commands at runtime
const CATEGORY_META = {
  Music:      { emoji: '🎵', color: 0x1db954 },
  Moderation: { emoji: '🛡️', color: 0xe74c3c },
  Invites:    { emoji: '📨', color: 0x3498db },
  Admin:      { emoji: '⚙️', color: 0xe67e22 },
  General:    { emoji: '📋', color: 0x9b59b6 },
};

const DEFAULT_META = { emoji: '📦', color: 0x95a5a6 };

// Read aliases dynamically from each command module
function getPrefixAliasLabel(cmd) {
  if (!Array.isArray(cmd.aliases) || !cmd.aliases.length) return '';
  return cmd.aliases.map((a) => `\`!${a}\``).join(' ');
}

function buildCategories(client) {
  const map = new Map();
  client.commands.forEach((cmd) => {
    const cat = cmd.category || 'General';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(cmd);
  });
  return map;
}

function buildCategoryEmbed(client, categoryKey) {
  const meta = CATEGORY_META[categoryKey] || DEFAULT_META;
  const cats = buildCategories(client);
  const commands = cats.get(categoryKey) || [];

  const fields = commands.map((cmd) => ({
    name: `\`/${cmd.data.name}\``,
    value: `${cmd.data.description}\n${getPrefixAliasLabel(cmd)}`.trim(),
    inline: true
  }));

  return new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${categoryKey}`)
    .setDescription(`**${categoryKey}** commands — slash \`/\` or prefix \`!\``)
    .addFields(fields)
    .setFooter({ text: `!help or /help • ${categoryKey} category` })
    .setTimestamp(new Date());
}

function buildOverviewEmbed(client) {
  const cats = buildCategories(client);
  const fields = [];

  for (const [key, commands] of cats.entries()) {
    const meta = CATEGORY_META[key] || DEFAULT_META;
    fields.push({
      name: `${meta.emoji} ${key}`,
      value: commands.map((c) => `\`/${c.data.name}\``).join(' '),
      inline: false
    });
  }

  return new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle('📋 Help Menu')
    .setDescription('Select a category below to see detailed commands.\nAll commands work as `/slash` and `!prefix`.')
    .addFields(fields)
    .setFooter({ text: `Total: ${client.commands.size} commands` })
    .setTimestamp(new Date());
}

function buildButtons(client, activeCategory = null) {
  const cats = buildCategories(client);
  const row = new ActionRowBuilder();
  for (const [key] of cats.entries()) {
    const meta = CATEGORY_META[key] || DEFAULT_META;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`help_cat_${key}`)
        .setLabel(`${meta.emoji} ${key}`)
        .setStyle(activeCategory === key ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
  }
  return row;
}

function buildDisabledButtons(client) {
  const cats = buildCategories(client);
  const row = new ActionRowBuilder();
  for (const [key] of cats.entries()) {
    const meta = CATEGORY_META[key] || DEFAULT_META;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`help_cat_${key}`)
        .setLabel(`${meta.emoji} ${key}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
  }
  return row;
}

module.exports = {
  category: 'General',
  aliases: ['h', 'η'],
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show a modern help menu with command categories.'),

  async execute(interaction, client) {
    const overviewEmbed = buildOverviewEmbed(client);
    const row = buildButtons(client);

    const userId = interaction.user?.id || interaction.author?.id;
    const reply = await interaction.reply({
      embeds: [overviewEmbed],
      components: [row],
      fetchReply: true
    });

    if (typeof reply.createMessageComponentCollector !== 'function') return;

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000,
      filter: (i) => i.user.id === userId && i.customId.startsWith('help_cat_')
    });

    collector.on('collect', async (i) => {
      const categoryKey = i.customId.replace('help_cat_', '');
      const catEmbed = buildCategoryEmbed(client, categoryKey);
      const updatedRow = buildButtons(client, categoryKey);
      await i.update({ embeds: [catEmbed], components: [updatedRow] });
    });

    collector.on('end', async () => {
      await reply.edit({ components: [buildDisabledButtons(client)] }).catch(() => {});
    });
  },

  async prefixExecute(message, argsText, client) {
    const pseudoInteraction = {
      inGuild: () => Boolean(message.guild),
      user: message.author,
      guild: message.guild,
      guildId: message.guild?.id || null,
      channel: message.channel,
      replied: false,
      deferred: false,
      reply: (payload) => message.reply(payload)
    };
    await module.exports.execute(pseudoInteraction, client);
  }
};
