const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');

function formatAuthorTag(user) {
  if (!user) return 'Unknown#0000';
  if (user.tag) return user.tag;
  if (user.discriminator && user.discriminator !== '0') return `${user.username}#${user.discriminator}`;
  return user.username || 'Unknown';
}

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

async function readAttachmentAsBase64(attachment) {
  const url = attachment.proxyURL || attachment.url || '';
  if (!url) return { dataBase64: null, storedInDb: false, storeError: 'missing_url' };
  if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES) {
    return { dataBase64: null, storedInDb: false, storeError: 'file_too_large' };
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { dataBase64: null, storedInDb: false, storeError: `http_${response.status}` };
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return { dataBase64: null, storedInDb: false, storeError: 'file_too_large' };
    }

    return {
      dataBase64: bytes.toString('base64'),
      storedInDb: true,
      storeError: null
    };
  } catch {
    return { dataBase64: null, storedInDb: false, storeError: 'download_failed' };
  }
}

async function serializeMessage(message) {
  const attachments = [];
  for (const attachment of Array.from(message.attachments.values())) {
    const stored = await readAttachmentAsBase64(attachment);
    attachments.push({
      name: attachment.name || 'file',
      url: attachment.url || '',
      proxyUrl: attachment.proxyURL || '',
      contentType: attachment.contentType || null,
      size: attachment.size || 0,
      dataBase64: stored.dataBase64,
      storedInDb: stored.storedInDb,
      storeError: stored.storeError
    });
  }

  return {
    id: message.id,
    author: formatAuthorTag(message.author),
    authorId: message.author?.id || null,
    authorAvatarUrl: message.author?.displayAvatarURL?.({ forceStatic: false, size: 128 }) || null,
    content: message.content || '',
    createdAt: message.createdAt?.toISOString?.() || null,
    attachments,
    embeds: message.embeds.map((embed) => ({
      title: embed.title || null,
      description: embed.description || null,
      url: embed.url || null,
      author: embed.author?.name || null,
      thumbnail: embed.thumbnail?.url || null,
      image: embed.image?.url || null,
      fields: (embed.fields || []).map((field) => ({
        name: field.name,
        value: field.value,
        inline: Boolean(field.inline)
      }))
    }))
  };
}

module.exports = {
  category: 'Moderation',
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete recent messages and store a full transcript in dashboard logs.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('How many recent messages to delete (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  async execute(interaction, client, database) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command works only inside servers.', flags: MessageFlags.Ephemeral });
      return;
    }

    // Acknowledge immediately to avoid interaction timeout during attachment archiving.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased() || channel.type === ChannelType.DM) {
      await interaction.editReply('This channel does not support message clearing.');
      return;
    }

    const botPerms = channel.permissionsFor(client.user?.id || client.user);
    if (!botPerms?.has(PermissionFlagsBits.ManageMessages) || !botPerms.has(PermissionFlagsBits.ReadMessageHistory)) {
      await interaction.editReply('I need `Manage Messages` and `Read Message History` permissions in this channel.');
      return;
    }

    const amount = interaction.options.getInteger('amount', true);

    const fetched = await channel.messages.fetch({ limit: Math.min(100, amount + 5) });
    const targetMessages = Array.from(fetched.values())
      .filter((message) => !message.pinned && !message.system)
      .slice(0, amount);

    if (!targetMessages.length) {
      await interaction.editReply('No eligible messages found to delete.');
      return;
    }

    // Store transcript payload before deleting messages, so attachment URLs are still valid.
    const sortedTarget = [...targetMessages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const preparedTranscript = [];
    for (const msg of sortedTarget) {
      preparedTranscript.push(await serializeMessage(msg));
    }

    const deleted = await channel.bulkDelete(targetMessages, true);
    if (!deleted.size) {
      await interaction.editReply('No messages were deleted (messages may be older than 14 days).');
      return;
    }

    const deletedIds = new Set(Array.from(deleted.keys()));
    const transcriptMessages = preparedTranscript.filter((entry) => deletedIds.has(entry.id));

    database.logClear(interaction.user, channel, interaction.guild, transcriptMessages);
    client.emit('dashboard:sync');

    await interaction.editReply(
      `Deleted ${deleted.size} message(s). Transcript saved to dashboard clear logs.`
    );
  }
};

