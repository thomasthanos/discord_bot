const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');

const CATEGORIES = {
  Music: {
    emoji: '🎵',
    color: 0x1db954,
    commands: [
      { name: 'play', desc: 'Play a song', aliases: '`!p` `!π`' },
      { name: 'stop', desc: 'Stop and clear queue', aliases: '`!s` `!σ`' },
      { name: 'idlemusic', desc: 'Start idle live music', aliases: '`!im` `!ιμ`' },
      { name: 'volume', desc: 'Show or set volume (0-100)', aliases: '`!v` `!β`' },
    ]
  },
  Moderation: {
    emoji: '🛡️',
    color: 0xe74c3c,
    commands: [
      { name: 'clear', desc: 'Delete messages + save transcript', aliases: '`!c` `!ψ`' },
      { name: 'wipe-channel', desc: 'Delete ALL messages in channel', aliases: '`!wc` `!ςψ`' },
    ]
  },
  Invites: {
    emoji: '📨',
    color: 0x3498db,
    commands: [
      { name: 'invite-logger', desc: 'Show invite leaderboard & recent joins', aliases: '`!il` `!ιλ`' },
    ]
  },
  Admin: {
    emoji: '⚙️',
    color: 0xe67e22,
    commands: [
      { name: 'addauthorized', desc: 'Grant/revoke command access', aliases: '`!aa` `!αα`' },
    ]
  },
  General: {
    emoji: '📋',
    color: 0x9b59b6,
    commands: [
      { name: 'help', desc: 'Show this menu', aliases: '`!h` `!η`' },
    ]
  }
};

function buildCategoryEmbed(categoryKey) {
  const cat = CATEGORIES[categoryKey];
  const fields = cat.commands.map((cmd) => ({
    name: `\`/${cmd.name}\``,
    value: `${cmd.desc}\n${cmd.aliases}`,
    inline: true
  }));

  return new EmbedBuilder()
    .setColor(cat.color)
    .setTitle(`${cat.emoji} ${categoryKey}`)
    .setDescription(`**${categoryKey}** commands — slash \`/\` or prefix \`!\``)
    .addFields(fields)
    .setFooter({ text: `!help or /help • ${categoryKey} category` })
    .setTimestamp(new Date());
}

function buildOverviewEmbed(client) {
  const fields = Object.entries(CATEGORIES).map(([key, cat]) => ({
    name: `${cat.emoji} ${key}`,
    value: cat.commands.map((c) => `\`/${c.name}\``).join(' '),
    inline: false
  }));

  return new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle('📋 Help Menu')
    .setDescription('Select a category below to see detailed commands.\nAll commands work as `/slash` and `!prefix`.')
    .addFields(fields)
    .setFooter({ text: `Total: ${client.commands.size} commands` })
    .setTimestamp(new Date());
}

function buildButtons(activeCategory = null) {
  const row = new ActionRowBuilder();
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`help_cat_${key}`)
        .setLabel(`${cat.emoji} ${key}`)
        .setStyle(activeCategory === key ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
  }
  return row;
}

function buildDisabledButtons() {
  const row = new ActionRowBuilder();
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`help_cat_${key}`)
        .setLabel(`${cat.emoji} ${key}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
  }
  return row;
}

module.exports = {
  category: 'General',
  CATEGORIES,
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show a modern help menu with command categories.'),

  async execute(interaction, client) {
    const overviewEmbed = buildOverviewEmbed(client);
    const row = buildButtons();

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
      const catEmbed = buildCategoryEmbed(categoryKey);
      const updatedRow = buildButtons(categoryKey);
      await i.update({ embeds: [catEmbed], components: [updatedRow] });
    });

    collector.on('end', async () => {
      await reply.edit({ components: [buildDisabledButtons()] }).catch(() => {});
    });
  }
};
