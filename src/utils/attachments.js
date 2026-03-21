const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024; // 500MB

if (!fs.existsSync(ATTACHMENTS_DIR)) {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
}

function sanitizeFilename(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._\-]/g, '_')
    .slice(0, 128);
}

/**
 * Build a session directory for a user's attachments.
 * Pattern: data/attachments/<guildId>/<userId>/
 * Same user always writes to the same folder — no new folder per operation.
 */
function buildSessionDir(guildId, _channelId, userId) {
  const sessionDir = path.join(ATTACHMENTS_DIR, String(guildId), String(userId || 'unknown'));
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

/**
 * Download an attachment and save it to disk inside sessionDir.
 * { filePath, storedOnDisk, storeError }
 *
 * filePath is relative to ATTACHMENTS_DIR so the URL is:
 *   /attachments/<guildId>/<userId>/<messageId>_<filename>
 *
 * If a file with the same name already exists it is kept as-is (dedup by messageId prefix).
 */
async function saveAttachmentToDisk(attachment, sessionDir, messageId) {
  const url = attachment.proxyURL || attachment.url || '';
  if (!url) return { filePath: null, storedOnDisk: false, storeError: 'missing_url' };
  if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES) {
    return { filePath: null, storedOnDisk: false, storeError: `file_too_large (${Math.round(attachment.size / 1024 / 1024)}MB > 500MB)` };
  }

  try {
    const safeName = sanitizeFilename(attachment.name || 'file');
    const fileName = `${messageId}_${safeName}`;
    const fullPath = path.join(sessionDir, fileName);

    // Skip download if already saved (same messageId = same file)
    if (fs.existsSync(fullPath)) {
      const relativePath = path.relative(ATTACHMENTS_DIR, fullPath).replace(/\\/g, '/');
      return { filePath: relativePath, storedOnDisk: true, storeError: null };
    }

    const response = await fetch(url);
    if (!response.ok) {
      return { filePath: null, storedOnDisk: false, storeError: `http_${response.status}` };
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return { filePath: null, storedOnDisk: false, storeError: `file_too_large (${Math.round(bytes.length / 1024 / 1024)}MB > 500MB)` };
    }

    fs.writeFileSync(fullPath, bytes);

    const relativePath = path.relative(ATTACHMENTS_DIR, fullPath).replace(/\\/g, '/');
    return { filePath: relativePath, storedOnDisk: true, storeError: null };
  } catch {
    return { filePath: null, storedOnDisk: false, storeError: 'download_failed' };
  }
}

module.exports = {
  buildSessionDir,
  saveAttachmentToDisk,
  ATTACHMENTS_DIR,
  DATA_DIR
};
