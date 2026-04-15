const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'public');
const RESERVED_USERNAMES = new Set(['system', 'bot']);
const ALLOWED_PRESENCE = new Set(['online', 'away', 'busy']);
const DATABASE_URL = process.env.DATABASE_URL || '';
const SNAPSHOT_ROW_ID = 'primary';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const RESEND_REQUEST_TIMEOUT_MS = Number(process.env.RESEND_REQUEST_TIMEOUT_MS || 15_000);
const MAIL_FROM = process.env.MAIL_FROM || process.env.RESEND_FROM || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || process.env.RESEND_FROM_NAME || 'Web Chat Community';
const REGISTER_CODE_TTL_MS = Number(process.env.REGISTER_CODE_TTL_MS || 10 * 60 * 1000);
const REGISTER_CODE_RESEND_MS = Number(process.env.REGISTER_CODE_RESEND_MS || 60 * 1000);
const REGISTER_MAX_VERIFY_ATTEMPTS = Number(process.env.REGISTER_MAX_VERIFY_ATTEMPTS || 5);

app.use(express.json({ limit: '10mb' }));

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function now() {
  return Date.now();
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidUsername(username) {
  return /^[\p{L}\p{N}_.-]{3,24}$/u.test(username);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function hashVerificationCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function createVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function formatMailFrom() {
  if (!MAIL_FROM) {
    return '';
  }
  return MAIL_FROM_NAME ? `"${MAIL_FROM_NAME}" <${MAIL_FROM}>` : MAIL_FROM;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendTransactionalEmail(payload) {
  if (!RESEND_API_KEY || !MAIL_FROM) {
    throw new Error('Email service is not configured. Set RESEND_API_KEY and MAIL_FROM.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESEND_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        result?.message
        || result?.error?.message
        || result?.error
        || `Resend request failed (${response.status}).`;
      throw new Error(errorMessage);
    }

    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Mail servisine baglanti zaman asimina ugradi.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendRegistrationCodeEmail({ email, username, code }) {
  const expiresInMinutes = Math.max(1, Math.round(REGISTER_CODE_TTL_MS / 60_000));
  await sendTransactionalEmail({
    from: formatMailFrom(),
    to: [email],
    subject: 'Kayit dogrulama kodun',
    text: [
      `Merhaba ${username},`,
      '',
      'Web Chat Community kaydini tamamlamak icin asagidaki kodu kullan:',
      code,
      '',
      `Kod ${expiresInMinutes} dakika icinde gecersiz olacak.`,
      'Bu islemi sen baslatmadiysan bu maili yok sayabilirsin.'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2328;">
        <p>Merhaba <strong>${escapeHtml(username)}</strong>,</p>
        <p>Web Chat Community kaydini tamamlamak icin asagidaki kodu kullan:</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0;">${escapeHtml(code)}</div>
        <p>Kod <strong>${expiresInMinutes} dakika</strong> icinde gecersiz olacak.</p>
        <p>Bu islemi sen baslatmadiysan bu maili yok sayabilirsin.</p>
      </div>
    `
  });
}

function maskEmail(email) {
  const trimmed = String(email || '').trim();
  const [localPart, domain = ''] = trimmed.split('@');
  if (!localPart || !domain) {
    return trimmed;
  }
  const visible = localPart.length <= 2 ? localPart[0] || '*' : `${localPart[0]}${'*'.repeat(Math.max(1, localPart.length - 2))}${localPart.slice(-1)}`;
  return `${visible}@${domain}`;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultState() {
  const generalServerId = 'srv_campus';
  const generalTextId = 'chn_general';
  const announcementsId = 'chn_announcements';
  const modRoomId = 'chn_mod_room';
  const voiceLobbyId = 'chn_voice_lounge';
  const studyVoiceId = 'chn_study_hall';

  return {
    users: [
      { username: 'admin', password: '123', email: null, emailVerified: false, banned: false, mutedUntil: null, status: 'online' },
      { username: 'moderator', password: '123', email: null, emailVerified: false, banned: false, mutedUntil: null, status: 'away' },
      { username: 'student', password: '123', email: null, emailVerified: false, banned: false, mutedUntil: null, status: 'online' }
    ],
    pendingRegistrations: [],
    friendships: [],
    friendRequests: [],
    blocks: {},
    privacy: {},
    auditLogs: [],
    invites: [],
    directMessages: {},
    servers: [
      {
        id: generalServerId,
        name: 'Ostim Community',
        members: [
          { username: 'admin', role: 'admin' },
          { username: 'moderator', role: 'mod' },
          { username: 'student', role: 'member' }
        ],
        categories: [
          {
            id: 'cat_info',
            name: 'Bilgilendirme',
            channels: [
              { id: announcementsId, name: 'announcements', kind: 'text', allowedRoles: ['admin', 'mod', 'member'] },
              { id: generalTextId, name: 'general', kind: 'text', allowedRoles: ['admin', 'mod', 'member'] },
              { id: modRoomId, name: 'mod-only', kind: 'text', allowedRoles: ['admin', 'mod'] }
            ]
          },
          {
            id: 'cat_voice',
            name: 'Sesli Odalar',
            channels: [
              { id: voiceLobbyId, name: 'voice-lounge', kind: 'voice', allowedRoles: ['admin', 'mod', 'member'] },
              { id: studyVoiceId, name: 'study-hall', kind: 'voice', allowedRoles: ['admin', 'mod', 'member'] }
            ]
          }
        ],
        reports: [],
        polls: []
      }
    ],
    messages: {
      [announcementsId]: [
        { id: uid('msg'), user: 'admin', text: 'Sunucuya hos geldiniz. /help ile komutlari gorebilirsiniz.', time: now(), reactions: {} }
      ],
      [generalTextId]: [
        { id: uid('msg'), user: 'student', text: 'Merhaba millet.', time: now() - 60_000, reactions: {} },
        { id: uid('msg'), user: 'moderator', text: 'Kurallara dikkat edelim.', time: now() - 30_000, reactions: {} }
      ],
      [modRoomId]: [
        { id: uid('msg'), user: 'moderator', text: 'Raporlari buradan takip edelim.', time: now() - 15_000, reactions: {} }
      ]
    },
    voicePresence: {
      [voiceLobbyId]: ['student'],
      [studyVoiceId]: []
    },
    presence: {
      admin: { status: 'online', currentServerId: generalServerId, currentChannelId: announcementsId, voiceChannelId: null },
      moderator: { status: 'away', currentServerId: generalServerId, currentChannelId: modRoomId, voiceChannelId: null },
      student: { status: 'online', currentServerId: generalServerId, currentChannelId: generalTextId, voiceChannelId: voiceLobbyId }
    }
  };
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const initial = defaultState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    const initial = defaultState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function normalizeState(loadedState) {
  const nextState = loadedState || {};

  nextState.users = Array.isArray(nextState.users) ? nextState.users : [];
  nextState.pendingRegistrations = Array.isArray(nextState.pendingRegistrations) ? nextState.pendingRegistrations : [];
  nextState.friendships = Array.isArray(nextState.friendships) ? nextState.friendships : [];
  nextState.friendRequests = Array.isArray(nextState.friendRequests) ? nextState.friendRequests : [];
  nextState.blocks = nextState.blocks && typeof nextState.blocks === 'object' ? nextState.blocks : {};
  nextState.privacy = nextState.privacy && typeof nextState.privacy === 'object' ? nextState.privacy : {};
  nextState.auditLogs = Array.isArray(nextState.auditLogs) ? nextState.auditLogs : [];
  nextState.invites = Array.isArray(nextState.invites) ? nextState.invites : [];
  nextState.servers = Array.isArray(nextState.servers) ? nextState.servers : [];
  nextState.messages = nextState.messages && typeof nextState.messages === 'object' ? nextState.messages : {};
  nextState.directMessages = nextState.directMessages && typeof nextState.directMessages === 'object' ? nextState.directMessages : {};
  nextState.voicePresence = nextState.voicePresence && typeof nextState.voicePresence === 'object' ? nextState.voicePresence : {};
  nextState.presence = nextState.presence && typeof nextState.presence === 'object' ? nextState.presence : {};

  nextState.users.forEach((user) => {
    user.email = user.email ? String(user.email).trim() : null;
    user.emailVerified = Boolean(user.emailVerified);
    nextState.blocks[user.username] = Array.isArray(nextState.blocks[user.username]) ? nextState.blocks[user.username] : [];
    nextState.privacy[user.username] = nextState.privacy[user.username] && typeof nextState.privacy[user.username] === 'object'
      ? nextState.privacy[user.username]
      : { dmPolicy: 'everyone' };
    if (!nextState.privacy[user.username].dmPolicy) {
      nextState.privacy[user.username].dmPolicy = 'everyone';
    }

    if (!nextState.presence[user.username]) {
      nextState.presence[user.username] = {
        status: user.status || 'offline',
        currentServerId: nextState.servers[0]?.id || null,
        currentChannelId: nextState.servers[0]?.categories?.[0]?.channels?.[0]?.id || null,
        voiceChannelId: null,
        lastSeenAt: null
      };
    } else if (!('lastSeenAt' in nextState.presence[user.username])) {
      nextState.presence[user.username].lastSeenAt = null;
    }
  });

  Object.keys(nextState.messages).forEach((channelId) => {
    nextState.messages[channelId] = (nextState.messages[channelId] || []).map((message) => ({
      reactions: {},
      replyTo: null,
      attachments: [],
      ...message
    }));
  });

  Object.keys(nextState.directMessages).forEach((dmKey) => {
    nextState.directMessages[dmKey] = (nextState.directMessages[dmKey] || []).map((message) => ({
      reactions: {},
      seenBy: Array.isArray(message.seenBy) ? message.seenBy : [message.user],
      replyTo: null,
      attachments: [],
      ...message
    }));
  });

  nextState.pendingRegistrations = nextState.pendingRegistrations
    .map((entry) => ({
      username: String(entry.username || '').trim(),
      email: String(entry.email || '').trim(),
      password: String(entry.password || ''),
      avatar: entry.avatar || null,
      codeHash: String(entry.codeHash || ''),
      expiresAt: Number(entry.expiresAt || 0),
      resendAvailableAt: Number(entry.resendAvailableAt || 0),
      requestedAt: Number(entry.requestedAt || 0),
      attempts: Number(entry.attempts || 0)
    }))
    .filter((entry) => entry.username && entry.email && entry.password && entry.codeHash && entry.expiresAt > now());

  return nextState;
}

let state = normalizeState(defaultState());
const callPresence = {};
const onlineUsers = new Set();
const typingState = {};
let pgPool = null;
let persistenceMode = 'file';
let persistenceWriteChain = Promise.resolve();

function cloneStateSnapshot(snapshot = state) {
  return JSON.parse(JSON.stringify(snapshot));
}

function writeStateFile(snapshot = state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2));
}

function getDatabaseSslConfig() {
  if (!DATABASE_URL || process.env.DB_SSL === 'false' || /localhost|127\.0\.0\.1/.test(DATABASE_URL)) {
    return false;
  }
  return { rejectUnauthorized: false };
}

async function ensureDatabase() {
  if (!DATABASE_URL || pgPool) {
    return;
  }

  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: getDatabaseSslConfig()
  });

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state_snapshots (
      id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function persistSnapshotToDatabase(snapshot) {
  if (!pgPool) {
    return;
  }

  await pgPool.query(
    `
      INSERT INTO app_state_snapshots (id, state, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
    `,
    [SNAPSHOT_ROW_ID, JSON.stringify(snapshot)]
  );
}

async function initializePersistence() {
  ensureDataDir();
  state = normalizeState(loadState());

  if (!DATABASE_URL) {
    persistenceMode = 'file';
    return;
  }

  try {
    await ensureDatabase();
    const result = await pgPool.query('SELECT state FROM app_state_snapshots WHERE id = $1', [SNAPSHOT_ROW_ID]);
    if (result.rows[0]?.state) {
      state = normalizeState(result.rows[0].state);
    } else {
      await persistSnapshotToDatabase(cloneStateSnapshot(state));
    }
    persistenceMode = 'postgres';
    writeStateFile(state);
    console.log('Persistence mode: postgres snapshot');
  } catch (error) {
    persistenceMode = 'file';
    console.error(`Postgres persistence unavailable, falling back to JSON file: ${error.message}`);
    if (pgPool) {
      try {
        await pgPool.end();
      } catch {
        // Ignore shutdown failures during fallback.
      }
      pgPool = null;
    }
  }
}

function saveState() {
  const snapshot = cloneStateSnapshot(state);
  writeStateFile(snapshot);

  if (pgPool) {
    persistenceWriteChain = persistenceWriteChain
      .catch(() => {})
      .then(() => persistSnapshotToDatabase(snapshot))
      .catch((error) => {
        console.error(`Postgres snapshot save failed: ${error.message}`);
      });
  }
}

function sanitizeUser(user) {
  const effectivePresence = getEffectivePresence(user.username);
  return {
    username: user.username,
    banned: Boolean(user.banned),
    mutedUntil: user.mutedUntil,
    avatar: user.avatar || null,
    status: effectivePresence.status,
    preferredStatus: state.presence[user.username]?.status || user.status || 'online',
    lastSeenAt: effectivePresence.lastSeenAt || null,
    privacy: { dmPolicy: ensureSocialProfile(user.username).privacy.dmPolicy || 'everyone' }
  };
}

function getDmKey(userA, userB) {
  const canonicalA = getUser(userA)?.username || userA;
  const canonicalB = getUser(userB)?.username || userB;
  return [canonicalA, canonicalB].sort().join('__');
}

function getFriendKey(userA, userB) {
  const canonicalA = getUser(userA)?.username || userA;
  const canonicalB = getUser(userB)?.username || userB;
  return [canonicalA, canonicalB].sort().join('__');
}

function getDmMessages(userA, userB) {
  return state.directMessages[getDmKey(userA, userB)] || [];
}

function ensureSocialProfile(username) {
  const user = getUser(username);
  const canonicalUsername = user?.username || username;
  state.blocks[canonicalUsername] = Array.isArray(state.blocks[canonicalUsername]) ? state.blocks[canonicalUsername] : [];
  state.privacy[canonicalUsername] = state.privacy[canonicalUsername] && typeof state.privacy[canonicalUsername] === 'object'
    ? state.privacy[canonicalUsername]
    : { dmPolicy: 'everyone' };
  if (!state.privacy[canonicalUsername].dmPolicy) {
    state.privacy[canonicalUsername].dmPolicy = 'everyone';
  }
  return {
    username: canonicalUsername,
    blockedUsers: state.blocks[canonicalUsername],
    privacy: state.privacy[canonicalUsername]
  };
}

function getPendingFriendRequest(from, to) {
  const canonicalFrom = getUser(from)?.username || from;
  const canonicalTo = getUser(to)?.username || to;
  return state.friendRequests.find((request) => (
    request.from === canonicalFrom
    && request.to === canonicalTo
    && request.status === 'pending'
  )) || null;
}

function areFriends(userA, userB) {
  const key = getFriendKey(userA, userB);
  return state.friendships.some((friendship) => friendship.key === key);
}

function isBlocked(blocker, target) {
  const blockerProfile = ensureSocialProfile(blocker);
  const canonicalTarget = getUser(target)?.username || target;
  return blockerProfile.blockedUsers.includes(canonicalTarget);
}

function canUsersDm(sender, receiver) {
  const senderUser = getUser(sender);
  const receiverUser = getUser(receiver);
  if (!senderUser || !receiverUser) {
    return false;
  }
  if (senderUser.username === receiverUser.username) {
    return false;
  }
  if (isBlocked(senderUser.username, receiverUser.username) || isBlocked(receiverUser.username, senderUser.username)) {
    return false;
  }
  const receiverPrivacy = ensureSocialProfile(receiverUser.username).privacy;
  if (receiverPrivacy.dmPolicy === 'friends' && !areFriends(senderUser.username, receiverUser.username)) {
    return false;
  }
  return true;
}

function serializeSocialState(username) {
  const socialProfile = ensureSocialProfile(username);
  const blockedByUsers = state.users
    .filter((user) => user.username !== socialProfile.username && isBlocked(user.username, socialProfile.username))
    .map((user) => user.username)
    .sort((a, b) => a.localeCompare(b, 'tr'));
  const friends = state.friendships
    .filter((friendship) => friendship.users.includes(socialProfile.username))
    .map((friendship) => {
      const peerUsername = friendship.users.find((user) => user !== socialProfile.username);
      return {
        username: peerUsername,
        since: friendship.createdAt
      };
    })
    .sort((a, b) => a.username.localeCompare(b.username, 'tr'));

  const incomingRequests = state.friendRequests
    .filter((request) => request.to === socialProfile.username && request.status === 'pending')
    .map((request) => ({
      id: request.id,
      username: request.from,
      createdAt: request.createdAt
    }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const outgoingRequests = state.friendRequests
    .filter((request) => request.from === socialProfile.username && request.status === 'pending')
    .map((request) => ({
      id: request.id,
      username: request.to,
      createdAt: request.createdAt
    }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return {
    privacy: {
      dmPolicy: socialProfile.privacy.dmPolicy || 'everyone'
    },
    blockedUsers: [...socialProfile.blockedUsers].sort((a, b) => a.localeCompare(b, 'tr')),
    blockedByUsers,
    friends,
    incomingRequests,
    outgoingRequests
  };
}

function markDmSeen(viewer, peerUsername) {
  const messages = getDmMessages(viewer, peerUsername);
  let changed = false;

  messages.forEach((message) => {
    if (message.user !== viewer) {
      message.seenBy = Array.isArray(message.seenBy) ? message.seenBy : [];
      if (!message.seenBy.includes(viewer)) {
        message.seenBy.push(viewer);
        changed = true;
      }
    }
  });

  return changed;
}

function buildVisibleDms(username) {
  const result = {};
  state.users.forEach((user) => {
    if (user.username !== username && canUsersDm(username, user.username)) {
      result[user.username] = getDmMessages(username, user.username);
    }
  });
  return result;
}

function getUser(username) {
  const normalized = normalizeUsername(username);
  return state.users.find((user) => normalizeUsername(user.username) === normalized);
}

function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  return state.users.find((user) => normalizeEmail(user.email) === normalized);
}

function resolveLoginUser(identifier) {
  return getUser(identifier) || getUserByEmail(identifier) || null;
}

function pruneExpiredPendingRegistrations() {
  const currentTime = now();
  const before = state.pendingRegistrations.length;
  state.pendingRegistrations = state.pendingRegistrations.filter((entry) => entry.expiresAt > currentTime);
  return before !== state.pendingRegistrations.length;
}

function getPendingRegistration({ username, email }) {
  pruneExpiredPendingRegistrations();
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = normalizeEmail(email);
  return state.pendingRegistrations.find((entry) => (
    normalizeUsername(entry.username) === normalizedUsername
    && normalizeEmail(entry.email) === normalizedEmail
  )) || null;
}

function upsertPendingRegistration({ username, email, password, avatar, code }) {
  const currentTime = now();
  const pendingEntry = {
    username: String(username || '').trim(),
    email: String(email || '').trim(),
    password: String(password || ''),
    avatar: avatar || null,
    codeHash: hashVerificationCode(code),
    expiresAt: currentTime + REGISTER_CODE_TTL_MS,
    resendAvailableAt: currentTime + REGISTER_CODE_RESEND_MS,
    requestedAt: currentTime,
    attempts: 0
  };

  const existingIndex = state.pendingRegistrations.findIndex((entry) => (
    normalizeUsername(entry.username) === normalizeUsername(pendingEntry.username)
    || normalizeEmail(entry.email) === normalizeEmail(pendingEntry.email)
  ));

  if (existingIndex >= 0) {
    state.pendingRegistrations[existingIndex] = pendingEntry;
  } else {
    state.pendingRegistrations.push(pendingEntry);
  }

  return pendingEntry;
}

function ensurePresenceEntry(username) {
  const user = getUser(username);
  const canonicalUsername = user?.username || username;
  if (!state.presence[canonicalUsername]) {
    state.presence[canonicalUsername] = {
      status: user?.status || 'online',
      currentServerId: state.servers[0]?.id || null,
      currentChannelId: state.servers[0]?.categories?.[0]?.channels?.[0]?.id || null,
      voiceChannelId: null,
      lastSeenAt: null
    };
  }
  if (!('lastSeenAt' in state.presence[canonicalUsername])) {
    state.presence[canonicalUsername].lastSeenAt = null;
  }
  return state.presence[canonicalUsername];
}

function getEffectivePresence(username) {
  const user = getUser(username);
  const canonicalUsername = user?.username || username;
  const storedPresence = ensurePresenceEntry(canonicalUsername);
  const isOnline = onlineUsers.has(canonicalUsername);

  return {
    ...storedPresence,
    status: isOnline ? (storedPresence.status || user?.status || 'online') : 'offline',
    lastSeenAt: isOnline ? null : (storedPresence.lastSeenAt || null)
  };
}

function serializePresenceState() {
  const serialized = {};
  state.users.forEach((user) => {
    serialized[user.username] = getEffectivePresence(user.username);
  });
  return serialized;
}

function setUserOnline(username) {
  const user = getUser(username);
  if (!user) {
    return null;
  }

  onlineUsers.add(user.username);
  const presence = ensurePresenceEntry(user.username);
  presence.lastSeenAt = null;
  return user.username;
}

function setUserOffline(username) {
  const user = getUser(username);
  if (!user) {
    return null;
  }

  onlineUsers.delete(user.username);
  const presence = ensurePresenceEntry(user.username);
  presence.voiceChannelId = null;
  presence.lastSeenAt = now();
  Object.keys(state.voicePresence).forEach((channelId) => {
    state.voicePresence[channelId] = (state.voicePresence[channelId] || []).filter((member) => member !== user.username);
  });
  removeUserFromCalls(user.username);
  return user.username;
}

function sanitizeReply(replyTo) {
  if (!replyTo || typeof replyTo !== 'object') {
    return null;
  }

  const id = String(replyTo.id || '').trim();
  const user = String(replyTo.user || '').trim();
  const text = String(replyTo.text || '').trim();
  if (!id || !user || !text) {
    return null;
  }

  return {
    id,
    user,
    text: text.slice(0, 180)
  };
}

function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .slice(0, 3)
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object') {
        return null;
      }

      const name = String(attachment.name || '').trim().slice(0, 120);
      const type = String(attachment.type || 'application/octet-stream').trim().slice(0, 120);
      const dataUrl = String(attachment.dataUrl || '');
      const size = Number(attachment.size || 0);
      if (!name || !dataUrl.startsWith('data:')) {
        return null;
      }
      if (size > 2_000_000 || dataUrl.length > 3_000_000) {
        return null;
      }

      return {
        id: String(attachment.id || uid('att')),
        name,
        type,
        size,
        dataUrl
      };
    })
    .filter(Boolean);
}

function getServer(serverId) {
  return state.servers.find((srv) => srv.id === serverId);
}

function getServerMember(server, username) {
  return server.members.find((member) => member.username === username);
}

function getChannelById(server, channelId) {
  for (const category of server.categories) {
    for (const channel of category.channels) {
      if (channel.id === channelId) {
        return { category, channel };
      }
    }
  }
  return null;
}

function canAccessChannel(server, username, channelId) {
  const member = getServerMember(server, username);
  if (!member) {
    return false;
  }

  const channelInfo = getChannelById(server, channelId);
  if (!channelInfo) {
    return false;
  }

  return channelInfo.channel.allowedRoles.includes(member.role);
}

function getChannel(server, channelId) {
  return getChannelById(server, channelId)?.channel || null;
}

function canManageServer(server, username) {
  const member = getServerMember(server, username);
  return Boolean(member && ['admin', 'mod'].includes(member.role));
}

function normalizeLimit(value, fallback = 25, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function pushAuditLog(entry) {
  state.auditLogs.unshift(entry);
  if (state.auditLogs.length > 500) {
    state.auditLogs.length = 500;
  }
  return entry;
}

function logAuditEvent({
  serverId = null,
  actor = 'system',
  action,
  targetType = 'server',
  targetId = null,
  summary,
  metadata = {}
}) {
  return pushAuditLog({
    id: uid('audit'),
    serverId,
    actor,
    action,
    targetType,
    targetId,
    summary,
    metadata,
    time: now()
  });
}

function generateInviteCode() {
  let code = '';
  do {
    code = Math.random().toString(36).slice(2, 8).toLowerCase();
  } while (state.invites.some((invite) => invite.code === code));
  return code;
}

function isInviteActive(invite) {
  if (!invite || invite.revokedAt) {
    return false;
  }
  if (invite.expiresAt && invite.expiresAt <= now()) {
    return false;
  }
  if (Number.isFinite(invite.maxUses) && invite.maxUses > 0 && invite.uses >= invite.maxUses) {
    return false;
  }
  return true;
}

function getInviteByCode(code) {
  return state.invites.find((invite) => invite.code === String(code || '').trim().toLowerCase()) || null;
}

function serializeInvite(invite, server = getServer(invite.serverId)) {
  const channel = server ? getChannel(server, invite.channelId) : null;
  return {
    code: invite.code,
    serverId: invite.serverId,
    serverName: server?.name || 'Unknown server',
    channelId: invite.channelId,
    channelName: channel?.name || null,
    createdBy: invite.createdBy,
    uses: invite.uses || 0,
    maxUses: Number.isFinite(invite.maxUses) ? invite.maxUses : null,
    expiresAt: invite.expiresAt || null,
    revokedAt: invite.revokedAt || null,
    active: isInviteActive(invite),
    createdAt: invite.createdAt || invite.time || null
  };
}

function serializeAuditLog(entry) {
  return {
    id: entry.id,
    serverId: entry.serverId,
    actor: entry.actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    summary: entry.summary,
    metadata: entry.metadata || {},
    time: entry.time
  };
}

function getServerInvites(serverId) {
  return state.invites
    .filter((invite) => invite.serverId === serverId)
    .sort((a, b) => (b.createdAt || b.time || 0) - (a.createdAt || a.time || 0));
}

function getServerAuditLogs(serverId) {
  return state.auditLogs
    .filter((entry) => entry.serverId === serverId)
    .sort((a, b) => (b.time || 0) - (a.time || 0));
}

function serializeServer(server, username) {
  const member = getServerMember(server, username);
  const visibleCategories = server.categories
    .map((category) => ({
      id: category.id,
      name: category.name,
      channels: category.channels
        .filter((channel) => !username || canAccessChannel(server, username, channel.id))
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          kind: channel.kind,
          allowedRoles: channel.allowedRoles
        }))
    }))
    .filter((category) => category.channels.length > 0);

  return {
    id: server.id,
    name: server.name,
    myRole: member?.role || null,
    members: server.members.map((serverMember) => ({
      username: serverMember.username,
      role: serverMember.role,
      status: getEffectivePresence(serverMember.username).status,
      lastSeenAt: getEffectivePresence(serverMember.username).lastSeenAt || null
    })),
    categories: visibleCategories,
    reports: server.reports,
    polls: server.polls,
    invites: canManageServer(server, username)
      ? getServerInvites(server.id).map((invite) => serializeInvite(invite, server))
      : [],
    auditLogs: canManageServer(server, username)
      ? getServerAuditLogs(server.id).slice(0, 50).map(serializeAuditLog)
      : []
  };
}

function buildVisibleMessagesForUser(username) {
  const visibleMessages = {};

  state.servers.forEach((serverItem) => {
    serverItem.categories.forEach((category) => {
      category.channels.forEach((channel) => {
        if (canAccessChannel(serverItem, username, channel.id)) {
          visibleMessages[channel.id] = state.messages[channel.id] || [];
        }
      });
    });
  });

  return visibleMessages;
}

function buildBootstrap(username) {
  const user = getUser(username);
  const canonicalUsername = user?.username || username;
  return {
    meta: {
      persistence: persistenceMode
    },
    currentUser: sanitizeUser(getUser(canonicalUsername)),
    social: serializeSocialState(canonicalUsername),
    users: state.users.map(sanitizeUser),
    servers: state.servers
      .filter((serverItem) => getServerMember(serverItem, canonicalUsername))
      .map((serverItem) => serializeServer(serverItem, canonicalUsername)),
    messages: buildVisibleMessagesForUser(canonicalUsername),
    directMessages: buildVisibleDms(canonicalUsername),
    voicePresence: state.voicePresence,
    presence: serializePresenceState(),
    callPresence,
    typingState
  };
}

function ensureMemberships(username) {
  state.servers.forEach((serverItem) => {
    const alreadyMember = getServerMember(serverItem, username);
    if (!alreadyMember) {
      serverItem.members.push({ username, role: 'member' });
    }
  });
}

function getStatsForServer(server, username) {
  const visibleTextChannels = [];
  const visibleVoiceChannels = [];

  server.categories.forEach((category) => {
    category.channels.forEach((channel) => {
      if (!canAccessChannel(server, username, channel.id)) {
        return;
      }

      if (channel.kind === 'voice') {
        visibleVoiceChannels.push(channel);
      } else {
        visibleTextChannels.push(channel);
      }
    });
  });

  return {
    memberCount: server.members.length,
    visibleTextChannels: visibleTextChannels.length,
    visibleVoiceChannels: visibleVoiceChannels.length,
    reportCount: server.reports.filter((report) => report.status === 'open').length
  };
}

function broadcast(type, payload) {
  const message = JSON.stringify({ type, ...payload });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastState() {
  broadcast('stateUpdated', {
    users: state.users.map(sanitizeUser),
    presence: serializePresenceState(),
    voicePresence: state.voicePresence,
    callPresence,
    typingState
  });
}

function broadcastServer(serverId) {
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return;
  }

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    const info = wsClients.get(client);
    if (!info?.username) {
      return;
    }

    const member = getServerMember(serverItem, info.username);
    if (!member) {
      return;
    }

    client.send(JSON.stringify({
      type: 'serverUpdated',
      server: serializeServer(serverItem, info.username),
      messages: buildVisibleMessagesForUser(info.username),
      directMessages: buildVisibleDms(info.username),
      voicePresence: state.voicePresence,
      presence: serializePresenceState(),
      callPresence,
      typingState
    }));
  });
}

function setTyping(scopeKey, username, isTyping) {
  typingState[scopeKey] = typingState[scopeKey] || [];
  typingState[scopeKey] = typingState[scopeKey].filter((item) => item !== username);
  if (isTyping) {
    typingState[scopeKey].push(username);
  }
  if (!typingState[scopeKey].length) {
    delete typingState[scopeKey];
  }
}

function postSystemMessage(channelId, text) {
  if (!state.messages[channelId]) {
    state.messages[channelId] = [];
  }

  const message = { id: uid('msg'), user: 'system', text, time: now(), reactions: {} };
  state.messages[channelId].push(message);
  return message;
}

function ensureMessageShape(message) {
  if (!message.reactions || typeof message.reactions !== 'object') {
    message.reactions = {};
  }
  if (!message.replyTo || typeof message.replyTo !== 'object') {
    message.replyTo = null;
  }
  if (!Array.isArray(message.attachments)) {
    message.attachments = [];
  }
  return message;
}

function getMessage(channelId, messageId) {
  const messages = state.messages[channelId] || [];
  return messages.find((message) => message.id === messageId) || null;
}

function getDmMessage(userA, userB, messageId) {
  const messages = getDmMessages(userA, userB);
  return messages.find((message) => message.id === messageId) || null;
}

function canModerateMessage(serverId, username) {
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return false;
  }
  const member = getServerMember(serverItem, username);
  return Boolean(member && ['admin', 'mod'].includes(member.role));
}

function sendChannelMessages(ws, channelId) {
  ws.send(JSON.stringify({
    type: 'messages',
    channelId,
    messages: state.messages[channelId] || []
  }));
}

function sendDmMessages(ws, username, peerUsername) {
  ws.send(JSON.stringify({
    type: 'dmMessages',
    peerUsername,
    messages: canUsersDm(username, peerUsername) ? getDmMessages(username, peerUsername) : []
  }));
}

function handleCommand({ serverId, channelId, username, commandText }) {
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return { error: 'Sunucu bulunamadi.' };
  }

  const [command, ...rest] = commandText.slice(1).split(' ');
  const args = rest.join(' ').trim();

  if (command === 'help') {
    return {
      systemText: 'Komutlar: /help, /stats, /poll soru | secenek1 | secenek2'
    };
  }

  if (command === 'stats') {
    const stats = getStatsForServer(serverItem, username);
    return {
      systemText: `Uyeler: ${stats.memberCount}, yazi kanali: ${stats.visibleTextChannels}, sesli oda: ${stats.visibleVoiceChannels}, acik rapor: ${stats.reportCount}`
    };
  }

  if (command === 'poll') {
    const pieces = args.split('|').map((piece) => piece.trim()).filter(Boolean);
    if (pieces.length < 3) {
      return { error: 'Ornek kullanim: /poll Soru | Secenek A | Secenek B' };
    }

    const [question, ...options] = pieces;
    const poll = {
      id: uid('poll'),
      question,
      options: options.map((option) => ({ label: option, votes: 0 })),
      createdBy: username,
      time: now(),
      channelId
    };

    serverItem.polls.unshift(poll);
    const pollText = `Anket: ${question} | ${options.join(' / ')}`;
    const message = { id: uid('msg'), user: 'bot', text: pollText, time: now(), reactions: {} };
    if (!state.messages[channelId]) {
      state.messages[channelId] = [];
    }
    state.messages[channelId].push(message);
    saveState();
    broadcastServer(serverId);
    return { postedMessage: message };
  }

  return { error: 'Bilinmeyen komut. /help yazabilirsin.' };
}

app.use('/', express.static(FRONTEND_DIR));

app.get('/api/bootstrap', (req, res) => {
  const username = req.query.username;
  const user = getUser(username);

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (user.banned) {
    return res.status(403).json({ error: 'User is banned.' });
  }

  res.json(buildBootstrap(user.username));
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    timestamp: now(),
    users: state.users.length,
    servers: state.servers.length,
    persistence: persistenceMode
  });
});

app.get('/api/audit', (req, res) => {
  const { serverId, username } = req.query;
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }
  if (!canManageServer(serverItem, username)) {
    return res.status(403).json({ error: 'Yetki yok.' });
  }
  res.json({
    auditLogs: getServerAuditLogs(serverId)
      .slice(0, normalizeLimit(req.query.limit, 30))
      .map(serializeAuditLog)
  });
});

app.get('/api/invites', (req, res) => {
  const { serverId, username } = req.query;
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }
  if (!canManageServer(serverItem, username)) {
    return res.status(403).json({ error: 'Yetki yok.' });
  }
  res.json({
    invites: getServerInvites(serverId)
      .slice(0, normalizeLimit(req.query.limit, 20))
      .map((invite) => serializeInvite(invite, serverItem))
  });
});

app.get('/api/invite/:code', (req, res) => {
  const invite = getInviteByCode(req.params.code);
  if (!invite || !isInviteActive(invite)) {
    return res.status(404).json({ error: 'Invite not found or expired.' });
  }
  const serverItem = getServer(invite.serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }
  res.json({
    invite: serializeInvite(invite, serverItem),
    server: {
      id: serverItem.id,
      name: serverItem.name,
      memberCount: serverItem.members.length
    }
  });
});

app.get('/api/social', (req, res) => {
  const user = getUser(req.query.username);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  res.json({
    social: serializeSocialState(user.username),
    users: state.users.map(sanitizeUser),
    directMessages: buildVisibleDms(user.username)
  });
});

app.post('/api/invite', (req, res) => {
  const { serverId, actor, channelId, maxUses, expiresInHours } = req.body;
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }
  if (!canManageServer(serverItem, actor)) {
    return res.status(403).json({ error: 'Yetki yok.' });
  }

  const channel = getChannel(serverItem, channelId) || serverItem.categories[0]?.channels[0];
  if (!channel) {
    return res.status(400).json({ error: 'Invite channel not found.' });
  }

  const invite = {
    id: uid('inv'),
    code: generateInviteCode(),
    serverId: serverItem.id,
    channelId: channel.id,
    createdBy: actor,
    createdAt: now(),
    expiresAt: Number(expiresInHours) > 0 ? now() + (Number(expiresInHours) * 60 * 60 * 1000) : null,
    maxUses: Number(maxUses) > 0 ? Number(maxUses) : null,
    uses: 0,
    revokedAt: null
  };

  state.invites.unshift(invite);
  logAuditEvent({
    serverId,
    actor,
    action: 'invite.created',
    targetType: 'invite',
    targetId: invite.code,
    summary: `${actor} yeni bir davet linki olusturdu.`,
    metadata: {
      channelId: channel.id,
      maxUses: invite.maxUses,
      expiresAt: invite.expiresAt
    }
  });
  saveState();
  broadcastServer(serverId);
  res.json({
    invite: serializeInvite(invite, serverItem),
    server: serializeServer(serverItem, actor)
  });
});

app.post('/api/invite/redeem', (req, res) => {
  const { code, username } = req.body;
  const user = getUser(username);
  const invite = getInviteByCode(code);

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  if (!invite || !isInviteActive(invite)) {
    return res.status(404).json({ error: 'Invite not found or expired.' });
  }

  const serverItem = getServer(invite.serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }

  if (!getServerMember(serverItem, user.username)) {
    serverItem.members.push({ username: user.username, role: 'member' });
  }

  invite.uses += 1;
  const presence = ensurePresenceEntry(user.username);
  presence.currentServerId = serverItem.id;
  presence.currentChannelId = invite.channelId || serverItem.categories[0]?.channels[0]?.id || null;

  logAuditEvent({
    serverId: serverItem.id,
    actor: user.username,
    action: 'invite.redeemed',
    targetType: 'invite',
    targetId: invite.code,
    summary: `${user.username} davet linki ile sunucuya katildi.`,
    metadata: { channelId: invite.channelId }
  });
  saveState();
  broadcastServer(serverItem.id);
  broadcastState();
  res.json({
    success: true,
    server: serializeServer(serverItem, user.username),
    channelId: presence.currentChannelId
  });
});

app.post('/api/invite/revoke', (req, res) => {
  const { code, actor } = req.body;
  const invite = getInviteByCode(code);
  if (!invite) {
    return res.status(404).json({ error: 'Invite not found.' });
  }
  const serverItem = getServer(invite.serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }
  if (!canManageServer(serverItem, actor)) {
    return res.status(403).json({ error: 'Yetki yok.' });
  }

  invite.revokedAt = now();
  logAuditEvent({
    serverId: serverItem.id,
    actor,
    action: 'invite.revoked',
    targetType: 'invite',
    targetId: invite.code,
    summary: `${actor} ${invite.code} davet linkini iptal etti.`
  });
  saveState();
  broadcastServer(serverItem.id);
  res.json({
    success: true,
    server: serializeServer(serverItem, actor)
  });
});

app.post('/api/friend-request', (req, res) => {
  const { from, to } = req.body;
  const sender = getUser(from);
  const receiver = getUser(to);

  if (!sender || !receiver) {
    return res.status(404).json({ error: 'User not found.' });
  }
  if (sender.username === receiver.username) {
    return res.status(400).json({ error: 'Kendine arkadaslik istegi gonderemezsin.' });
  }
  if (areFriends(sender.username, receiver.username)) {
    return res.status(400).json({ error: 'Zaten arkadassiniz.' });
  }
  if (isBlocked(sender.username, receiver.username) || isBlocked(receiver.username, sender.username)) {
    return res.status(403).json({ error: 'Bu kullanici ile sosyal etkilesim engellenmis.' });
  }
  if (getPendingFriendRequest(sender.username, receiver.username) || getPendingFriendRequest(receiver.username, sender.username)) {
    return res.status(400).json({ error: 'Bekleyen bir arkadaslik istegi zaten var.' });
  }

  state.friendRequests.unshift({
    id: uid('frq'),
    from: sender.username,
    to: receiver.username,
    status: 'pending',
    createdAt: now(),
    respondedAt: null
  });

  state.servers
    .filter((serverItem) => getServerMember(serverItem, sender.username) || getServerMember(serverItem, receiver.username))
    .forEach((serverItem) => {
      logAuditEvent({
        serverId: serverItem.id,
        actor: sender.username,
        action: 'friend.request.sent',
        targetType: 'user',
        targetId: receiver.username,
        summary: `${sender.username} ${receiver.username} kullanicisina arkadaslik istegi gonderdi.`
      });
    });

  saveState();
  refreshSocialSessions([sender.username, receiver.username]);
  res.json({ success: true });
});

app.post('/api/friend-request/respond', (req, res) => {
  const { username, fromUser, action } = req.body;
  const receiver = getUser(username);
  const sender = getUser(fromUser);
  const requestItem = getPendingFriendRequest(fromUser, username);

  if (!receiver || !sender || !requestItem) {
    return res.status(404).json({ error: 'Bekleyen istek bulunamadi.' });
  }
  if (!['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action.' });
  }

  requestItem.status = action === 'accept' ? 'accepted' : 'declined';
  requestItem.respondedAt = now();

  if (action === 'accept' && !areFriends(sender.username, receiver.username)) {
    state.friendships.unshift({
      id: uid('frd'),
      key: getFriendKey(sender.username, receiver.username),
      users: [sender.username, receiver.username].sort(),
      createdAt: now()
    });
  }

  state.servers
    .filter((serverItem) => getServerMember(serverItem, sender.username) || getServerMember(serverItem, receiver.username))
    .forEach((serverItem) => {
      logAuditEvent({
        serverId: serverItem.id,
        actor: receiver.username,
        action: action === 'accept' ? 'friend.request.accepted' : 'friend.request.declined',
        targetType: 'user',
        targetId: sender.username,
        summary: `${receiver.username} ${sender.username} istegine ${action === 'accept' ? 'kabul' : 'red'} verdi.`
      });
    });

  saveState();
  refreshSocialSessions([sender.username, receiver.username]);
  res.json({ success: true });
});

app.post('/api/friend/remove', (req, res) => {
  const { username, targetUser } = req.body;
  const user = getUser(username);
  const target = getUser(targetUser);
  if (!user || !target) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const key = getFriendKey(user.username, target.username);
  const before = state.friendships.length;
  state.friendships = state.friendships.filter((friendship) => friendship.key !== key);
  if (state.friendships.length === before) {
    return res.status(404).json({ error: 'Arkadaslik bulunamadi.' });
  }

  state.servers
    .filter((serverItem) => getServerMember(serverItem, user.username) || getServerMember(serverItem, target.username))
    .forEach((serverItem) => {
      logAuditEvent({
        serverId: serverItem.id,
        actor: user.username,
        action: 'friend.removed',
        targetType: 'user',
        targetId: target.username,
        summary: `${user.username} ${target.username} kullanicisini arkadas listesinden cikardi.`
      });
    });

  saveState();
  refreshSocialSessions([user.username, target.username]);
  res.json({ success: true });
});

app.post('/api/friend/block', (req, res) => {
  const { username, targetUser, blocked } = req.body;
  const user = getUser(username);
  const target = getUser(targetUser);
  if (!user || !target) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const profile = ensureSocialProfile(user.username);
  profile.blockedUsers = profile.blockedUsers.filter((item) => item !== target.username);
  if (blocked) {
    profile.blockedUsers.push(target.username);
  }
  state.blocks[user.username] = [...new Set(profile.blockedUsers)];

  logAuditEvent({
    serverId: null,
    actor: user.username,
    action: blocked ? 'user.blocked' : 'user.unblocked',
    targetType: 'user',
    targetId: target.username,
    summary: `${user.username} ${target.username} kullanicisini ${blocked ? 'engelledi' : 'engelini kaldirdi'}.`
  });

  saveState();
  refreshSocialSessions([user.username, target.username]);
  res.json({ success: true });
});

app.post('/api/privacy', (req, res) => {
  const { username, dmPolicy } = req.body;
  const user = getUser(username);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  if (!['everyone', 'friends'].includes(dmPolicy)) {
    return res.status(400).json({ error: 'Invalid privacy setting.' });
  }

  ensureSocialProfile(user.username).privacy.dmPolicy = dmPolicy;
  state.privacy[user.username].dmPolicy = dmPolicy;

  logAuditEvent({
    actor: user.username,
    action: 'privacy.updated',
    targetType: 'user',
    targetId: user.username,
    summary: `${user.username} DM gizlilik ayarini ${dmPolicy} olarak degistirdi.`,
    metadata: { dmPolicy }
  });

  saveState();
  refreshSocialSessions([user.username]);
  res.json({
    success: true,
    social: serializeSocialState(user.username)
  });
});

app.post('/api/register', async (req, res) => {
  const username = req.body.username?.trim();
  const email = req.body.email?.trim();
  const password = req.body.password;
  const avatar = req.body.avatar;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password required.' });
  }

  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Username 3-24 karakter olmali ve sadece harf, rakam, _, -, . icerebilir.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Gecerli bir e-posta adresi gir.' });
  }

  if (String(password).length < 4) {
    return res.status(400).json({ error: 'Sifre en az 4 karakter olmali.' });
  }

  if (RESERVED_USERNAMES.has(normalizeUsername(username))) {
    return res.status(400).json({ error: 'Bu kullanici adi ayrilmis.' });
  }

  if (avatar && (typeof avatar !== 'string' || !avatar.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'Invalid avatar format.' });
  }

  if (getUser(username)) {
    return res.status(400).json({ error: 'Username already exists.' });
  }

  if (getUserByEmail(email)) {
    return res.status(400).json({ error: 'Bu e-posta zaten kullaniliyor.' });
  }

  pruneExpiredPendingRegistrations();
  const existingPending = getPendingRegistration({ username, email });
  const conflictingPending = state.pendingRegistrations.find((entry) => (
    normalizeUsername(entry.username) === normalizeUsername(username)
    || normalizeEmail(entry.email) === normalizeEmail(email)
  ));

  if (
    conflictingPending
    && (
      normalizeUsername(conflictingPending.username) !== normalizeUsername(username)
      || normalizeEmail(conflictingPending.email) !== normalizeEmail(email)
    )
  ) {
    return res.status(400).json({ error: 'Bu kullanici adi veya e-posta icin bekleyen bir dogrulama var.' });
  }

  if (existingPending && existingPending.resendAvailableAt > now()) {
    return res.status(429).json({
      error: `Kodu tekrar gondermek icin ${Math.ceil((existingPending.resendAvailableAt - now()) / 1000)} saniye bekle.`
    });
  }

  try {
    const verificationCode = createVerificationCode();
    await sendRegistrationCodeEmail({ email, username, code: verificationCode });
    upsertPendingRegistration({ username, email, password, avatar, code: verificationCode });
    saveState();
    res.json({
      success: true,
      email: email,
      maskedEmail: maskEmail(email),
      expiresInMs: REGISTER_CODE_TTL_MS,
      resendInMs: REGISTER_CODE_RESEND_MS
    });
  } catch (error) {
    res.status(503).json({ error: error.message || 'Dogrulama kodu gonderilemedi.' });
  }
});

app.post('/api/register/resend-code', async (req, res) => {
  const username = req.body.username?.trim();
  const email = req.body.email?.trim();
  const pendingEntry = getPendingRegistration({ username, email });

  if (!pendingEntry) {
    return res.status(404).json({ error: 'Bekleyen kayit bulunamadi. Kayit formunu yeniden doldur.' });
  }

  if (pendingEntry.resendAvailableAt > now()) {
    return res.status(429).json({
      error: `Kodu tekrar gondermek icin ${Math.ceil((pendingEntry.resendAvailableAt - now()) / 1000)} saniye bekle.`
    });
  }

  try {
    const verificationCode = createVerificationCode();
    await sendRegistrationCodeEmail({
      email: pendingEntry.email,
      username: pendingEntry.username,
      code: verificationCode
    });
    upsertPendingRegistration({
      username: pendingEntry.username,
      email: pendingEntry.email,
      password: pendingEntry.password,
      avatar: pendingEntry.avatar,
      code: verificationCode
    });
    saveState();
    res.json({
      success: true,
      maskedEmail: maskEmail(pendingEntry.email),
      expiresInMs: REGISTER_CODE_TTL_MS,
      resendInMs: REGISTER_CODE_RESEND_MS
    });
  } catch (error) {
    res.status(503).json({ error: error.message || 'Dogrulama kodu tekrar gonderilemedi.' });
  }
});

app.post('/api/register/verify-code', (req, res) => {
  const username = req.body.username?.trim();
  const email = req.body.email?.trim();
  const code = String(req.body.code || '').trim();
  const pendingEntry = getPendingRegistration({ username, email });

  if (!pendingEntry) {
    return res.status(404).json({ error: 'Bekleyen kayit bulunamadi. Kayit adimini yeniden baslat.' });
  }

  if (!code) {
    return res.status(400).json({ error: 'Dogrulama kodu gerekli.' });
  }

  if (pendingEntry.expiresAt <= now()) {
    state.pendingRegistrations = state.pendingRegistrations.filter((entry) => entry !== pendingEntry);
    saveState();
    return res.status(400).json({ error: 'Dogrulama kodunun suresi doldu. Yeni kod iste.' });
  }

  if (pendingEntry.codeHash !== hashVerificationCode(code)) {
    pendingEntry.attempts = Number(pendingEntry.attempts || 0) + 1;
    if (pendingEntry.attempts >= REGISTER_MAX_VERIFY_ATTEMPTS) {
      state.pendingRegistrations = state.pendingRegistrations.filter((entry) => entry !== pendingEntry);
      saveState();
      return res.status(400).json({ error: 'Cok fazla hatali deneme. Yeni kod iste.' });
    }
    saveState();
    return res.status(400).json({ error: 'Dogrulama kodu hatali.' });
  }

  if (getUser(username)) {
    state.pendingRegistrations = state.pendingRegistrations.filter((entry) => entry !== pendingEntry);
    saveState();
    return res.status(400).json({ error: 'Bu kullanici adi artik kullaniliyor. Farkli bir ad sec.' });
  }

  if (getUserByEmail(email)) {
    state.pendingRegistrations = state.pendingRegistrations.filter((entry) => entry !== pendingEntry);
    saveState();
    return res.status(400).json({ error: 'Bu e-posta artik kullaniliyor. Farkli bir e-posta dene.' });
  }

  const user = {
    username: pendingEntry.username,
    password: pendingEntry.password,
    email: pendingEntry.email,
    emailVerified: true,
    banned: false,
    mutedUntil: null,
    status: 'online',
    avatar: pendingEntry.avatar || null
  };

  state.users.push(user);
  state.pendingRegistrations = state.pendingRegistrations.filter((entry) => entry !== pendingEntry);
  state.presence[user.username] = {
    status: 'online',
    currentServerId: state.servers[0]?.id || null,
    currentChannelId: state.servers[0]?.categories[0]?.channels[0]?.id || null,
    voiceChannelId: null,
    lastSeenAt: null
  };
  ensureMemberships(user.username);
  state.servers.forEach((serverItem) => {
    logAuditEvent({
      serverId: serverItem.id,
      actor: user.username,
      action: 'member.registered',
      targetType: 'user',
      targetId: user.username,
      summary: `${user.username} sunucuya kaydoldu.`
    });
  });
  saveState();
  broadcastState();
  state.servers.forEach((serverItem) => broadcastServer(serverItem.id));
  res.json({ success: true, username: user.username });
});

app.post('/api/login', (req, res) => {
  const username = req.body.username?.trim();
  const password = req.body.password;
  const user = resolveLoginUser(username);

  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  if (user.banned) {
    return res.status(403).json({ error: 'This user is banned.' });
  }

  const presence = ensurePresenceEntry(user.username);
  presence.lastSeenAt = null;
  state.servers
    .filter((serverItem) => getServerMember(serverItem, user.username))
    .forEach((serverItem) => {
      logAuditEvent({
        serverId: serverItem.id,
        actor: user.username,
        action: 'member.login',
        targetType: 'user',
        targetId: user.username,
        summary: `${user.username} giris yapti.`
      });
    });
  saveState();
  broadcastState();
  res.json({ success: true, username: user.username });
});

app.post('/api/server', (req, res) => {
  const { name, creator } = req.body;
  if (!name || !creator) {
    return res.status(400).json({ error: 'Name and creator required.' });
  }

  if (!getUser(creator)) {
    return res.status(400).json({ error: 'Creator not found.' });
  }

  const serverItem = {
    id: uid('srv'),
    name: name.trim(),
    members: [{ username: creator, role: 'admin' }],
    categories: [
      {
        id: uid('cat'),
        name: 'Genel',
        channels: [
          { id: uid('chn'), name: 'general', kind: 'text', allowedRoles: ['admin', 'mod', 'member'] },
          { id: uid('chn'), name: 'voice-room', kind: 'voice', allowedRoles: ['admin', 'mod', 'member'] }
        ]
      }
    ],
    reports: [],
    polls: []
  };

  state.servers.push(serverItem);
  const generalChannel = serverItem.categories[0].channels[0];
  state.messages[generalChannel.id] = [
    { id: uid('msg'), user: 'system', text: `${creator} sunucuyu olusturdu.`, time: now() }
  ];
  state.voicePresence[serverItem.categories[0].channels[1].id] = [];
  state.presence[creator] = state.presence[creator] || {};
  state.presence[creator].currentServerId = serverItem.id;
  state.presence[creator].currentChannelId = generalChannel.id;
  logAuditEvent({
    serverId: serverItem.id,
    actor: creator,
    action: 'server.created',
    targetType: 'server',
    targetId: serverItem.id,
    summary: `${creator} ${serverItem.name} sunucusunu olusturdu.`
  });
  saveState();
  broadcastServer(serverItem.id);
  res.json({ server: serializeServer(serverItem, creator) });
});

app.post('/api/channel', (req, res) => {
  const { serverId, categoryId, name, kind, allowedRoles, actor } = req.body;
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }

  const member = getServerMember(serverItem, actor);
  if (!member || !['admin', 'mod'].includes(member.role)) {
    return res.status(403).json({ error: 'Yetki yok.' });
  }

  const category = serverItem.categories.find((item) => item.id === categoryId);
  if (!category) {
    return res.status(404).json({ error: 'Category not found.' });
  }

  const channel = {
    id: uid('chn'),
    name: name.trim(),
    kind: kind === 'voice' ? 'voice' : 'text',
    allowedRoles: Array.isArray(allowedRoles) && allowedRoles.length ? allowedRoles : ['admin', 'mod', 'member']
  };

  category.channels.push(channel);
  if (channel.kind === 'voice') {
    state.voicePresence[channel.id] = [];
  } else {
    state.messages[channel.id] = [];
  }
  logAuditEvent({
    serverId,
    actor,
    action: 'channel.created',
    targetType: 'channel',
    targetId: channel.id,
    summary: `${actor} ${channel.name} kanalini olusturdu.`,
    metadata: { kind: channel.kind, categoryId }
  });
  saveState();
  broadcastServer(serverId);
  res.json({ channel });
});

app.post('/api/category', (req, res) => {
  const { serverId, name, actor } = req.body;
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }

  const member = getServerMember(serverItem, actor);
  if (!member || !['admin', 'mod'].includes(member.role)) {
    return res.status(403).json({ error: 'Yetki yok.' });
  }

  const categoryName = name?.trim();
  if (!categoryName) {
    return res.status(400).json({ error: 'Category name required.' });
  }

  const category = {
    id: uid('cat'),
    name: categoryName,
    channels: []
  };

  serverItem.categories.push(category);
  logAuditEvent({
    serverId,
    actor,
    action: 'category.created',
    targetType: 'category',
    targetId: category.id,
    summary: `${actor} ${category.name} kategorisini olusturdu.`
  });
  saveState();
  broadcastServer(serverId);
  res.json({ category });
});

app.post('/api/role', (req, res) => {
  const { serverId, targetUser, role, actor } = req.body;
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }

  const actorMember = getServerMember(serverItem, actor);
  if (!actorMember || actorMember.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can change roles.' });
  }

  const targetMember = getServerMember(serverItem, targetUser);
  if (!targetMember) {
    return res.status(404).json({ error: 'Target user not found.' });
  }

  if (!['admin', 'mod', 'member'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  targetMember.role = role;
  logAuditEvent({
    serverId,
    actor,
    action: 'role.changed',
    targetType: 'member',
    targetId: targetUser,
    summary: `${actor} ${targetUser} kullanicisinin rolunu ${role} yapti.`,
    metadata: { role }
  });
  saveState();
  broadcastServer(serverId);
  res.json({ success: true });
});

app.post('/api/moderation', (req, res) => {
  const { action, actor, targetUser, serverId, reason } = req.body;
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }

  const actorMember = getServerMember(serverItem, actor);
  if (!actorMember || !['admin', 'mod'].includes(actorMember.role)) {
    return res.status(403).json({ error: 'Yetki yok.' });
  }

  const target = getUser(targetUser);
  if (!target) {
    return res.status(404).json({ error: 'Target not found.' });
  }

  if (action === 'ban') {
    target.banned = true;
  } else if (action === 'mute') {
    target.mutedUntil = now() + 10 * 60 * 1000;
  } else if (action === 'unmute') {
    target.mutedUntil = null;
  } else {
    return res.status(400).json({ error: 'Invalid action.' });
  }

  const reportLine = `${actor} ${targetUser} kullanicisi icin ${action} islemi yapti. Sebep: ${reason || 'Belirtilmedi'}`;
  const modOnlyChannel = serverItem.categories.flatMap((category) => category.channels).find((channel) => channel.name === 'mod-only');
  if (modOnlyChannel) {
    postSystemMessage(modOnlyChannel.id, reportLine);
  }
  logAuditEvent({
    serverId,
    actor,
    action: `moderation.${action}`,
    targetType: 'member',
    targetId: targetUser,
    summary: reportLine,
    metadata: { reason: reason || null }
  });
  saveState();
  broadcastState();
  broadcastServer(serverId);
  res.json({ success: true });
});

app.post('/api/report', (req, res) => {
  const { serverId, reporter, targetUser, channelId, reason } = req.body;
  const serverItem = getServer(serverId);
  if (!serverItem) {
    return res.status(404).json({ error: 'Server not found.' });
  }

  serverItem.reports.unshift({
    id: uid('rpt'),
    reporter,
    targetUser,
    channelId,
    reason,
    status: 'open',
    time: now()
  });
  logAuditEvent({
    serverId,
    actor: reporter,
    action: 'report.created',
    targetType: 'member',
    targetId: targetUser,
    summary: `${reporter} ${targetUser} icin rapor olusturdu.`,
    metadata: { channelId, reason }
  });
  saveState();
  broadcastServer(serverId);
  res.json({ success: true });
});

app.post('/api/presence', (req, res) => {
  const { username, status } = req.body;
  const user = getUser(username);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (status && !ALLOWED_PRESENCE.has(status)) {
    return res.status(400).json({ error: 'Invalid presence value.' });
  }

  const presence = ensurePresenceEntry(user.username);
  presence.status = status || 'online';
  saveState();
  broadcastState();
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  const user = getUser(req.body.username);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (!userHasOtherActiveSession(user.username)) {
    setUserOffline(user.username);
    saveState();
    broadcastState();
  }

  res.json({ success: true });
});

app.post('/api/avatar', (req, res) => {
  const { username, avatar } = req.body;
  const user = getUser(username);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (avatar && (typeof avatar !== 'string' || !avatar.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'Invalid avatar format.' });
  }

  user.avatar = avatar || null;
  state.servers
    .filter((serverItem) => getServerMember(serverItem, user.username))
    .forEach((serverItem) => {
      logAuditEvent({
        serverId: serverItem.id,
        actor: user.username,
        action: 'profile.avatar.updated',
        targetType: 'user',
        targetId: user.username,
        summary: `${user.username} profil fotografini guncelledi.`
      });
    });
  saveState();
  broadcastState();
  state.servers.forEach((serverItem) => broadcastServer(serverItem.id));
  res.json({ success: true, avatar: user.avatar || null });
});

const wsClients = new Map();

function getWsClientsByUsername(username, excludedClient = null) {
  const normalized = normalizeUsername(username);
  const clients = [];
  for (const [client, info] of wsClients.entries()) {
    if (client === excludedClient) {
      continue;
    }
    if (normalizeUsername(info?.username) === normalized && client.readyState === WebSocket.OPEN) {
      clients.push(client);
    }
  }
  return clients;
}

function getWsByUsername(username) {
  return getWsClientsByUsername(username)[0] || null;
}

function userHasOtherActiveSession(username, excludedClient = null) {
  return getWsClientsByUsername(username, excludedClient).length > 0;
}

function sendToUserSessions(username, payload) {
  const message = JSON.stringify(payload);
  getWsClientsByUsername(username).forEach((client) => {
    client.send(message);
  });
}

function sendDmMessagesToUserSessions(username, peerUsername) {
  sendToUserSessions(username, {
    type: 'dmMessages',
    peerUsername,
    messages: canUsersDm(username, peerUsername) ? getDmMessages(username, peerUsername) : []
  });
}

function sendSocialStateToUserSessions(username) {
  sendToUserSessions(username, {
    type: 'socialUpdated',
    social: serializeSocialState(username),
    directMessages: buildVisibleDms(username),
    users: state.users.map(sanitizeUser)
  });
}

function refreshSocialSessions(usernames = []) {
  [...new Set(usernames.filter(Boolean))].forEach((username) => {
    sendSocialStateToUserSessions(username);
  });
}

function removeUserFromCalls(username) {
  Object.keys(callPresence).forEach((channelId) => {
    callPresence[channelId] = (callPresence[channelId] || []).filter((item) => item !== username);
    if (!callPresence[channelId].length) {
      delete callPresence[channelId];
    }
  });
}

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();

  for (const networkName of Object.keys(interfaces)) {
    for (const network of interfaces[networkName] || []) {
      if (network.family === 'IPv4' && !network.internal) {
        return network.address;
      }
    }
  }

  return null;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === 'identify') {
      const user = getUser(data.username);
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', message: 'Gecersiz oturum. Lutfen tekrar giris yap.' }));
        ws.close(4004, 'unknown-user');
        return;
      }

      wsClients.set(ws, { username: user.username, currentCallChannelId: null });
      setUserOnline(user.username);
      saveState();
      broadcastState();
      return;
    }

    if (data.type === 'switchChannel') {
      const serverItem = getServer(data.serverId);
      if (!serverItem || !canAccessChannel(serverItem, data.username, data.channelId)) {
        return;
      }

      state.presence[data.username] = state.presence[data.username] || {};
      state.presence[data.username].currentServerId = data.serverId;
      state.presence[data.username].currentChannelId = data.channelId;
      saveState();
      sendChannelMessages(ws, data.channelId);
      broadcastState();
      return;
    }

    if (data.type === 'openDm') {
      if (!getUser(data.username) || !getUser(data.peerUsername)) {
        return;
      }
      if (!canUsersDm(data.username, data.peerUsername)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Bu kullanici ile DM iznin yok.' }));
        refreshSocialSessions([data.username]);
        return;
      }
      if (markDmSeen(data.username, data.peerUsername)) {
        saveState();
      }
      sendDmMessagesToUserSessions(data.username, data.peerUsername);
      sendDmMessagesToUserSessions(data.peerUsername, data.username);
      return;
    }

    if (data.type === 'typing') {
      if (data.scope === 'dm') {
        if (!canUsersDm(data.username, data.peerUsername)) {
          return;
        }
        const scopeKey = `dm:${getDmKey(data.username, data.peerUsername)}`;
        setTyping(scopeKey, data.username, Boolean(data.isTyping));
        broadcast('typingState', {
          scope: 'dm',
          scopeKey,
          users: typingState[scopeKey] || []
        });
        return;
      }

      if (data.scope === 'channel') {
        const scopeKey = `channel:${data.channelId}`;
        setTyping(scopeKey, data.username, Boolean(data.isTyping));
        broadcast('typingState', {
          scope: 'channel',
          scopeKey,
          users: typingState[scopeKey] || []
        });
      }
      return;
    }

    if (data.type === 'joinVoice') {
      const serverItem = getServer(data.serverId);
      if (!serverItem || !canAccessChannel(serverItem, data.username, data.channelId)) {
        return;
      }

      Object.keys(state.voicePresence).forEach((channelId) => {
        state.voicePresence[channelId] = (state.voicePresence[channelId] || []).filter((user) => user !== data.username);
      });
      state.voicePresence[data.channelId] = state.voicePresence[data.channelId] || [];
      if (!state.voicePresence[data.channelId].includes(data.username)) {
        state.voicePresence[data.channelId].push(data.username);
      }

      state.presence[data.username] = state.presence[data.username] || {};
      state.presence[data.username].voiceChannelId = data.channelId;
      saveState();
      broadcastServer(data.serverId);
      broadcastState();
      return;
    }

    if (data.type === 'leaveVoice') {
      Object.keys(state.voicePresence).forEach((channelId) => {
        state.voicePresence[channelId] = (state.voicePresence[channelId] || []).filter((user) => user !== data.username);
      });

      state.presence[data.username] = state.presence[data.username] || {};
      state.presence[data.username].voiceChannelId = null;
      saveState();
      if (data.serverId) {
        broadcastServer(data.serverId);
      }
      broadcastState();
      return;
    }

    if (data.type === 'joinCall') {
      const serverItem = getServer(data.serverId);
      if (!serverItem || !canAccessChannel(serverItem, data.username, data.channelId)) {
        return;
      }

      removeUserFromCalls(data.username);
      callPresence[data.channelId] = callPresence[data.channelId] || [];
      if (!callPresence[data.channelId].includes(data.username)) {
        callPresence[data.channelId].push(data.username);
      }

      const info = wsClients.get(ws) || { username: data.username };
      info.currentCallChannelId = data.channelId;
      wsClients.set(ws, info);

      broadcast('callState', {
        channelId: data.channelId,
        participants: callPresence[data.channelId]
      });
      return;
    }

    if (data.type === 'leaveCall') {
      removeUserFromCalls(data.username);
      const info = wsClients.get(ws) || { username: data.username };
      info.currentCallChannelId = null;
      wsClients.set(ws, info);
      broadcast('callLeft', {
        username: data.username,
        channelId: data.channelId
      });
      broadcastState();
      return;
    }

    if (data.type === 'webrtcSignal') {
      const targetClient = getWsByUsername(data.target);
      if (!targetClient) {
        return;
      }

      targetClient.send(JSON.stringify({
        type: 'webrtcSignal',
        from: data.username,
        signal: data.signal,
        channelId: data.channelId
      }));
      return;
    }

    if (data.type === 'message') {
      const serverItem = getServer(data.serverId);
      const user = getUser(data.username);
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const attachments = sanitizeAttachments(data.attachments);
      if (!serverItem || !user || !canAccessChannel(serverItem, data.username, data.channelId)) {
        return;
      }

      if (user.banned) {
        ws.send(JSON.stringify({ type: 'error', message: 'Banned user cannot send messages.' }));
        return;
      }

      if (user.mutedUntil && user.mutedUntil > now()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Bu kullanici su anda mute durumunda.' }));
        return;
      }

      if (text.startsWith('/')) {
        const result = handleCommand({
          serverId: data.serverId,
          channelId: data.channelId,
          username: data.username,
          commandText: text
        });

        if (result.error) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
        } else if (result.systemText) {
          ws.send(JSON.stringify({ type: 'system', text: result.systemText }));
        }
        return;
      }

      if (!text && !attachments.length) {
        return;
      }

      const message = {
        id: uid('msg'),
        user: user.username,
        text,
        time: now(),
        reactions: {},
        replyTo: sanitizeReply(data.replyTo),
        attachments
      };

      if (!state.messages[data.channelId]) {
        state.messages[data.channelId] = [];
      }

      state.messages[data.channelId].push(message);
      saveState();
      broadcast('message', {
        serverId: data.serverId,
        channelId: data.channelId,
        message
      });
      return;
    }

    if (data.type === 'dmMessage') {
      const sender = getUser(data.username);
      const receiver = getUser(data.peerUsername);
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const attachments = sanitizeAttachments(data.attachments);
      if (!sender || !receiver || (!text && !attachments.length)) {
        return;
      }
      if (!canUsersDm(sender.username, receiver.username)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Bu kullaniciya DM gonderemiyorsun.' }));
        refreshSocialSessions([sender.username]);
        return;
      }

      const dmKey = getDmKey(data.username, data.peerUsername);
      const message = {
        id: uid('dm'),
        user: sender.username,
        text,
        time: now(),
        reactions: {},
        seenBy: [sender.username],
        replyTo: sanitizeReply(data.replyTo),
        attachments
      };

      state.directMessages[dmKey] = state.directMessages[dmKey] || [];
      state.directMessages[dmKey].push(message);
      setTyping(`dm:${dmKey}`, data.username, false);
      saveState();

      sendDmMessagesToUserSessions(data.username, data.peerUsername);
      sendDmMessagesToUserSessions(data.peerUsername, data.username);
      return;
    }

    if (data.type === 'editDmMessage') {
      const message = getDmMessage(data.username, data.peerUsername, data.messageId);
      if (!message || message.user !== getUser(data.username)?.username || !data.text?.trim()) {
        return;
      }

      message.text = data.text.trim();
      message.editedAt = now();
      ensureMessageShape(message);
      saveState();
      sendDmMessagesToUserSessions(data.username, data.peerUsername);
      sendDmMessagesToUserSessions(data.peerUsername, data.username);
      return;
    }

    if (data.type === 'deleteDmMessage') {
      const dmKey = getDmKey(data.username, data.peerUsername);
      const list = state.directMessages[dmKey] || [];
      const index = list.findIndex((message) => message.id === data.messageId && message.user === getUser(data.username)?.username);
      if (index < 0) {
        return;
      }

      list.splice(index, 1);
      saveState();
      sendDmMessagesToUserSessions(data.username, data.peerUsername);
      sendDmMessagesToUserSessions(data.peerUsername, data.username);
      return;
    }

    if (data.type === 'react') {
      const serverItem = getServer(data.serverId);
      if (!serverItem || !canAccessChannel(serverItem, data.username, data.channelId)) {
        return;
      }

      const message = getMessage(data.channelId, data.messageId);
      if (!message) {
        return;
      }

      ensureMessageShape(message);
      const emoji = data.emoji;
      if (!emoji) {
        return;
      }

      const currentUsers = Array.isArray(message.reactions[emoji]) ? message.reactions[emoji] : [];
      if (currentUsers.includes(data.username)) {
        message.reactions[emoji] = currentUsers.filter((user) => user !== data.username);
        if (!message.reactions[emoji].length) {
          delete message.reactions[emoji];
        }
      } else {
        message.reactions[emoji] = [...currentUsers, data.username];
      }

      saveState();
      broadcast('messageUpdated', {
        serverId: data.serverId,
        channelId: data.channelId,
        message
      });
      return;
    }

    if (data.type === 'editMessage') {
      const serverItem = getServer(data.serverId);
      if (!serverItem || !canAccessChannel(serverItem, data.username, data.channelId)) {
        return;
      }

      const message = getMessage(data.channelId, data.messageId);
      if (!message) {
        return;
      }

      const canEdit = message.user === data.username || canModerateMessage(data.serverId, data.username);
      if (!canEdit || !data.text?.trim()) {
        return;
      }

      message.text = data.text.trim();
      message.editedAt = now();
      ensureMessageShape(message);
      saveState();
      broadcast('messageUpdated', {
        serverId: data.serverId,
        channelId: data.channelId,
        message
      });
      return;
    }

    if (data.type === 'deleteMessage') {
      const serverItem = getServer(data.serverId);
      if (!serverItem || !canAccessChannel(serverItem, data.username, data.channelId)) {
        return;
      }

      const messages = state.messages[data.channelId] || [];
      const index = messages.findIndex((message) => message.id === data.messageId);
      if (index < 0) {
        return;
      }

      const message = messages[index];
      const canDelete = message.user === data.username || canModerateMessage(data.serverId, data.username);
      if (!canDelete) {
        return;
      }

      messages.splice(index, 1);
      saveState();
      broadcast('messageDeleted', {
        serverId: data.serverId,
        channelId: data.channelId,
        messageId: data.messageId
      });
      return;
    }
  });

  ws.on('close', () => {
    const info = wsClients.get(ws);
    wsClients.delete(ws);
    if (info?.username) {
      Object.keys(typingState).forEach((scopeKey) => {
        setTyping(scopeKey, info.username, false);
      });
      if (!userHasOtherActiveSession(info.username)) {
        setUserOffline(info.username);
        saveState();
        broadcast('callLeft', {
          username: info.username,
          channelId: info.currentCallChannelId
        });
      }
      broadcastState();
    }
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    next();
    return;
  }

  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  await initializePersistence();

  server.listen(PORT, HOST, () => {
    const localIp = getLocalIpAddress();
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Persistence mode: ${persistenceMode}`);
    if (localIp) {
      console.log(`LAN access: http://${localIp}:${PORT}`);
    }
  });
}

startServer().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
});
