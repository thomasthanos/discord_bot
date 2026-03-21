const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'bot.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS command_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_tag TEXT NOT NULL,
    guild_id TEXT,
    guild_name TEXT,
    channel_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS clear_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moderator_id TEXT NOT NULL,
    moderator_tag TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    guild_name TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    messages TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invite_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_id TEXT NOT NULL,
    inviter_tag TEXT NOT NULL,
    invited_id TEXT NOT NULL,
    invited_tag TEXT NOT NULL,
    invite_code TEXT,
    guild_id TEXT NOT NULL,
    guild_name TEXT NOT NULL,
    total_invites INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS songs_played (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    artist TEXT,
    url TEXT,
    requested_by TEXT,
    guild_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bot_stats (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS command_authorized_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    command_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    added_by_id TEXT NOT NULL,
    added_by_tag TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, command_name, user_id)
  );
`);

// Initialize stats
const initStat = db.prepare('INSERT OR IGNORE INTO bot_stats (key, value) VALUES (?, ?)');
initStat.run('start_time', Date.now().toString());
initStat.run('total_commands', '0');

module.exports = {
  db,

  logCommand(command, user, guild, channelId) {
    db.prepare(`INSERT INTO command_logs (command, user_id, user_tag, guild_id, guild_name, channel_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      command, user.id, user.tag || user.username, guild?.id || null, guild?.name || null, channelId || null
    );
    const current = db.prepare('SELECT value FROM bot_stats WHERE key = ?').get('total_commands');
    const newVal = (parseInt(current?.value || '0') + 1).toString();
    db.prepare('UPDATE bot_stats SET value = ? WHERE key = ?').run(newVal, 'total_commands');
  },

  logClear(moderator, channel, guild, messages) {
    db.prepare(`INSERT INTO clear_logs (moderator_id, moderator_tag, channel_id, channel_name, guild_id, guild_name, message_count, messages)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      moderator.id, moderator.tag || moderator.username,
      channel.id, channel.name,
      guild.id, guild.name,
      messages.length,
      JSON.stringify(messages)
    );
  },

  logInvite(inviter, invited, code, guild, totalInvites) {
    db.prepare(`INSERT INTO invite_logs (inviter_id, inviter_tag, invited_id, invited_tag, invite_code, guild_id, guild_name, total_invites)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      inviter.id, inviter.tag || inviter.username,
      invited.id, invited.tag || invited.username,
      code, guild.id, guild.name, totalInvites
    );
  },

  logSong(title, artist, url, requestedBy, guildId) {
    db.prepare(`INSERT INTO songs_played (title, artist, url, requested_by, guild_id)
      VALUES (?, ?, ?, ?, ?)`).run(title, artist || 'Unknown', url, requestedBy, guildId);
  },

  getStats() {
    const totalCommands = db.prepare('SELECT value FROM bot_stats WHERE key = ?').get('total_commands')?.value || '0';
    const startTime = db.prepare('SELECT value FROM bot_stats WHERE key = ?').get('start_time')?.value || Date.now().toString();
    const songsPlayed = db.prepare('SELECT COUNT(*) as count FROM songs_played').get().count;
    const totalCleared = db.prepare('SELECT COALESCE(SUM(message_count), 0) as total FROM clear_logs').get().total;
    return {
      totalCommands: parseInt(totalCommands),
      songsPlayed,
      totalCleared,
      startTime: parseInt(startTime)
    };
  },

  getClearLogs() {
    return db.prepare('SELECT * FROM clear_logs ORDER BY timestamp DESC').all();
  },

  getClearLogsByGuild(guildId) {
    return db.prepare(`
      SELECT *
      FROM clear_logs
      WHERE guild_id = ?
      ORDER BY timestamp DESC
    `).all(guildId);
  },

  getClearLog(id) {
    return db.prepare('SELECT * FROM clear_logs WHERE id = ?').get(id);
  },

  getInviteLogs() {
    return db.prepare('SELECT * FROM invite_logs ORDER BY timestamp DESC').all();
  },

  getInviteLeaderboard(limit = 10) {
    return db.prepare(`
      SELECT inviter_id, inviter_tag, MAX(total_invites) as total_invites
      FROM invite_logs
      GROUP BY inviter_id, inviter_tag
      ORDER BY total_invites DESC, inviter_tag ASC
      LIMIT ?
    `).all(limit);
  },

  getInviteLogsByGuild(guildId, limit = 50) {
    return db.prepare(`
      SELECT *
      FROM invite_logs
      WHERE guild_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(guildId, limit);
  },

  getInviteLeaderboardByGuild(guildId, limit = 10) {
    return db.prepare(`
      SELECT inviter_id, inviter_tag, MAX(total_invites) as total_invites
      FROM invite_logs
      WHERE guild_id = ?
      GROUP BY inviter_id, inviter_tag
      ORDER BY total_invites DESC, inviter_tag ASC
      LIMIT ?
    `).all(guildId, limit);
  },

  getCommandLogs() {
    return db.prepare('SELECT * FROM command_logs ORDER BY timestamp DESC LIMIT 100').all();
  },

  getCommandLogsByGuild(guildId, limit = 100) {
    return db.prepare(`
      SELECT *
      FROM command_logs
      WHERE guild_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(guildId, limit);
  },

  getCommandUsage(limit = 10) {
    return db.prepare(`
      SELECT command, COUNT(*) as uses
      FROM command_logs
      GROUP BY command
      ORDER BY uses DESC, command ASC
      LIMIT ?
    `).all(limit);
  },

  getCommandUsageByGuild(guildId, limit = 10) {
    return db.prepare(`
      SELECT command, COUNT(*) as uses
      FROM command_logs
      WHERE guild_id = ?
      GROUP BY command
      ORDER BY uses DESC, command ASC
      LIMIT ?
    `).all(guildId, limit);
  },

  getSongsPlayed() {
    return db.prepare('SELECT * FROM songs_played ORDER BY timestamp DESC LIMIT 50').all();
  },

  addAuthorizedUser(guildId, commandName, user, addedBy) {
    db.prepare(`
      INSERT INTO command_authorized_users (guild_id, command_name, user_id, added_by_id, added_by_tag)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, command_name, user_id) DO UPDATE SET
        added_by_id = excluded.added_by_id,
        added_by_tag = excluded.added_by_tag,
        timestamp = CURRENT_TIMESTAMP
    `).run(
      guildId,
      commandName.toLowerCase(),
      user.id,
      addedBy.id,
      addedBy.tag || addedBy.username || 'Unknown'
    );
  },

  removeAuthorizedUser(guildId, commandName, userId) {
    const result = db.prepare(`
      DELETE FROM command_authorized_users
      WHERE guild_id = ? AND command_name = ? AND user_id = ?
    `).run(guildId, commandName.toLowerCase(), userId);
    return result.changes > 0;
  },

  isAuthorizedUser(guildId, commandName, userId) {
    const row = db.prepare(`
      SELECT 1
      FROM command_authorized_users
      WHERE guild_id = ? AND command_name = ? AND user_id = ?
      LIMIT 1
    `).get(guildId, commandName.toLowerCase(), userId);
    return Boolean(row);
  },

  getAuthorizedUsers(guildId, commandName) {
    return db.prepare(`
      SELECT user_id, added_by_id, added_by_tag, timestamp
      FROM command_authorized_users
      WHERE guild_id = ? AND command_name = ?
      ORDER BY timestamp DESC
      LIMIT 100
    `).all(guildId, commandName.toLowerCase());
  },

  hasAuthorizedEntriesForCommand(guildId, commandName) {
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM command_authorized_users
      WHERE guild_id = ? AND command_name = ?
    `).get(guildId, commandName.toLowerCase());
    return Number(row?.count || 0) > 0;
  }
};
