const {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const { isCommandAuthorized, replyUnauthorized } = require('../utils/authorization');

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAuthorTag(user) {
  if (!user) return 'Unknown#0000';
  if (user.tag) return user.tag;
  if (user.discriminator && user.discriminator !== '0') return `${user.username}#${user.discriminator}`;
  return user.username || 'Unknown';
}

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

async function collectMessages(channel) {
  const messages = [];
  let lastId = null;
  // Bug fix: cap iterations to avoid infinite loop on channels with exactly
  // multiples of 100 messages, or if the API unexpectedly keeps returning 100.
  const MAX_BATCHES = 500; // 500 * 100 = 50 000 messages max
  let iterations = 0;

  while (iterations < MAX_BATCHES) {
    iterations += 1;
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(lastId ? { before: lastId } : {})
    });
    if (!batch.size) break;

    const filtered = Array.from(batch.values()).filter((msg) => !msg.pinned && !msg.system);
    messages.push(...filtered);
    const newLastId = batch.last().id;
    // Bug fix: if lastId didn't change the API returned the same page — stop.
    if (newLastId === lastId) break;
    lastId = newLastId;

    if (batch.size < 100) break;
  }

  return messages;
}

module.exports = {
  category: 'Moderation',
  data: new SlashCommandBuilder()
    .setName('wipe-channel')
    .setDescription('Slowly delete all messages in the current channel (authorized users only).'),

  async execute(interaction, client, database) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command works only inside servers.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!isCommandAuthorized(interaction, database, 'wipe-channel')) {
      await replyUnauthorized(interaction, '`/wipe-channel`');
      return;
    }

    const channel = interaction.channel;
    const botPerms = channel.permissionsFor(client.user?.id || client.user);
    if (!botPerms?.has(PermissionFlagsBits.ManageMessages) || !botPerms.has(PermissionFlagsBits.ReadMessageHistory)) {
      await interaction.reply({
        content: 'I need `Manage Messages` and `Read Message History` permissions in this channel.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const confirmId = `wipe_confirm_${interaction.id}`;
    const cancelId = `wipe_cancel_${interaction.id}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(confirmId)
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(cancelId)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: `Confirm full wipe for channel <#${channel.id}>.`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });

    const reply = await interaction.fetchReply();
    let componentInteraction;
    try {
      componentInteraction = await reply.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id && (i.customId === confirmId || i.customId === cancelId),
        time: 30000
      });
    } catch {
      await interaction.editReply({ content: 'Wipe request timed out.', components: [] });
      return;
    }

    if (componentInteraction.customId === cancelId) {
      await componentInteraction.update({ content: 'Wipe cancelled.', components: [] });
      return;
    }

    await componentInteraction.update({ content: 'Wipe started... deleting slowly.', components: [] });

    let deletedCount = 0;
    let failedCount = 0;
    const messages = await collectMessages(channel);
    const sorted = [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const preparedTranscript = [];
    for (const msg of sorted) {
      preparedTranscript.push(await serializeMessage(msg));
    }
    const deletedIds = new Set();

    for (const message of messages) {
      try {
        await message.delete();
        deletedCount += 1;
        deletedIds.add(message.id);
      } catch {
        failedCount += 1;
      }
      await sleep(700);
    }

    const transcriptMessages = preparedTranscript.filter((entry) => deletedIds.has(entry.id));
    if (transcriptMessages.length > 0) {
      database.logClear(interaction.user, channel, interaction.guild, transcriptMessages);
    }

    await interaction.editReply({
      content: `Wipe complete. Deleted: **${deletedCount}** | Failed: **${failedCount}**.`
    });

    client.emit('dashboard:sync');
  }
};
