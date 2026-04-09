const API = {
  bootstrap: '/api/bootstrap',
  register: '/api/register',
  login: '/api/login',
  logout: '/api/logout',
  createServer: '/api/server',
  createCategory: '/api/category',
  createChannel: '/api/channel',
  changeRole: '/api/role',
  moderation: '/api/moderation',
  report: '/api/report',
  presence: '/api/presence',
  avatar: '/api/avatar'
};

let ws = null;
let currentUser = null;
let appState = {
  servers: [],
  messages: {},
  directMessages: {},
  voicePresence: {},
  presence: {},
  users: [],
  callPresence: {},
  typingState: {}
};
let currentServerId = null;
let currentChannelId = null;
let currentVoiceChannelId = null;
let activeCallChannelId = null;
let activeSidebarTab = 'members';
let activeConversationType = 'channel';
let activeDmUser = null;
let unreadDmCounts = {};
let typingTimer = null;
let localStream = null;
let audioContext = null;
let notificationsEnabled = false;
let mobileView = 'chat';
let replyTarget = null;
let shouldReconnect = true;
let pendingAttachments = [];
const peerConnections = new Map();
const remoteStreams = new Map();
let lastCallCapabilityMessage = '';
let callOverlayOpen = false;
let focusedCallTileKey = 'self';
const makingOffer = new Map();
const ignoredOffer = new Map();

const serverList = document.getElementById('serverList');
const channelTree = document.getElementById('channelTree');
const currentLocation = document.getElementById('currentLocation');
const userBadge = document.getElementById('userBadge');
const serverInfoName = document.getElementById('serverInfoName');
const pinnedMessageText = document.getElementById('pinnedMessageText');
const presenceSelect = document.getElementById('presenceSelect');
const messageInput = document.getElementById('messageInput');
const replyPreview = document.getElementById('replyPreview');
const attachmentPreview = document.getElementById('attachmentPreview');
const attachmentInput = document.getElementById('attachmentInput');
const sendBtn = document.getElementById('sendBtn');
const chatArea = document.getElementById('chatArea');
const memberList = document.getElementById('memberList');
const dmList = document.getElementById('dmList');
const voicePanel = document.getElementById('voicePanel');
const reportList = document.getElementById('reportList');
const pollList = document.getElementById('pollList');
const videoPanel = document.getElementById('videoPanel');
const modalOverlay = document.getElementById('modalOverlay');
const modal = document.getElementById('modal');
const callOverlay = document.getElementById('callOverlay');
const callStage = document.getElementById('callStage');
const callFilmstrip = document.getElementById('callFilmstrip');
const callOverlayTitle = document.getElementById('callOverlayTitle');
const callOverlayMeta = document.getElementById('callOverlayMeta');
const callOverlayStatus = document.getElementById('callOverlayStatus');
const callOverlaySummary = document.getElementById('callOverlaySummary');
const callOverlayMembers = document.getElementById('callOverlayMembers');
const callOverlayJoinBtn = document.getElementById('callOverlayJoinBtn');
const callOverlayStartBtn = document.getElementById('callOverlayStartBtn');
const callOverlayMicBtn = document.getElementById('callOverlayMicBtn');
const callOverlayCameraBtn = document.getElementById('callOverlayCameraBtn');
const callOverlayEndBtn = document.getElementById('callOverlayEndBtn');
const callOverlayCloseBtn = document.getElementById('callOverlayCloseBtn');
const callOverlayMinimizeBtn = document.getElementById('callOverlayMinimizeBtn');
const createServerBtn = document.getElementById('createServerBtn');
const createCategoryBtn = document.getElementById('createCategoryBtn');
const createChannelBtn = document.getElementById('createChannelBtn');
const assignRoleBtn = document.getElementById('assignRoleBtn');
const moderateBtn = document.getElementById('moderateBtn');
const reportBtn = document.getElementById('reportBtn');
const joinVoiceBtn = document.getElementById('joinVoiceBtn');
const leaveVoiceBtn = document.getElementById('leaveVoiceBtn');
const logoutBtn = document.getElementById('logoutBtn');
const helperText = document.getElementById('helperText');
const permissionsList = document.getElementById('permissionsList');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const searchBtn = document.getElementById('searchBtn');
const pinBtn = document.getElementById('pinBtn');
const videoBtn = document.getElementById('videoBtn');
const membersToggleBtn = document.getElementById('membersToggleBtn');
const navHomeBtn = document.getElementById('navHomeBtn');
const navChatBtn = document.getElementById('navChatBtn');
const navGameBtn = document.getElementById('navGameBtn');
const navAppsBtn = document.getElementById('navAppsBtn');
const startVideoBtn = document.getElementById('startVideoBtn');
const endVideoBtn = document.getElementById('endVideoBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const sidebar = document.querySelector('.sidebar');
const membersTabBtn = document.getElementById('membersTabBtn');
const dmTabBtn = document.getElementById('dmTabBtn');
const composerAddBtn = document.getElementById('composerAddBtn');
const membersPanelTitle = document.getElementById('membersPanelTitle');
const membersPanelSubtitle = document.getElementById('membersPanelSubtitle');
const membersCountPill = document.getElementById('membersCountPill');
const appShell = document.getElementById('appShell');
const mobileNav = document.getElementById('mobileNav');
const mobileNavButtons = [...document.querySelectorAll('[data-mobile-target]')];
const mobileWorkspaceBtn = document.getElementById('mobileWorkspaceBtn');
const mobileContextTag = document.getElementById('mobileContextTag');
const mobileChannelsSummary = document.getElementById('mobileChannelsSummary');
const mobilePeopleSummary = document.getElementById('mobilePeopleSummary');

let currentTheme = localStorage.getItem('community-theme')
  || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
let micEnabled = true;
let cameraEnabled = true;

function isMobileView() {
  return window.innerWidth <= 860;
}

function setMobileView(view) {
  mobileView = view;
  if (view === 'members' && isDmConversation()) {
    activeSidebarTab = 'dm';
  }
  appShell.dataset.mobileView = view;
  mobileNavButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.mobileTarget === view);
  });
}

function syncMobileViewAfterSelection(view = 'chat') {
  if (isMobileView()) {
    setMobileView(view);
  }
}

function renderMobileLayout() {
  if (isMobileView()) {
    sidebar.classList.remove('hidden-panel');
  }
  setMobileView(isMobileView() ? mobileView : 'chat');
  mobileWorkspaceBtn.innerHTML = isMobileView() && mobileView !== 'chat' ? '&#10005;' : '&#9776;';
}

function applyTheme(theme) {
  currentTheme = theme;
  document.body.classList.toggle('light-mode', theme === 'light');
  themeToggleBtn.textContent = theme === 'light' ? '☀️' : '🌙';
  localStorage.setItem('community-theme', theme);
}

function request(url, options = {}) {
  return fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  });
}

function getCurrentServer() {
  return appState.servers.find((server) => server.id === currentServerId);
}

function getCurrentChannel() {
  const server = getCurrentServer();
  if (!server) {
    return null;
  }

  for (const category of server.categories) {
    for (const channel of category.channels) {
      if (channel.id === currentChannelId) {
        return channel;
      }
    }
  }

  return null;
}

function getServerChannels(server) {
  if (!server) {
    return [];
  }
  return server.categories.flatMap((category) => category.channels.map((channel) => ({ ...channel, categoryName: category.name })));
}

function getFirstTextChannel(server = getCurrentServer()) {
  return getServerChannels(server).find((channel) => channel.kind === 'text') || null;
}

function getFirstVoiceChannel(server = getCurrentServer()) {
  return getServerChannels(server).find((channel) => channel.kind === 'voice') || null;
}

function channelPrefix(channel) {
  return channel?.kind === 'voice' ? 'Voice' : '#';
}

function channelDisplayName(channel) {
  return channel ? `${channelPrefix(channel)} ${channel.name}` : 'Kanal';
}

function formatPresenceLabel(status) {
  const labels = {
    online: 'Cevrimici',
    away: 'Uzakta',
    busy: 'Rahatsiz etme',
    offline: 'Cevrimdisi'
  };
  return labels[status] || status;
}

function getLastDmMessage(username) {
  const messages = appState.directMessages[username] || [];
  return messages[messages.length - 1] || null;
}

function getCurrentVoiceMembers() {
  return appState.voicePresence[currentVoiceChannelId] || [];
}

function getChannelById(channelId, server = getCurrentServer()) {
  return getServerChannels(server).find((channel) => channel.id === channelId) || null;
}

function getCallChannel() {
  const currentChannel = getCurrentChannel();
  if (currentChannel?.kind === 'voice') {
    return currentChannel;
  }
  if (currentVoiceChannelId) {
    return getChannelById(currentVoiceChannelId);
  }
  return null;
}

function getCurrentCallMembers() {
  const callChannelId = activeCallChannelId || currentVoiceChannelId || currentChannelId;
  return appState.callPresence[callChannelId] || [];
}

function isDmConversation() {
  return activeConversationType === 'dm' && Boolean(activeDmUser);
}

function getActiveConversationMessages() {
  if (isDmConversation()) {
    return appState.directMessages[activeDmUser] || [];
  }
  const channel = getCurrentChannel();
  return channel ? (appState.messages[channel.id] || []) : [];
}

function dmScopeKey(username) {
  return `dm:${[currentUser, username].sort().join('__')}`;
}

function showToast(message) {
  helperText.textContent = message;
}

function isSecureMediaContext() {
  return window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
}

function explainMediaError(error) {
  if (!isSecureMediaContext()) {
    return 'Goruntulu konusma icin guvenli baglanti gerekli. Bu ozelligi localhost veya HTTPS adresinde ac.';
  }

  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Tarayici kamera veya mikrofon iznini engelledi. Adres cubugundan izin verip tekrar dene.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Kamera veya mikrofon bulunamadi.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Kamera veya mikrofon baska bir uygulama tarafindan kullaniliyor olabilir.';
  }
  return 'Goruntulu konusma baslatilamadi.';
}

function playVideoElement(element, muted = false) {
  if (!element) {
    return;
  }
  element.muted = muted;
  const tryPlay = () => {
    element.play?.().catch(() => {});
  };
  element.onloadedmetadata = tryPlay;
  tryPlay();
}

async function ensureNotificationsEnabled() {
  if (!('Notification' in window)) {
    return false;
  }

  if (Notification.permission === 'granted') {
    notificationsEnabled = true;
    return true;
  }

  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    notificationsEnabled = permission === 'granted';
    return notificationsEnabled;
  }

  return false;
}

function showBrowserNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  try {
    const notification = new Notification(title, { body });
    setTimeout(() => notification.close(), 4000);
  } catch {
    // Ignore notification errors in unsupported browser contexts.
  }
}

function playNotificationSound() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.04, audioContext.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.16);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.18);
  } catch {
    // Browser may block audio until user interaction.
  }
}

function showModal(html) {
  modal.innerHTML = html;
  modalOverlay.classList.remove('hidden');
}

function hideModal() {
  modalOverlay.classList.add('hidden');
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDateLabel(timestamp) {
  return new Date(timestamp).toLocaleDateString('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeUsernameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function formatLastSeen(timestamp) {
  if (!timestamp) {
    return 'az once';
  }

  const diff = Date.now() - timestamp;
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) {
    return `${minutes} dk once`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} sa once`;
  }

  const days = Math.round(hours / 24);
  return `${days} gun once`;
}

function findUserByMention(rawUsername) {
  const normalized = normalizeUsernameKey(rawUsername);
  return appState.users.find((user) => normalizeUsernameKey(user.username) === normalized) || null;
}

function messageMentionsUser(text, username = currentUser) {
  const normalized = normalizeUsernameKey(username);
  if (!normalized) {
    return false;
  }

  const matches = String(text || '').matchAll(/@([\p{L}\p{N}_.-]{3,24})/gu);
  for (const match of matches) {
    if (normalizeUsernameKey(match[1]) === normalized) {
      return true;
    }
  }
  return false;
}

function renderMessageText(text) {
  const source = String(text || '');
  let html = '';
  let lastIndex = 0;

  for (const match of source.matchAll(/@([\p{L}\p{N}_.-]{3,24})/gu)) {
    const [fullMatch, candidate] = match;
    const matchIndex = match.index ?? 0;
    html += escapeHtml(source.slice(lastIndex, matchIndex));
    const matchedUser = findUserByMention(candidate);
    if (matchedUser) {
      const isCurrent = normalizeUsernameKey(matchedUser.username) === normalizeUsernameKey(currentUser);
      html += `<span class="mention-pill ${isCurrent ? 'current' : ''}">@${escapeHtml(matchedUser.username)}</span>`;
    } else {
      html += escapeHtml(fullMatch);
    }
    lastIndex = matchIndex + fullMatch.length;
  }

  html += escapeHtml(source.slice(lastIndex));
  return html;
}

function setReplyTarget(message) {
  if (!message) {
    return;
  }

  replyTarget = {
    id: message.id,
    user: message.user,
    text: message.text
  };
  renderReplyComposer();
  messageInput.focus();
}

function clearReplyTarget() {
  replyTarget = null;
  renderReplyComposer();
}

function renderReplyComposer() {
  if (!replyPreview) {
    return;
  }

  if (!replyTarget) {
    replyPreview.classList.add('hidden');
    replyPreview.innerHTML = '';
    return;
  }

  replyPreview.classList.remove('hidden');
  replyPreview.innerHTML = `
    <div class="reply-preview-copy">
      <strong>${escapeHtml(replyTarget.user)} kullanicisini yanitliyorsun</strong>
      <span>${escapeHtml(replyTarget.text)}</span>
    </div>
    <button type="button" id="cancelReplyBtn" class="mini-action-btn">Vazgec</button>
  `;

  document.getElementById('cancelReplyBtn').onclick = clearReplyTarget;
}

function replyMarkup(message) {
  if (!message.replyTo) {
    return '';
  }

  return `
    <button class="reply-reference" data-reply-origin="${message.replyTo.id}">
      <span class="reply-reference-author">${escapeHtml(message.replyTo.user)}</span>
      <span class="reply-reference-text">${escapeHtml(message.replyTo.text)}</span>
    </button>
  `;
}

function isImageAttachment(attachment) {
  return String(attachment?.type || '').startsWith('image/');
}

function attachmentMarkup(attachment) {
  if (!attachment?.dataUrl) {
    return '';
  }

  if (isImageAttachment(attachment)) {
    return `
      <a class="attachment-card image" href="${attachment.dataUrl}" download="${escapeHtml(attachment.name || 'image')}">
        <img src="${attachment.dataUrl}" alt="${escapeHtml(attachment.name || 'attachment')}" />
        <span>${escapeHtml(attachment.name || 'Gorsel')}</span>
      </a>
    `;
  }

  return `
    <a class="attachment-card" href="${attachment.dataUrl}" download="${escapeHtml(attachment.name || 'dosya')}">
      <strong>${escapeHtml(attachment.name || 'Dosya')}</strong>
      <span>${escapeHtml(attachment.type || 'file')}</span>
    </a>
  `;
}

function renderAttachmentPreview() {
  if (!attachmentPreview) {
    return;
  }

  if (!pendingAttachments.length) {
    attachmentPreview.classList.add('hidden');
    attachmentPreview.innerHTML = '';
    return;
  }

  attachmentPreview.classList.remove('hidden');
  attachmentPreview.innerHTML = pendingAttachments.map((attachment, index) => `
    <div class="attachment-pill">
      <span>${escapeHtml(attachment.name)}</span>
      <button type="button" class="tiny-action" data-attachment-remove="${index}">Sil</button>
    </div>
  `).join('');

  attachmentPreview.querySelectorAll('[data-attachment-remove]').forEach((button) => {
    button.onclick = () => {
      pendingAttachments = pendingAttachments.filter((_, idx) => String(idx) !== button.dataset.attachmentRemove);
      renderAttachmentPreview();
    };
  });
}

function clearPendingAttachments() {
  pendingAttachments = [];
  if (attachmentInput) {
    attachmentInput.value = '';
  }
  renderAttachmentPreview();
}

async function loadAttachmentFiles(files) {
  const selectedFiles = [...(files || [])].slice(0, 3 - pendingAttachments.length);
  const loaded = [];

  for (const file of selectedFiles) {
    if (file.size > 2_000_000) {
      showToast(`${file.name} 2 MB sinirini asiyor.`);
      continue;
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`${file.name} okunamadi.`));
      reader.readAsDataURL(file);
    });

    loaded.push({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl
    });
  }

  pendingAttachments = [...pendingAttachments, ...loaded].slice(0, 3);
  renderAttachmentPreview();
}

function userInitials(username) {
  return (username || '?').trim().slice(0, 1).toUpperCase();
}

function getUserRecord(username) {
  return appState.users.find((user) => user.username === username) || null;
}

function avatarMarkup(username, className = 'message-avatar') {
  const user = getUserRecord(username);
  if (user?.avatar) {
    return `<img class="${className} avatar-image" src="${user.avatar}" alt="${escapeHtml(username)}" />`;
  }
  return `<div class="${className}">${userInitials(username)}</div>`;
}

function myRole() {
  const server = getCurrentServer();
  return server?.members.find((member) => member.username === currentUser)?.role || 'member';
}

function canManageMessage(message) {
  return message.user === currentUser || ['admin', 'mod'].includes(myRole());
}

function roleBadgeMarkup(username) {
  const server = getCurrentServer();
  const role = server?.members.find((member) => member.username === username)?.role || 'member';
  return `<span class="role-badge ${role}">${escapeHtml(role)}</span>`;
}

function getPinnedMessage() {
  const list = getActiveConversationMessages();
  const pinnedSource = list.find((message) => message.user === 'admin' || message.user === 'system' || message.user === 'bot') || list[0];
  if (!pinnedSource) {
    return 'Bu alanda sabitlenecek onemli mesaj henuz yok.';
  }
  return pinnedSource.text;
}

function wsProtocol() {
  return location.protocol === 'https:' ? 'wss' : 'ws';
}

function getActiveSignalChannelId() {
  return activeCallChannelId || getCallChannel()?.id || currentVoiceChannelId || currentChannelId;
}

function closePeerConnection(username) {
  const pc = peerConnections.get(username);
  if (pc) {
    pc.close();
  }
  peerConnections.delete(username);
  remoteStreams.delete(username);
  makingOffer.delete(username);
  ignoredOffer.delete(username);
}

function cleanupCallUi() {
  remoteStreams.clear();
  [...peerConnections.keys()].forEach(closePeerConnection);
  micEnabled = true;
  cameraEnabled = true;
  lastCallCapabilityMessage = '';
  focusedCallTileKey = 'self';
  renderVideoPanel();
}

function isPolitePeer(peerUsername) {
  return normalizeUsernameKey(currentUser) > normalizeUsernameKey(peerUsername);
}

function bindStreamState(stream, onChange) {
  if (!stream?.getTracks) {
    return;
  }
  stream.getTracks().forEach((track) => {
    track.onended = onChange;
    track.onmute = onChange;
    track.onunmute = onChange;
  });
}

function getActiveTrack(stream, kind) {
  const tracks = kind === 'video'
    ? (stream?.getVideoTracks?.() || [])
    : (stream?.getAudioTracks?.() || []);
  return tracks.find((track) => track.readyState !== 'ended') || null;
}

function streamHasVideo(stream, isSelf = false) {
  const track = getActiveTrack(stream, 'video');
  if (!track) {
    return false;
  }
  return isSelf ? (track.enabled && cameraEnabled) : !track.muted;
}

function streamHasAudio(stream, isSelf = false) {
  const track = getActiveTrack(stream, 'audio');
  if (!track) {
    return false;
  }
  return isSelf ? (track.enabled && micEnabled) : !track.muted;
}

function callAvatarMarkup(username, className = 'call-avatar') {
  const user = getUserRecord(username);
  if (user?.avatar) {
    return `<div class="${className}"><img src="${user.avatar}" alt="${escapeHtml(username)}" /></div>`;
  }
  return `<div class="${className}">${escapeHtml(userInitials(username))}</div>`;
}

function getCallTiles() {
  const callMembers = [...new Set(getCurrentCallMembers())];
  const tiles = [];
  const includeSelf = Boolean(localStream || activeCallChannelId || callMembers.includes(currentUser));

  callMembers
    .filter((username) => normalizeUsernameKey(username) !== normalizeUsernameKey(currentUser))
    .forEach((username) => {
      const stream = remoteStreams.get(username) || null;
      tiles.push({
        key: username,
        username,
        isSelf: false,
        stream,
        hasVideo: streamHasVideo(stream),
        hasAudio: streamHasAudio(stream)
      });
    });

  for (const [username, stream] of remoteStreams.entries()) {
    if (!tiles.some((tile) => tile.key === username)) {
      tiles.push({
        key: username,
        username,
        isSelf: false,
        stream,
        hasVideo: streamHasVideo(stream),
        hasAudio: streamHasAudio(stream)
      });
    }
  }

  if (includeSelf) {
    tiles.push({
      key: 'self',
      username: currentUser,
      isSelf: true,
      stream: localStream,
      hasVideo: streamHasVideo(localStream, true),
      hasAudio: streamHasAudio(localStream, true)
    });
  }

  return tiles;
}

function getPreferredStageTile(tiles) {
  if (!tiles.length) {
    focusedCallTileKey = 'self';
    return null;
  }

  const focused = tiles.find((tile) => tile.key === focusedCallTileKey);
  if (focused) {
    return focused;
  }

  const fallback = tiles.find((tile) => !tile.isSelf && tile.hasVideo)
    || tiles.find((tile) => !tile.isSelf)
    || tiles.find((tile) => tile.isSelf)
    || tiles[0];
  focusedCallTileKey = fallback.key;
  return fallback;
}

function callStatusText(tile) {
  if (!tile?.stream) {
    return tile?.isSelf ? 'Kamera ve mikrofon baglaniyor.' : 'Karsi tarafin kamerasi henuz gelmedi.';
  }
  if (tile.hasVideo && tile.hasAudio) {
    return 'Ses ve kamera acik.';
  }
  if (tile.hasVideo) {
    return 'Kamera acik, mikrofon kapali.';
  }
  if (tile.hasAudio) {
    return 'Sadece ses acik.';
  }
  return 'Mikrofon ve kamera kapali.';
}

function attachRenderedVideo(id, stream, muted = false) {
  const element = document.getElementById(id);
  if (!element || !stream) {
    return;
  }
  element.srcObject = stream;
  playVideoElement(element, muted);
}

async function tuneLocalMediaTracks(stream) {
  const videoTrack = getActiveTrack(stream, 'video');
  const audioTrack = getActiveTrack(stream, 'audio');

  if (videoTrack) {
    videoTrack.contentHint = 'detail';
    try {
      await videoTrack.applyConstraints({
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 }
      });
    } catch {
      // Browsers may reject some ideal values; keep the acquired track.
    }
  }

  if (audioTrack) {
    audioTrack.contentHint = 'speech';
  }
}

function renderCallOverlay() {
  if (!callOverlay) {
    return;
  }

  const callChannel = getCallChannel() || getFirstVoiceChannel();
  const participants = getCurrentCallMembers();
  const tiles = getCallTiles();
  const focusedTile = getPreferredStageTile(tiles);
  const hasCall = Boolean(localStream || participants.length || remoteStreams.size || activeCallChannelId);
  const hasAudioTrack = Boolean(getActiveTrack(localStream, 'audio'));
  const hasVideoTrack = Boolean(getActiveTrack(localStream, 'video'));
  const cameraOnCount = tiles.filter((tile) => tile.hasVideo).length;
  const audioOnCount = tiles.filter((tile) => tile.hasAudio).length;
  const galleryLayoutClass = tiles.length <= 1
    ? 'layout-1'
    : tiles.length === 2
      ? 'layout-2'
      : tiles.length === 3
        ? 'layout-3'
        : tiles.length === 4
          ? 'layout-4'
          : 'layout-many';

  callOverlayTitle.textContent = callChannel
    ? `# ${callChannel.name}`
    : 'Sesli Oda Sec';
  callOverlayMeta.textContent = callChannel
    ? `${Math.max(participants.length, tiles.length || 1)} katilimci • ${cameraOnCount} kamera acik • ${audioOnCount} ses acik`
    : 'Once bir sesli odaya katil, sonra kamerayi baslat.';

  callOverlayStatus.textContent = hasCall
    ? (lastCallCapabilityMessage || 'Goruntulu konusma aktif. Buyuk sahnede katilimcilari takip edebilirsin.')
    : (isSecureMediaContext()
        ? 'Henuz aktif goruntulu konusma yok. Voice kanala girip buradan cagriyi baslat.'
        : 'Bu ozellik icin HTTPS veya localhost gerekli.');

  callOverlaySummary.textContent = hasVideoTrack
    ? (cameraEnabled ? 'Kamera yayinliyor. Goruntu gelmiyorsa karsi tarafin da kamerayi acmasi ve izin vermesi gerekir.' : 'Kamera mevcut ama su an kapali.')
    : 'Yerel kamera henuz baglanmadi. Kamera izni verip tekrar dene.';

  callOverlayJoinBtn.disabled = !callChannel || currentVoiceChannelId === callChannel.id;
  callOverlayJoinBtn.textContent = callChannel && currentVoiceChannelId === callChannel.id ? 'Voice Odadasin' : 'Voice Katil';
  callOverlayStartBtn.disabled = !callChannel;
  callOverlayMicBtn.disabled = !hasAudioTrack;
  callOverlayCameraBtn.disabled = false;
  callOverlayEndBtn.disabled = !hasCall;

  callOverlayMicBtn.textContent = hasAudioTrack ? (micEnabled ? 'Mikrofon Acik' : 'Mikrofon Kapali') : 'Mikrofon Yok';
  callOverlayCameraBtn.textContent = hasVideoTrack ? (cameraEnabled ? 'Kamera Acik' : 'Kamera Kapali') : 'Kamerayi Ac';
  callOverlayMicBtn.className = `call-dock-btn ${hasAudioTrack ? (micEnabled ? 'active' : 'muted') : ''}`.trim();
  callOverlayCameraBtn.className = `call-dock-btn ${hasVideoTrack ? (cameraEnabled ? 'active' : 'muted') : 'primary'}`.trim();

  if (!focusedTile) {
    callStage.innerHTML = `
      <div class="call-stage-card placeholder">
        <div class="call-empty-big">
          <strong>Discord tarzi cagri hazir</strong>
          <p>${escapeHtml(lastCallCapabilityMessage || 'Sesli odaya katilip Goruntulu Baslat dugmesine bastiginda kamera burada buyuk sahnede acilir.')}</p>
        </div>
      </div>
    `;
    callFilmstrip.innerHTML = '';
    callOverlayMembers.innerHTML = '<div class="empty-state">Henuz katilimci yok.</div>';
    callOverlay.classList.toggle('hidden', !callOverlayOpen);
    callOverlay.setAttribute('aria-hidden', String(!callOverlayOpen));
    document.body.classList.toggle('call-open', callOverlayOpen);
    return;
  }

  callStage.innerHTML = `
    <div class="call-gallery ${galleryLayoutClass}">
      ${tiles.map((tile) => {
        const videoId = tile.hasVideo ? `callGalleryVideo_${tile.key}` : '';
        return `
          <article class="call-gallery-tile ${tile.key === focusedTile.key ? 'active' : ''}" data-call-focus="${escapeHtml(tile.key)}">
            <div class="call-gallery-media">
              ${tile.hasVideo
                ? `<video id="${videoId}" autoplay ${tile.isSelf ? 'muted' : ''} playsinline></video>`
                : `<div class="call-stage-fallback">
                    ${callAvatarMarkup(tile.username)}
                    <strong>${escapeHtml(tile.isSelf ? 'Kameran kapali' : `${tile.username} kamera acmadi`)}</strong>
                    <div>${escapeHtml(callStatusText(tile))}</div>
                  </div>`}
            </div>
            <div class="call-gallery-overlay">
              <div class="call-gallery-corner">
                <span class="call-gallery-chip ${tile.hasAudio ? '' : 'off'}">${tile.hasAudio ? 'Ses acik' : 'Mute'}</span>
                <span class="call-gallery-chip ${tile.hasVideo ? '' : 'off'}">${tile.hasVideo ? 'Kamera acik' : 'Kamera kapali'}</span>
              </div>
              <div class="call-gallery-meta">
                <div class="call-gallery-info">
                  <div class="call-gallery-name">${escapeHtml(tile.isSelf ? 'Sen' : tile.username)}</div>
                  <div class="call-gallery-copy">${escapeHtml(callStatusText(tile))}</div>
                </div>
                ${tile.key === focusedTile.key ? '<span class="call-gallery-chip">Odak</span>' : ''}
              </div>
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;

  callFilmstrip.innerHTML = `
    <span class="call-summary-chip accent">Galeri gorunumu</span>
    <span class="call-summary-chip">${tiles.length} panel acik</span>
    <span class="call-summary-chip">${cameraOnCount} kamera aktif</span>
    <span class="call-summary-chip">${audioOnCount} mikrofon aktif</span>
    ${lastCallCapabilityMessage ? `<span class="call-summary-chip">${escapeHtml(lastCallCapabilityMessage)}</span>` : ''}
  `;

  callOverlayMembers.innerHTML = tiles.map((tile) => `
    <div class="call-member-row">
      <div class="call-member-left">
        ${callAvatarMarkup(tile.username, 'call-avatar small')}
        <div class="call-member-meta">
          <div class="call-member-name">${escapeHtml(tile.isSelf ? 'Sen' : tile.username)}</div>
          <div class="call-member-subtitle">${escapeHtml(callStatusText(tile))}</div>
        </div>
      </div>
      <div class="call-member-right">
        <span class="call-badge ${tile.hasAudio ? 'on' : 'off'}">${tile.hasAudio ? 'Ses' : 'Mute'}</span>
        <span class="call-badge ${tile.hasVideo ? 'on' : 'off'}">${tile.hasVideo ? 'Cam' : 'Kapali'}</span>
      </div>
    </div>
  `).join('');

  callStage.querySelectorAll('[data-call-focus]').forEach((tile) => {
    tile.onclick = () => {
      focusedCallTileKey = tile.dataset.callFocus;
      renderCallOverlay();
    };
  });

  tiles.forEach((tile) => {
    if (tile.hasVideo && tile.stream) {
      attachRenderedVideo(`callGalleryVideo_${tile.key}`, tile.stream, tile.isSelf);
    }
  });

  callOverlay.classList.toggle('hidden', !callOverlayOpen);
  callOverlay.setAttribute('aria-hidden', String(!callOverlayOpen));
  document.body.classList.toggle('call-open', callOverlayOpen);
}

function openCallOverlay() {
  callOverlayOpen = true;
  renderCallOverlay();
}

function closeCallOverlay(options = {}) {
  callOverlayOpen = false;
  callOverlay.classList.add('hidden');
  callOverlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('call-open');
  if (options.minimized) {
    showToast('Cagri arka planda acik kaldi. Video dugmesi ile tekrar buyutebilirsin.');
  }
}

function sendRtcSignal(target, signal) {
  if (ws?.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({
    type: 'webrtcSignal',
    username: currentUser,
    target,
    channelId: getActiveSignalChannelId(),
    signal
  }));
}

function renderVideoPanel() {
  const participants = getCurrentCallMembers();
  const callChannel = getCallChannel() || getFirstVoiceChannel();
  const hasCall = Boolean(localStream || participants.length || remoteStreams.size || activeCallChannelId);
  const hasAudioTrack = Boolean(getActiveTrack(localStream, 'audio'));
  const hasVideoTrack = Boolean(getActiveTrack(localStream, 'video'));
  toggleMicBtn.textContent = hasAudioTrack ? (micEnabled ? 'Mikrofon Acik' : 'Mikrofon Kapali') : 'Mikrofon Yok';
  toggleCameraBtn.textContent = hasVideoTrack ? (cameraEnabled ? 'Kamera Acik' : 'Kamera Kapali') : 'Kamerayi Ac';
  toggleMicBtn.disabled = !hasAudioTrack;
  toggleCameraBtn.disabled = false;

  if (!hasCall) {
    const secureHint = isSecureMediaContext()
      ? 'Henuz aktif gorusme yok. Discord benzeri ekran icin ustteki video dugmesini veya buradaki paneli kullan.'
      : 'Bu adres guvenli degil. Goruntulu konusma icin localhost veya HTTPS kullan.';
    videoPanel.innerHTML = `
      <div class="empty-state">${escapeHtml(lastCallCapabilityMessage || secureHint)}</div>
      <button id="openCallOverlayInline" class="mini-action-btn">Discord Gorunumu Ac</button>
    `;
    document.getElementById('openCallOverlayInline').onclick = openCallOverlay;
    renderCallOverlay();
    return;
  }

  const cards = [];
  if (localStream) {
    cards.push(`
      <div class="video-card">
        ${streamHasVideo(localStream, true)
          ? '<video id="localVideo" autoplay muted playsinline></video>'
          : `<div class="call-film-fallback" style="height:150px;">${callAvatarMarkup(currentUser, 'call-avatar small')}</div>`}
        <div class="video-label">Sen</div>
      </div>
    `);
  }

  for (const [username, stream] of remoteStreams.entries()) {
    cards.push(`
      <div class="video-card">
        ${streamHasVideo(stream)
          ? `<video id="remoteVideo_${username}" autoplay playsinline></video>`
          : `<div class="call-film-fallback" style="height:150px;">${callAvatarMarkup(username, 'call-avatar small')}</div>`}
        <div class="video-label">${escapeHtml(username)}</div>
      </div>
    `);
  }

  if (!cards.length) {
    cards.push('<div class="empty-state">Cagri acik. Diger katilimcilari bekliyorsun.</div>');
  }

  videoPanel.innerHTML = `
    <div class="panel-subtitle">Kanal: ${escapeHtml(callChannel?.name || '-')}</div>
    <div class="panel-subtitle">Katilimcilar: ${participants.join(', ') || currentUser}</div>
    <div class="panel-subtitle">Durum: ${escapeHtml(lastCallCapabilityMessage || (hasVideoTrack ? 'Kamera akisi aktif.' : 'Su an ses veya baglanti agirlikli calisiyor.'))}</div>
    <button id="openCallOverlayInline" class="mini-action-btn">Discord Gorunumu Ac</button>
    <div class="video-grid">${cards.join('')}</div>
  `;

  document.getElementById('openCallOverlayInline').onclick = openCallOverlay;

  if (localStream && streamHasVideo(localStream, true)) {
    attachRenderedVideo('localVideo', localStream, true);
  }

  for (const [username, stream] of remoteStreams.entries()) {
    if (streamHasVideo(stream)) {
      attachRenderedVideo(`remoteVideo_${username}`, stream, false);
    }
  }

  renderCallOverlay();
}

function createPeerConnection(peerUsername) {
  if (peerConnections.has(peerUsername)) {
    return peerConnections.get(peerUsername);
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  makingOffer.set(peerUsername, false);
  ignoredOffer.set(peerUsername, false);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onnegotiationneeded = async () => {
    if (!localStream || pc.signalingState !== 'stable') {
      return;
    }
    try {
      makingOffer.set(peerUsername, true);
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') {
        return;
      }
      await pc.setLocalDescription(offer);
      sendRtcSignal(peerUsername, { type: 'offer', sdp: pc.localDescription });
    } catch {
      // Ignore transient renegotiation races in this MVP.
    } finally {
      makingOffer.set(peerUsername, false);
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendRtcSignal(peerUsername, { type: 'candidate', candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    const existingStream = remoteStreams.get(peerUsername);

    if (existingStream && existingStream.id !== stream.id) {
      if (!existingStream.getTracks().some((track) => track.id === event.track.id)) {
        existingStream.addTrack(event.track);
      }
      remoteStreams.set(peerUsername, existingStream);
    } else {
      remoteStreams.set(peerUsername, stream);
    }

    bindStreamState(remoteStreams.get(peerUsername), () => renderVideoPanel());
    renderVideoPanel();
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      closePeerConnection(peerUsername);
      renderVideoPanel();
    }
  };

  peerConnections.set(peerUsername, pc);
  return pc;
}

async function ensureLocalMedia() {
  if (localStream) {
    return localStream;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Bu tarayici kamera/mikrofon erisimini desteklemiyor.');
  }

  if (!isSecureMediaContext()) {
    throw new Error('Goruntulu konusma icin guvenli baglanti gerekli. localhost veya HTTPS kullan.');
  }

  const videoConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: 'user'
  };
  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
  const attempts = [
    { video: videoConstraints, audio: audioConstraints, label: '' },
    { video: videoConstraints, audio: false, label: 'Mikrofon izni olmadigi icin sadece kamera acildi.' },
    { video: false, audio: audioConstraints, label: 'Kamera izni olmadigi icin sadece mikrofon acildi.' }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(attempt);
      await tuneLocalMediaTracks(localStream);
      micEnabled = Boolean(localStream.getAudioTracks().length);
      cameraEnabled = Boolean(localStream.getVideoTracks().length);
      lastCallCapabilityMessage = attempt.label;
      bindStreamState(localStream, () => renderVideoPanel());
      renderVideoPanel();
      return localStream;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Kamera veya mikrofon acilamadi.');
}

async function ensureVideoTrack() {
  if (!localStream) {
    await ensureLocalMedia();
  }

  if (getActiveTrack(localStream, 'video')) {
    localStream.getVideoTracks().forEach((track) => {
      track.enabled = true;
    });
    cameraEnabled = true;
    renderVideoPanel();
    return localStream;
  }

  const cameraStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user'
    }
  });
  const [videoTrack] = cameraStream.getVideoTracks();
  if (!videoTrack) {
    throw new Error('Kamera acilamadi.');
  }

  localStream.addTrack(videoTrack);
  cameraEnabled = true;
  tuneLocalMediaTracks(localStream).catch(() => {});
  bindStreamState(localStream, () => renderVideoPanel());

  for (const pc of peerConnections.values()) {
    const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
    if (sender) {
      sender.replaceTrack(videoTrack).catch(() => {});
    } else {
      pc.addTrack(videoTrack, localStream);
    }
  }

  renderVideoPanel();
  return localStream;
}

async function initiateOffer(peerUsername) {
  const pc = createPeerConnection(peerUsername);
  if (pc.signalingState !== 'stable') {
    return;
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendRtcSignal(peerUsername, { type: 'offer', sdp: pc.localDescription });
}

async function handleIncomingSignal(data) {
  const { from, signal } = data;
  if (data.channelId) {
    activeCallChannelId = data.channelId;
  }

  try {
    await ensureLocalMedia();
  } catch (error) {
    showToast(explainMediaError(error));
    return;
  }

  const pc = createPeerConnection(from);

  if (signal.type === 'offer' || signal.type === 'answer') {
    const description = new RTCSessionDescription(signal.sdp);
    const offerCollision = description.type === 'offer'
      && (makingOffer.get(from) || pc.signalingState !== 'stable');
    const shouldIgnoreOffer = !isPolitePeer(from) && offerCollision;
    ignoredOffer.set(from, shouldIgnoreOffer);

    if (shouldIgnoreOffer) {
      return;
    }

    await pc.setRemoteDescription(description);

    if (description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendRtcSignal(from, { type: 'answer', sdp: pc.localDescription });
    }
    renderVideoPanel();
    return;
  }

  if (signal.type === 'candidate' && signal.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (error) {
      if (!ignoredOffer.get(from)) {
        throw error;
      }
    }
  }
}

function renderServers() {
  serverList.innerHTML = '';
  appState.servers.forEach((server) => {
    const button = document.createElement('button');
    button.className = `server-pill ${server.id === currentServerId ? 'active' : ''}`;
    button.textContent = server.name.slice(0, 2).toUpperCase();
    button.title = server.name;
    button.onclick = () => switchServer(server.id);
    serverList.appendChild(button);
  });
}

function renderChannels() {
  const server = getCurrentServer();
  channelTree.innerHTML = '';

  if (!server) {
    return;
  }

  server.categories.forEach((category) => {
    const group = document.createElement('div');
    group.className = 'channel-group';

    const title = document.createElement('div');
    title.className = 'channel-group-title';
    title.textContent = category.name;
    group.appendChild(title);

    category.channels.forEach((channel) => {
      const item = document.createElement('button');
      item.className = `channel-item ${channel.id === currentChannelId ? 'active' : ''}`;
      item.innerHTML = `<span>${channel.kind === 'voice' ? '🔊' : '#'}</span><span>${channel.name}</span>`;
      item.onclick = () => switchChannel(channel.id);
      group.appendChild(item);
    });

    channelTree.appendChild(group);
  });
}

function renderHeader() {
  const server = getCurrentServer();
  const channel = getCurrentChannel();
  if (!server || !channel) {
    return;
  }

  currentLocation.textContent = isDmConversation()
    ? `DM / ${activeDmUser}`
    : `${channel.kind === 'voice' ? '🔊' : '#'} ${channel.name}`;
  const me = server.members.find((member) => member.username === currentUser);
  userBadge.textContent = `${currentUser} (${me?.role || 'member'})`;
  serverInfoName.textContent = server.name;
  mobileContextTag.textContent = isDmConversation() ? `${server.name} • DM` : server.name;
  mobileChannelsSummary.textContent = `${server.name} icindeki kanallar ve odalar`;
  mobileWorkspaceBtn.title = isDmConversation() ? 'DM listesine don' : 'Kanallari ac';
  helperText.textContent = isDmConversation()
    ? 'Direkt mesajlasma alani'
    : (channel.kind === 'voice' ? 'Sesli oda kanali' : 'Topluluk metin kanali');
  pinnedMessageText.textContent = getPinnedMessage();
}

function renderComposerState() {
  const channel = getCurrentChannel();
  renderReplyComposer();
  renderAttachmentPreview();
  if (isDmConversation()) {
    messageInput.placeholder = `${activeDmUser} kullanicisina mesaj gonder`;
    sendBtn.textContent = 'Gonder';
    messageInput.disabled = false;
    sendBtn.disabled = false;
    return;
  }

  if (channel?.kind === 'voice') {
    messageInput.placeholder = 'Sesli odada yazi yerine katil veya gorusme baslat';
    sendBtn.textContent = 'Ses';
    messageInput.disabled = true;
    sendBtn.disabled = true;
    return;
  }

  messageInput.placeholder = `${channel?.name || 'kanal'} kanalina mesaj gonder`;
  sendBtn.textContent = 'Gonder';
  messageInput.disabled = false;
  sendBtn.disabled = false;
}

function renderMessages() {
  chatArea.innerHTML = '';
  const list = getActiveConversationMessages();
  if (!list.length) {
    const channel = getCurrentChannel();
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.innerHTML = `
      <strong>${escapeHtml(isDmConversation() ? `${activeDmUser} ile DM` : `${channel?.name || 'kanal'} alanina hos geldin`)}</strong>
      <div>${escapeHtml(isDmConversation() ? 'Bu ozel konusmada henuz mesaj yok. Ilk mesaji gondererek akisi baslatabilirsin.' : 'Bu kanalda henuz mesaj yok. Toplulugu baslatmak icin ilk mesaji sen gonderebilirsin.')}</div>
    `;
    chatArea.appendChild(empty);
    return;
  }

  let lastDateKey = '';
  const isDmThread = isDmConversation();
  list.forEach((message) => {
    message.replyTo = message.replyTo || null;
    const messageDateKey = new Date(message.time).toDateString();
    if (messageDateKey !== lastDateKey) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.textContent = formatDateLabel(message.time);
      chatArea.appendChild(divider);
      lastDateKey = messageDateKey;
    }

    const row = document.createElement('div');
    row.className = `message-row ${isDmThread ? `dm-thread ${message.user === currentUser ? 'mine' : 'theirs'}` : ''}`;
    const reactions = isDmThread
      ? ''
      : Object.entries(message.reactions || {})
          .map(([emoji, users]) => {
            const active = users.includes(currentUser) ? 'active' : '';
            return `<button class="reaction-chip ${active}" data-message-id="${message.id}" data-emoji="${emoji}">${emoji} ${users.length}</button>`;
          })
          .join('');
    const canEditOrDelete = isDmThread ? message.user === currentUser : canManageMessage(message);
    const controls = `
      <div class="message-controls">
        <button class="tiny-action" data-action="reply" data-message-id="${message.id}">Yanitla</button>
        ${canEditOrDelete ? `
          <button class="tiny-action" data-action="edit" data-message-id="${message.id}">Duzenle</button>
          <button class="tiny-action danger" data-action="delete" data-message-id="${message.id}">Sil</button>
        ` : ''}
      </div>
    `;
    row.innerHTML = `
      ${avatarMarkup(message.user)}
      <div class="message-content">
        <div class="message-meta">
          <span class="message-author">${escapeHtml(message.user)}</span>
          ${!isDmThread ? roleBadgeMarkup(message.user) : ''}
          <span>${formatTime(message.time)}</span>
          ${message.editedAt ? '<span>(duzenlendi)</span>' : ''}
          ${isDmConversation() && message.user === currentUser && activeDmUser
            ? `<span>${(message.seenBy || []).includes(activeDmUser) ? 'goruldu' : 'gonderildi'}</span>`
            : ''}
        </div>
        <div class="message-stack">
          ${replyMarkup(message)}
          ${message.text ? `<div class="message-body ${messageMentionsUser(message.text) ? 'mentioned' : ''}">${renderMessageText(message.text)}</div>` : ''}
          ${(message.attachments || []).length ? `<div class="attachments-row">${(message.attachments || []).map(attachmentMarkup).join('')}</div>` : ''}
          <div class="reactions-row">${reactions}</div>
          <div class="message-actions-row">
            <div class="reaction-palette">
              <button class="emoji-btn" data-message-id="${message.id}" data-emoji="👍">👍</button>
              <button class="emoji-btn" data-message-id="${message.id}" data-emoji="❤️">❤️</button>
              <button class="emoji-btn" data-message-id="${message.id}" data-emoji="😂">😂</button>
              <button class="emoji-btn" data-message-id="${message.id}" data-emoji="😮">😮</button>
              <button class="emoji-btn" data-message-id="${message.id}" data-emoji="👏">👏</button>
            </div>
            ${controls}
          </div>
        </div>
      </div>
    `;
    chatArea.appendChild(row);
  });

  if (!isDmThread) {
    chatArea.querySelectorAll('.emoji-btn').forEach((button) => {
      button.onclick = () => {
        ws.send(JSON.stringify({
          type: 'react',
          serverId: currentServerId,
          channelId: currentChannelId,
          username: currentUser,
          messageId: button.dataset.messageId,
          emoji: button.dataset.emoji
        }));
      };
    });

    chatArea.querySelectorAll('.reaction-chip').forEach((button) => {
      button.onclick = () => {
        ws.send(JSON.stringify({
          type: 'react',
          serverId: currentServerId,
          channelId: currentChannelId,
          username: currentUser,
          messageId: button.dataset.messageId,
          emoji: button.dataset.emoji
        }));
      };
    });

  }

  chatArea.querySelectorAll('.tiny-action').forEach((button) => {
    button.onclick = () => {
      const messageId = button.dataset.messageId;
      const action = button.dataset.action;
      const listSource = isDmThread ? (appState.directMessages[activeDmUser] || []) : (appState.messages[currentChannelId] || []);
      const targetMessage = listSource.find((message) => message.id === messageId);
      if (action === 'reply') {
        setReplyTarget(targetMessage);
        return;
      }
      if (action === 'delete') {
        ws.send(JSON.stringify(isDmThread
          ? {
              type: 'deleteDmMessage',
              username: currentUser,
              peerUsername: activeDmUser,
              messageId
            }
          : {
              type: 'deleteMessage',
              serverId: currentServerId,
              channelId: currentChannelId,
              username: currentUser,
              messageId
            }));
        return;
      }

      const nextText = prompt('Mesaji duzenle:', targetMessage?.text || '');
      if (nextText && nextText.trim()) {
        ws.send(JSON.stringify(isDmThread
          ? {
              type: 'editDmMessage',
              username: currentUser,
              peerUsername: activeDmUser,
              messageId,
              text: nextText.trim()
            }
          : {
              type: 'editMessage',
              serverId: currentServerId,
              channelId: currentChannelId,
              username: currentUser,
              messageId,
              text: nextText.trim()
            }));
      }
    };
  });

  chatArea.querySelectorAll('[data-reply-origin]').forEach((button) => {
    button.onclick = () => {
      const listSource = isDmThread ? (appState.directMessages[activeDmUser] || []) : (appState.messages[currentChannelId] || []);
      const originMessage = listSource.find((message) => message.id === button.dataset.replyOrigin);
      if (originMessage) {
        setReplyTarget(originMessage);
      }
    };
  });

  chatArea.scrollTop = chatArea.scrollHeight;
}

function renderMembers() {
  const server = getCurrentServer();
  memberList.innerHTML = '';
  if (!server) {
    return;
  }

  const sortedMembers = [...server.members].sort((a, b) => {
    const presenceOrder = { online: 0, away: 1, busy: 2, offline: 3 };
    const aPresence = appState.presence[a.username]?.status || 'offline';
    const bPresence = appState.presence[b.username]?.status || 'offline';
    const diff = (presenceOrder[aPresence] ?? 4) - (presenceOrder[bPresence] ?? 4);
    if (diff !== 0) {
      return diff;
    }
    return a.username.localeCompare(b.username, 'tr');
  });

  const activeCount = sortedMembers.filter((member) => (appState.presence[member.username]?.status || 'offline') !== 'offline').length;
  membersPanelTitle.textContent = 'Uyeler';
  membersPanelSubtitle.textContent = `${activeCount} aktif, ${sortedMembers.length} toplam uye`;
  membersCountPill.textContent = String(sortedMembers.length);

  sortedMembers.forEach((member) => {
    const presence = appState.presence[member.username]?.status || 'offline';
    const lastSeenAt = appState.presence[member.username]?.lastSeenAt || null;
    const item = document.createElement('div');
    item.className = 'member-row';
    item.innerHTML = `
      <div style="display:flex; gap:10px; align-items:center;">
        ${avatarMarkup(member.username, 'member-avatar')}
        <div>
          <div class="member-name">${member.username}</div>
          <div class="member-role">${member.role.toUpperCase()}${presence === 'offline' && lastSeenAt ? ` • Son gorulme ${formatLastSeen(lastSeenAt)}` : ''}</div>
        </div>
      </div>
      <div class="member-actions">
        <span class="presence ${presence}">${presence}</span>
        <button class="mini-action-btn member-profile-btn" data-username="${member.username}">Profil</button>
      </div>
    `;
    item.onclick = () => showUserProfile(member.username);
    memberList.appendChild(item);
  });

  memberList.querySelectorAll('.member-profile-btn').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      showUserProfile(button.dataset.username);
    };
  });
}

function renderDmList() {
  dmList.innerHTML = '';
  const users = appState.users
    .filter((user) => user.username !== currentUser)
    .sort((a, b) => {
      const aLast = getLastDmMessage(a.username)?.time || 0;
      const bLast = getLastDmMessage(b.username)?.time || 0;
      if (aLast !== bLast) {
        return bLast - aLast;
      }
      return a.username.localeCompare(b.username, 'tr');
    });
  membersPanelTitle.textContent = 'DM';
  membersPanelSubtitle.textContent = `${users.length} kullanici ile direkt mesaj`;
  membersCountPill.textContent = String(users.length);
  dmList.innerHTML = users.map((user) => `
    ${(() => {
      const presence = appState.presence[user.username]?.status || 'offline';
      const lastMessage = getLastDmMessage(user.username);
      const preview = lastMessage
        ? `${lastMessage.user === currentUser ? 'Sen: ' : ''}${lastMessage.text}`
        : 'Henuz direkt mesaj yok';
      return `
    <div class="dm-row">
      <button class="dm-user ${activeDmUser === user.username ? 'active' : ''}" data-username="${user.username}">
        <span class="dm-user-top">
          <strong>${escapeHtml(user.username)}</strong>
          <span style="display:flex; gap:8px; align-items:center;">
            ${unreadDmCounts[user.username] ? `<span class="badge-dot">${unreadDmCounts[user.username]}</span>` : ''}
            <span class="presence ${presence}">${presence}</span>
          </span>
        </span>
        <span class="dm-user-bottom">
          <span class="dm-preview">${escapeHtml(preview)}</span>
          <span class="report-meta">${lastMessage ? formatTime(lastMessage.time) : ''}</span>
        </span>
      </button>
      <button class="mini-action-btn dm-profile-btn" data-username="${user.username}">Profil</button>
    </div>
      `;
    })()}
  `).join('');

  dmList.querySelectorAll('.dm-user').forEach((button) => {
    button.onclick = () => openDm(button.dataset.username);
    button.oncontextmenu = (event) => {
      event.preventDefault();
      showUserProfile(button.dataset.username);
    };
  });

  dmList.querySelectorAll('.dm-profile-btn').forEach((button) => {
    button.onclick = () => showUserProfile(button.dataset.username);
  });
}

function showUserProfile(username) {
  const server = getCurrentServer();
  const member = server?.members.find((item) => item.username === username);
  const user = appState.users.find((item) => item.username === username);
  const presence = appState.presence[username]?.status || user?.status || 'offline';
  const lastSeenAt = appState.presence[username]?.lastSeenAt || user?.lastSeenAt || null;
  const dmCount = (appState.directMessages[username] || []).length;
  const voiceEntry = Object.entries(appState.voicePresence).find(([, users]) => users.includes(username));
  const voiceChannel = server?.categories.flatMap((category) => category.channels).find((channel) => channel.id === voiceEntry?.[0]);

  showModal(`
    <h2>Kullanici Profili</h2>
    <div style="display:flex; justify-content:center; margin-bottom:4px;">${avatarMarkup(username, 'profile-avatar')}</div>
    <div class="report-card">
      <div><strong>${escapeHtml(username)}</strong></div>
      <div class="report-meta">Durum: ${escapeHtml(presence)}</div>
      <div class="report-meta">${presence === 'offline' && lastSeenAt ? `Son gorulme: ${formatLastSeen(lastSeenAt)}` : 'Su anda aktif gorunuyor.'}</div>
      <div class="report-meta">Rol: ${escapeHtml((member?.role || 'member').toUpperCase())}</div>
      <div class="report-meta">DM sayisi: ${dmCount}</div>
      <div class="report-meta">Sesli oda: ${escapeHtml(voiceChannel?.name || 'yok')}</div>
    </div>
    ${username === currentUser ? `
      <input id="avatarFileInput" type="file" accept="image/*" class="modal-input" />
      <button id="saveAvatarBtn" class="modal-btn secondary">Profil Fotosu Yukle</button>
    ` : ''}
    <button id="profileDmBtn" class="modal-btn primary">DM Ac</button>
  `);

  document.getElementById('profileDmBtn').onclick = () => {
    hideModal();
    openDm(username);
  };

  if (username === currentUser) {
    document.getElementById('saveAvatarBtn').onclick = async () => {
      const file = document.getElementById('avatarFileInput').files?.[0];
      if (!file) {
        alert('Lutfen bir gorsel sec.');
        return;
      }

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await request(API.avatar, {
            method: 'POST',
            body: JSON.stringify({
              username: currentUser,
              avatar: reader.result
            })
          });
          const targetUser = getUserRecord(currentUser);
          if (targetUser) {
            targetUser.avatar = reader.result;
          }
          hideModal();
          renderAll();
          showToast('Profil fotosu guncellendi.');
        } catch (error) {
          alert(error.message);
        }
      };
      reader.readAsDataURL(file);
    };
  }
}

function renderSidebarTab() {
  const isDm = activeSidebarTab === 'dm';
  membersTabBtn.classList.toggle('active', !isDm);
  dmTabBtn.classList.toggle('active', isDm);
  memberList.classList.toggle('hidden', isDm);
  dmList.classList.toggle('hidden', !isDm);
  mobilePeopleSummary.textContent = isDm
    ? 'Direkt mesaj kisilerini ac ve sohbete don.'
    : 'Sunucudaki uyeleri incele veya profilden DM baslat.';
  renderDmList();
}

function renderVoicePanel() {
  const channel = getCurrentChannel();
  const server = getCurrentServer();
  const voiceMembers = getCurrentVoiceMembers();
  const activeVoiceChannel =
    server?.categories.flatMap((category) => category.channels).find((item) => item.id === currentVoiceChannelId) || null;

  const targetChannel = channel?.kind === 'voice' ? channel : activeVoiceChannel;
  const title = targetChannel ? targetChannel.name : 'voice-lounge';
  const list = targetChannel ? appState.voicePresence[targetChannel.id] || [] : voiceMembers;

  voicePanel.innerHTML = `
    <div class="panel-title">Voice Room</div>
    <div class="voice-name">${title}</div>
    <div class="voice-subtitle">Join/leave simulasyonu ve anlik presence</div>
    <div class="voice-members">
      ${(list.length ? list : ['Kimse odada degil.'])
        .map((username) => `<div class="voice-member">${username}</div>`)
        .join('')}
    </div>
  `;
}

function renderReports() {
  const server = getCurrentServer();
  reportList.innerHTML = '';
  if (!server) {
    return;
  }

  const reports = server.reports.slice(0, 5);
  reportList.innerHTML = reports.length
    ? reports
        .map(
          (report) => `
            <div class="report-card">
              <div><strong>${report.targetUser}</strong> icin rapor</div>
              <div>${report.reason}</div>
              <div class="report-meta">${report.reporter} • ${formatTime(report.time)} • ${report.status}</div>
            </div>
          `
        )
        .join('')
    : '<div class="empty-state">Henuz rapor yok.</div>';
}

function renderPolls() {
  const server = getCurrentServer();
  pollList.innerHTML = '';
  if (!server) {
    return;
  }

  const polls = server.polls.slice(0, 4);
  pollList.innerHTML = polls.length
    ? polls
        .map(
          (poll) => `
            <div class="poll-card">
              <div><strong>${poll.question}</strong></div>
              <div>${poll.options.map((option) => option.label).join(' / ')}</div>
              <div class="report-meta">${poll.createdBy} • ${formatTime(poll.time)}</div>
            </div>
          `
        )
        .join('')
    : '<div class="empty-state">/poll komutuyla anket olustur.</div>';
}

function renderPermissions() {
  const server = getCurrentServer();
  permissionsList.innerHTML = '';
  if (!server) {
    return;
  }

  const rows = server.categories
    .flatMap((category) => category.channels.map((channel) => ({ category: category.name, channel })));

  permissionsList.innerHTML = rows.length
    ? rows
        .map(
          ({ category, channel }) => `
            <div class="permission-card">
              <div><strong>${category} / ${channel.name}</strong></div>
              <div class="report-meta">${channel.kind}</div>
              <div class="permission-tags">
                ${channel.allowedRoles.map((role) => `<span class="mini-tag">${role}</span>`).join('')}
              </div>
            </div>
          `
        )
        .join('')
    : '<div class="empty-state">Henuz kanal izni yok.</div>';
}

function renderAll() {
  renderMobileLayout();
  renderServers();
  renderChannels();
  renderHeader();
  renderComposerState();
  renderMessages();
  renderMembers();
  renderSidebarTab();
  renderVoicePanel();
  renderReports();
  renderPolls();
  renderPermissions();
  renderVideoPanel();
  renderTypingIndicator();
}

function renderTypingIndicator() {
  if (isDmConversation()) {
    const users = (appState.typingState[dmScopeKey(activeDmUser)] || []).filter((user) => user !== currentUser);
    if (users.length) {
      helperText.textContent = `${users.join(', ')} yaziyor...`;
      return;
    }
  }

  if (!isDmConversation() && currentChannelId) {
    const users = (appState.typingState[`channel:${currentChannelId}`] || []).filter((user) => user !== currentUser);
    if (users.length) {
      helperText.textContent = `${users.join(', ')} yaziyor...`;
      return;
    }
  }
}

function switchServer(serverId) {
  currentServerId = serverId;
  clearReplyTarget();
  const server = getCurrentServer();
  const firstChannel = server?.categories[0]?.channels[0];
  if (firstChannel) {
    activeConversationType = 'channel';
    activeSidebarTab = 'members';
    activeDmUser = null;
    currentChannelId = firstChannel.id;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'switchChannel',
        username: currentUser,
        serverId: currentServerId,
        channelId: firstChannel.id
      }));
    }
  }
  syncMobileViewAfterSelection(isMobileView() ? 'channels' : 'chat');
  renderAll();
}

function switchChannel(channelId) {
  activeConversationType = 'channel';
  activeSidebarTab = 'members';
  activeDmUser = null;
  clearReplyTarget();
  currentChannelId = channelId;
  const server = getCurrentServer();
  const channel = getCurrentChannel();
  if (!server || !channel) {
    return;
  }

  if (channel.kind === 'voice') {
    showToast('Bu kanal sesli oda. Join Voice ile katilabilirsin.');
  } else {
    showToast('Slash komutlari: /help, /stats, /poll soru | secenek1 | secenek2');
  }

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'switchChannel',
      username: currentUser,
      serverId: currentServerId,
      channelId
    }));
  }
  syncMobileViewAfterSelection('chat');
  renderAll();
}

function openDm(username) {
  activeConversationType = 'dm';
  activeSidebarTab = 'dm';
  activeDmUser = username;
  clearReplyTarget();
  unreadDmCounts[username] = 0;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'openDm',
      username: currentUser,
      peerUsername: username
    }));
  }
  syncMobileViewAfterSelection('chat');
  renderAll();
}

function connectWS() {
  ws = new WebSocket(`${wsProtocol()}://${location.host}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'identify', username: currentUser }));
    if (isDmConversation() && activeDmUser) {
      ws.send(JSON.stringify({
        type: 'openDm',
        username: currentUser,
        peerUsername: activeDmUser
      }));
    } else if (currentServerId && currentChannelId) {
      ws.send(JSON.stringify({
        type: 'switchChannel',
        username: currentUser,
        serverId: currentServerId,
        channelId: currentChannelId
      }));
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'messages') {
      appState.messages[data.channelId] = data.messages;
      renderMessages();
      return;
    }

    if (data.type === 'dmMessages') {
      const previousCount = (appState.directMessages[data.peerUsername] || []).length;
      appState.directMessages[data.peerUsername] = data.messages;
      if (isDmConversation() && activeDmUser === data.peerUsername) {
        unreadDmCounts[data.peerUsername] = 0;
        renderMessages();
      } else {
        const incomingCount = Math.max(0, data.messages.length - previousCount);
        unreadDmCounts[data.peerUsername] = (unreadDmCounts[data.peerUsername] || 0) + incomingCount;
        if (incomingCount > 0) {
          playNotificationSound();
          showToast(`${data.peerUsername} sana DM gonderdi.`);
          const latestMessage = data.messages[data.messages.length - 1];
          showBrowserNotification(`${data.peerUsername} sana DM gonderdi`, latestMessage?.text || 'Yeni mesaj');
        }
      }
      renderDmList();
      return;
    }

    if (data.type === 'message') {
      const { channelId, message } = data;
      if (!appState.messages[channelId]) {
        appState.messages[channelId] = [];
      }
      appState.messages[channelId].push(message);
      if (message.user !== currentUser) {
        playNotificationSound();
        const mentionLabel = messageMentionsUser(message.text) ? ' seni etiketledi' : ' yeni mesaj';
        showBrowserNotification(`${message.user}${mentionLabel}`, message.text || 'Yeni kanal mesaji');
      }
      if (channelId === currentChannelId) {
        renderMessages();
        if (message.user !== currentUser) {
          showToast(messageMentionsUser(message.text)
            ? `${message.user} seni etiketledi.`
            : `${message.user} yeni mesaj gonderdi.`);
        }
      }
      return;
    }

    if (data.type === 'messageUpdated') {
      const list = appState.messages[data.channelId] || [];
      const index = list.findIndex((message) => message.id === data.message.id);
      if (index >= 0) {
        list[index] = data.message;
      } else {
        list.push(data.message);
      }
      if (data.channelId === currentChannelId) {
        renderMessages();
      }
      return;
    }

    if (data.type === 'messageDeleted') {
      const list = appState.messages[data.channelId] || [];
      appState.messages[data.channelId] = list.filter((message) => message.id !== data.messageId);
      if (data.channelId === currentChannelId) {
        renderMessages();
      }
      return;
    }

    if (data.type === 'stateUpdated') {
      appState.users = data.users;
      appState.presence = data.presence;
      appState.voicePresence = data.voicePresence;
      appState.callPresence = data.callPresence || {};
      appState.typingState = data.typingState || {};
      currentVoiceChannelId = appState.presence[currentUser]?.voiceChannelId || null;
      renderMembers();
      renderDmList();
      renderVoicePanel();
      renderHeader();
      renderVideoPanel();
      renderTypingIndicator();
      return;
    }

    if (data.type === 'serverUpdated') {
      const index = appState.servers.findIndex((server) => server.id === data.server.id);
      if (index >= 0) {
        appState.servers[index] = data.server;
      } else {
        appState.servers.push(data.server);
      }
      appState.messages = data.messages;
      appState.directMessages = data.directMessages || appState.directMessages;
      appState.voicePresence = data.voicePresence;
      appState.presence = data.presence;
      appState.callPresence = data.callPresence || {};
      appState.typingState = data.typingState || {};
      currentVoiceChannelId = appState.presence[currentUser]?.voiceChannelId || null;
      renderAll();
      return;
    }

    if (data.type === 'typingState') {
      appState.typingState[data.scopeKey] = data.users || [];
      renderTypingIndicator();
      return;
    }

    if (data.type === 'callState') {
      appState.callPresence[data.channelId] = data.participants || [];
      if ((data.participants || []).includes(currentUser)) {
        activeCallChannelId = data.channelId;
      }
      renderVideoPanel();
      const peers = (data.participants || []).filter((username) => username !== currentUser);
      peers.forEach((peerUsername) => {
        if (localStream) {
          createPeerConnection(peerUsername);
        }
      });
      return;
    }

    if (data.type === 'callLeft') {
      if (data.channelId && appState.callPresence[data.channelId]) {
        appState.callPresence[data.channelId] = appState.callPresence[data.channelId].filter((item) => item !== data.username);
      }
      if (data.username === currentUser) {
        activeCallChannelId = null;
      }
      closePeerConnection(data.username);
      renderVideoPanel();
      return;
    }

    if (data.type === 'webrtcSignal') {
      handleIncomingSignal(data).catch(() => showToast('Goruntulu konusma sinyali islenemedi.'));
      return;
    }

    if (data.type === 'system') {
      showToast(data.text);
      return;
    }

    if (data.type === 'error') {
      if (/oturum|giris/i.test(data.message || '')) {
        shouldReconnect = false;
      }
      alert(data.message);
    }
  };

  ws.onclose = (event) => {
    if (!shouldReconnect || [4001, 4004, 4009].includes(event.code) || !currentUser) {
      return;
    }
    setTimeout(connectWS, 1000);
  };
}

async function bootstrap() {
  const data = await request(`${API.bootstrap}?username=${encodeURIComponent(currentUser)}`);
  appState = data;
  currentUser = data.currentUser?.username || currentUser;
  unreadDmCounts = {};
  currentServerId = appState.servers[0]?.id || null;
  currentChannelId = appState.servers[0]?.categories[0]?.channels[0]?.id || null;
  currentVoiceChannelId = appState.presence[currentUser]?.voiceChannelId || null;
  appState.callPresence = appState.callPresence || {};
  presenceSelect.value = appState.currentUser?.preferredStatus || appState.presence[currentUser]?.status || 'online';
  renderAll();
  connectWS();
}

function showLogin() {
  showModal(`
    <h2>Topluluk Sunucusu Giris</h2>
    <p class="modal-copy">Demo hesaplar: admin/123, moderator/123, student/123. Ayni hesap web ve mobilde ayni anda acik kalabilir.</p>
    <input id="loginUser" class="modal-input" placeholder="Kullanici adi" />
    <input id="loginPass" class="modal-input" type="password" placeholder="Sifre" />
    <button id="loginSubmit" class="modal-btn primary">Giris Yap</button>
    <button id="showRegister" class="modal-btn secondary">Kayit Ol</button>
  `);

  document.getElementById('loginSubmit').onclick = async () => {
    try {
      const username = document.getElementById('loginUser').value.trim();
      const password = document.getElementById('loginPass').value;
      const result = await request(API.login, { method: 'POST', body: JSON.stringify({ username, password }) });
      currentUser = result.username || username;
      shouldReconnect = true;
      hideModal();
      document.getElementById('appShell').classList.remove('hidden');
      bootstrap();
    } catch (error) {
      alert(error.message);
    }
  };

  document.getElementById('showRegister').onclick = showRegister;
}

function showRegister() {
  showModal(`
    <h2>Yeni Uye</h2>
    <p class="modal-copy">Kayit olan herkes mevcut sunuculara member olarak eklenir. Kullanici adlari tekildir ve 3-24 karakter arasinda olmalidir.</p>
    <input id="regUser" class="modal-input" placeholder="Kullanici adi" />
    <input id="regPass" class="modal-input" type="password" placeholder="Sifre" />
    <input id="regAvatar" class="modal-input" type="file" accept="image/*" />
    <button id="registerSubmit" class="modal-btn primary">Kayit Ol</button>
    <button id="showLogin" class="modal-btn secondary">Geri Don</button>
  `);

  document.getElementById('registerSubmit').onclick = async () => {
    try {
      const username = document.getElementById('regUser').value.trim();
      const password = document.getElementById('regPass').value;
      const file = document.getElementById('regAvatar').files?.[0];

      const submitRegister = async (avatar = null) => {
        await request(API.register, {
          method: 'POST',
          body: JSON.stringify({ username, password, avatar })
        });
        alert('Kayit tamam. Giris yapabilirsin.');
        showLogin();
      };

      if (!file) {
        await submitRegister(null);
        return;
      }

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await submitRegister(reader.result);
        } catch (error) {
          alert(error.message);
        }
      };
      reader.readAsDataURL(file);
    } catch (error) {
      alert(error.message);
    }
  };

  document.getElementById('showLogin').onclick = showLogin;
}

function sendMessage() {
  const text = messageInput.value.trim();
  const channel = getCurrentChannel();
  if (!text && !pendingAttachments.length) {
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Baglanti yeniden kuruluyor. Biraz sonra tekrar dene.');
    return;
  }

  if (isDmConversation()) {
    ws.send(JSON.stringify({
      type: 'dmMessage',
      username: currentUser,
      peerUsername: activeDmUser,
      text,
      replyTo: replyTarget,
      attachments: pendingAttachments
    }));
    messageInput.value = '';
    clearReplyTarget();
    clearPendingAttachments();
    ws.send(JSON.stringify({
      type: 'typing',
      scope: 'dm',
      username: currentUser,
      peerUsername: activeDmUser,
      channelId: currentChannelId,
      isTyping: false
    }));
    return;
  }

  if (!channel) {
    return;
  }

  if (channel.kind === 'voice') {
    alert('Sesli odalara yazi mesaji yerine join/leave mantigi uygulanir.');
    return;
  }

  ws.send(JSON.stringify({
    type: 'message',
    serverId: currentServerId,
    channelId: currentChannelId,
    username: currentUser,
    text,
    replyTo: replyTarget,
    attachments: pendingAttachments
  }));
  messageInput.value = '';
  clearReplyTarget();
  clearPendingAttachments();
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'typing',
      scope: isDmConversation() ? 'dm' : 'channel',
      username: currentUser,
      peerUsername: activeDmUser,
      channelId: currentChannelId,
      isTyping: false
    }));
  }
}

async function logout() {
  shouldReconnect = false;
  try {
    if (currentUser) {
      await request(API.logout, {
        method: 'POST',
        body: JSON.stringify({ username: currentUser })
      });
    }
  } catch {
    // Best-effort logout so stale local pages do not block the user.
  }

  if (ws) {
    try {
      ws.close(4001, 'logout');
    } catch {
      // Ignore close failures during reload.
    }
  }

  location.reload();
}

async function createServer() {
  showModal(`
    <h2>Sunucu Olustur</h2>
    <input id="serverName" class="modal-input" placeholder="Sunucu adi" />
    <button id="submitServer" class="modal-btn primary">Olustur</button>
  `);

  document.getElementById('submitServer').onclick = async () => {
    try {
      const name = document.getElementById('serverName').value.trim();
      const data = await request(API.createServer, {
        method: 'POST',
        body: JSON.stringify({ name, creator: currentUser })
      });
      const existingIndex = appState.servers.findIndex((server) => server.id === data.server.id);
      if (existingIndex >= 0) {
        appState.servers[existingIndex] = data.server;
      } else {
        appState.servers.push(data.server);
      }
      hideModal();
      switchServer(data.server.id);
      renderAll();
    } catch (error) {
      alert(error.message);
    }
  };
}

function createChannel() {
  const server = getCurrentServer();
  if (!server) {
    return;
  }

  showModal(`
    <h2>Kanal Ekle</h2>
    <input id="channelName" class="modal-input" placeholder="Kanal adi" />
    <select id="channelKind" class="modal-input">
      <option value="text">Text</option>
      <option value="voice">Voice</option>
    </select>
    <select id="channelCategory" class="modal-input">
      ${server.categories.map((category) => `<option value="${category.id}">${category.name}</option>`).join('')}
    </select>
    <label class="checkbox-row"><input id="roleMember" type="checkbox" checked /> member</label>
    <label class="checkbox-row"><input id="roleMod" type="checkbox" checked /> mod</label>
    <label class="checkbox-row"><input id="roleAdmin" type="checkbox" checked /> admin</label>
    <button id="submitChannel" class="modal-btn primary">Kaydet</button>
  `);

  document.getElementById('submitChannel').onclick = async () => {
    try {
      const allowedRoles = ['member', 'mod', 'admin'].filter((role) => {
        const id = `role${role.charAt(0).toUpperCase()}${role.slice(1)}`;
        return document.getElementById(id).checked;
      });
      await request(API.createChannel, {
        method: 'POST',
        body: JSON.stringify({
          serverId: currentServerId,
          categoryId: document.getElementById('channelCategory').value,
          name: document.getElementById('channelName').value.trim(),
          kind: document.getElementById('channelKind').value,
          allowedRoles,
          actor: currentUser
        })
      });
      hideModal();
    } catch (error) {
      alert(error.message);
    }
  };
}

function createCategory() {
  showModal(`
    <h2>Kategori Ekle</h2>
    <input id="categoryName" class="modal-input" placeholder="Kategori adi" />
    <button id="submitCategory" class="modal-btn primary">Kaydet</button>
  `);

  document.getElementById('submitCategory').onclick = async () => {
    try {
      await request(API.createCategory, {
        method: 'POST',
        body: JSON.stringify({
          serverId: currentServerId,
          name: document.getElementById('categoryName').value.trim(),
          actor: currentUser
        })
      });
      hideModal();
    } catch (error) {
      alert(error.message);
    }
  };
}

function assignRole() {
  const server = getCurrentServer();
  showModal(`
    <h2>Rol Ata</h2>
    <select id="roleUser" class="modal-input">
      ${server.members.map((member) => `<option value="${member.username}">${member.username}</option>`).join('')}
    </select>
    <select id="roleValue" class="modal-input">
      <option value="member">member</option>
      <option value="mod">mod</option>
      <option value="admin">admin</option>
    </select>
    <button id="submitRole" class="modal-btn primary">Guncelle</button>
  `);

  document.getElementById('submitRole').onclick = async () => {
    try {
      await request(API.changeRole, {
        method: 'POST',
        body: JSON.stringify({
          serverId: currentServerId,
          targetUser: document.getElementById('roleUser').value,
          role: document.getElementById('roleValue').value,
          actor: currentUser
        })
      });
      hideModal();
    } catch (error) {
      alert(error.message);
    }
  };
}

function moderateUser() {
  const server = getCurrentServer();
  showModal(`
    <h2>Moderasyon</h2>
    <select id="modUser" class="modal-input">
      ${server.members.filter((member) => member.username !== currentUser).map((member) => `<option value="${member.username}">${member.username}</option>`).join('')}
    </select>
    <select id="modAction" class="modal-input">
      <option value="mute">mute</option>
      <option value="unmute">unmute</option>
      <option value="ban">ban</option>
    </select>
    <input id="modReason" class="modal-input" placeholder="Sebep" />
    <button id="submitMod" class="modal-btn primary">Uygula</button>
  `);

  document.getElementById('submitMod').onclick = async () => {
    try {
      await request(API.moderation, {
        method: 'POST',
        body: JSON.stringify({
          serverId: currentServerId,
          targetUser: document.getElementById('modUser').value,
          action: document.getElementById('modAction').value,
          reason: document.getElementById('modReason').value.trim(),
          actor: currentUser
        })
      });
      hideModal();
    } catch (error) {
      alert(error.message);
    }
  };
}

function reportUser() {
  const server = getCurrentServer();
  showModal(`
    <h2>Mesaj Raporla</h2>
    <select id="reportUser" class="modal-input">
      ${server.members.filter((member) => member.username !== currentUser).map((member) => `<option value="${member.username}">${member.username}</option>`).join('')}
    </select>
    <input id="reportReason" class="modal-input" placeholder="Rapor nedeni" />
    <button id="submitReport" class="modal-btn primary">Gonder</button>
  `);

  document.getElementById('submitReport').onclick = async () => {
    try {
      await request(API.report, {
        method: 'POST',
        body: JSON.stringify({
          serverId: currentServerId,
          reporter: currentUser,
          targetUser: document.getElementById('reportUser').value,
          channelId: currentChannelId,
          reason: document.getElementById('reportReason').value.trim()
        })
      });
      hideModal();
    } catch (error) {
      alert(error.message);
    }
  };
}

function toggleVoice() {
  const channel = getCurrentChannel();
  const server = getCurrentServer();
  if (!server) {
    return;
  }

  if (currentVoiceChannelId) {
    ws.send(JSON.stringify({
      type: 'leaveVoice',
      username: currentUser,
      serverId: currentServerId
    }));
    currentVoiceChannelId = null;
    renderVoicePanel();
    renderHeader();
    return;
  }

  if (!channel || channel.kind !== 'voice') {
    alert('Bir sesli kanala gec ve sonra Join Voice kullan.');
    return;
  }

  currentVoiceChannelId = channel.id;
  ws.send(JSON.stringify({
    type: 'joinVoice',
    username: currentUser,
    serverId: currentServerId,
    channelId: channel.id
  }));
  renderVoicePanel();
  renderHeader();
}

function joinVoice() {
  if (currentVoiceChannelId) {
    renderCallOverlay();
    return;
  }

  const currentChannel = getCurrentChannel();
  const targetChannel = currentChannel?.kind === 'voice' ? currentChannel : getFirstVoiceChannel();
  if (!targetChannel) {
    alert('Sunucuda kullanilabilir bir sesli kanal yok.');
    return;
  }

  currentVoiceChannelId = targetChannel.id;
  ws.send(JSON.stringify({
    type: 'joinVoice',
    username: currentUser,
    serverId: currentServerId,
    channelId: targetChannel.id
  }));
  renderVoicePanel();
  renderHeader();
  renderCallOverlay();
}

function leaveVoice() {
  if (currentVoiceChannelId) {
    toggleVoice();
  }
}

async function startVideoCall() {
  let channel = getCallChannel();
  if (!channel) {
    channel = getFirstVoiceChannel();
    if (!channel) {
      alert('Goruntulu konusma icin once bir sesli odaya katil.');
      return;
    }
  }

  if (currentVoiceChannelId !== channel.id) {
    currentVoiceChannelId = channel.id;
    ws.send(JSON.stringify({
      type: 'joinVoice',
      username: currentUser,
      serverId: currentServerId,
      channelId: channel.id
    }));
    renderVoicePanel();
    renderHeader();
  }

  try {
    openCallOverlay();
    await ensureLocalMedia();
    if (!getActiveTrack(localStream, 'video')) {
      try {
        await ensureVideoTrack();
        lastCallCapabilityMessage = 'Kamera ayri olarak tekrar istendi ve etkinlestirildi.';
      } catch {
        lastCallCapabilityMessage = 'Su an sadece ses acilabildi. Kamera iznini kontrol edip tekrar dene.';
      }
    }
    activeCallChannelId = channel.id;
    ws.send(JSON.stringify({
      type: 'joinCall',
      username: currentUser,
      serverId: currentServerId,
      channelId: channel.id
    }));
    showToast('Goruntulu konusma baslatildi.');
    renderVideoPanel();
  } catch (error) {
    const message = error instanceof Error ? error.message : explainMediaError(error);
    lastCallCapabilityMessage = message;
    renderVideoPanel();
    alert(message);
  }
}

function stopLocalMedia() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
}

function endVideoCall() {
  if (!activeCallChannelId && !localStream) {
    return;
  }

  ws.send(JSON.stringify({
    type: 'leaveCall',
    username: currentUser,
    channelId: activeCallChannelId || currentVoiceChannelId || currentChannelId
  }));
  stopLocalMedia();
  activeCallChannelId = null;
  cleanupCallUi();
  showToast('Goruntulu konusma sonlandirildi.');
}

function toggleMic() {
  if (!localStream) {
    showToast('Once goruntulu konusma baslat.');
    return;
  }
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = micEnabled;
  });
  renderVideoPanel();
  showToast(micEnabled ? 'Mikrofon acildi.' : 'Mikrofon kapatildi.');
}

function toggleCamera() {
  if (!localStream) {
    showToast('Once goruntulu konusma baslat.');
    return;
  }
  if (!getActiveTrack(localStream, 'video')) {
    ensureVideoTrack()
      .then(() => {
        lastCallCapabilityMessage = 'Kamera tekrar istendi ve baglanti yenilendi.';
        renderVideoPanel();
        showToast('Kamera eklendi.');
      })
      .catch((error) => showToast(explainMediaError(error)));
    return;
  }
  cameraEnabled = !cameraEnabled;
  localStream.getVideoTracks().forEach((track) => {
    track.enabled = cameraEnabled;
  });
  renderVideoPanel();
  showToast(cameraEnabled ? 'Kamera acildi.' : 'Kamera kapatildi.');
}

function showSearchModal() {
  const list = getActiveConversationMessages().slice(-40);
  showModal(`
    <h2>${isDmConversation() ? 'DM icinde ara' : 'Kanalda Ara'}</h2>
    <input id="searchInput" class="modal-input" placeholder="Kelime yaz" />
    <div id="searchResults" class="panel-subtitle">Son 40 mesaj aranacak.</div>
  `);

  const input = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    const matches = list.filter((message) => message.text.toLowerCase().includes(q));
    results.innerHTML = q
      ? (matches.length
          ? matches.map((message) => `<div class="report-card"><strong>${escapeHtml(message.user)}</strong><div>${escapeHtml(message.text)}</div></div>`).join('')
          : 'Mesaj bulunamadi.')
      : 'Son 40 mesaj aranacak.';
  };
}

function showPinnedInfo() {
  const server = getCurrentServer();
  const channel = getCurrentChannel();
  showModal(`
    <h2>Kanal Bilgisi</h2>
    <div class="report-card"><strong>Sunucu</strong><div>${escapeHtml(server?.name || '-')}</div></div>
    <div class="report-card"><strong>Kanal</strong><div>${escapeHtml(channel?.name || '-')}</div></div>
    <div class="report-card"><strong>Rolun</strong><div>${escapeHtml(myRole())}</div></div>
  `);
}

function showServerOverview() {
  const server = getCurrentServer();
  if (!server) {
    return;
  }
  const textChannel = getFirstTextChannel(server);
  const voiceChannel = getFirstVoiceChannel(server);
  const openReportCount = server.reports.filter((report) => report.status === 'open').length;
  showModal(`
    <h2>Sunucu Genel Bakis</h2>
    <div class="report-card"><strong>${escapeHtml(server.name)}</strong><div class="report-meta">${server.members.length} uye, ${server.categories.length} kategori</div></div>
    <div class="report-card"><strong>Hizli Gecis</strong><div class="report-meta">Metin kanali: ${escapeHtml(textChannel?.name || '-')} | Sesli oda: ${escapeHtml(voiceChannel?.name || '-')}</div></div>
    <div class="report-card"><strong>Acik rapor</strong><div>${openReportCount}</div></div>
    <button id="overviewChatBtn" class="modal-btn primary">Sohbete Don</button>
    <button id="overviewToolsBtn" class="modal-btn secondary">Sunucu Araclari</button>
  `);

  document.getElementById('overviewChatBtn').onclick = () => {
    hideModal();
    if (textChannel) {
      switchChannel(textChannel.id);
    } else {
      renderAll();
    }
  };
  document.getElementById('overviewToolsBtn').onclick = () => {
    hideModal();
    showUtilityHub();
  };
}

function showUtilityHub() {
  renderReports();
  renderPolls();
  renderPermissions();
  showModal(`
    <h2>Sunucu Araclari</h2>
    <div class="report-card"><strong>Raporlar</strong></div>
    ${reportList.innerHTML}
    <div class="report-card"><strong>Anketler</strong></div>
    ${pollList.innerHTML}
    <div class="report-card"><strong>Izin Matrisi</strong></div>
    ${permissionsList.innerHTML}
    <button id="utilityRoleBtn" class="modal-btn secondary">Rol Yonetimi</button>
    <button id="utilityModBtn" class="modal-btn secondary">Moderasyon</button>
  `);

  document.getElementById('utilityRoleBtn').onclick = () => {
    hideModal();
    assignRole();
  };
  document.getElementById('utilityModBtn').onclick = () => {
    hideModal();
    moderateUser();
  };
}

function showCallHub() {
  openCallOverlay();
}

function openQuickActions() {
  showModal(`
    <h2>Hizli Islemler</h2>
    <button id="quickAttach" class="modal-btn primary">Dosya / Gorsel Ekle</button>
    <button id="quickCreateChannel" class="modal-btn secondary">Kanal Ekle</button>
    <button id="quickCreateCategory" class="modal-btn secondary">Kategori Ekle</button>
    <button id="quickReport" class="modal-btn secondary">Rapor Olustur</button>
  `);

  document.getElementById('quickAttach').onclick = () => {
    hideModal();
    attachmentInput?.click();
  };
  document.getElementById('quickCreateChannel').onclick = () => {
    hideModal();
    createChannel();
  };
  document.getElementById('quickCreateCategory').onclick = () => {
    hideModal();
    createCategory();
  };
  document.getElementById('quickReport').onclick = () => {
    hideModal();
    reportUser();
  };
}

function toggleMembersPanel() {
  if (isMobileView()) {
    if (isDmConversation()) {
      activeSidebarTab = 'dm';
      renderSidebarTab();
    }
    setMobileView(mobileView === 'members' ? 'chat' : 'members');
    return;
  }
  sidebar.classList.toggle('hidden-panel');
}

function handleNavAction(section) {
  if (section === 'home') {
    showServerOverview();
    return;
  }

  if (section === 'chat') {
    const preferredChannel = getCurrentChannel()?.kind === 'text'
      ? getCurrentChannel()
      : getFirstTextChannel();
    activeConversationType = 'channel';
    activeSidebarTab = 'members';
    activeDmUser = null;
    if (preferredChannel) {
      switchChannel(preferredChannel.id);
    } else {
      renderAll();
    }
    syncMobileViewAfterSelection('chat');
    return;
  }

  if (section === 'game') {
    showCallHub();
    return;
  }

  if (section === 'apps') {
    showUtilityHub();
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.body.classList.toggle('light-mode', theme === 'light');
  themeToggleBtn.innerHTML = theme === 'light' ? '&#9728;' : '&#127769;';
  localStorage.setItem('community-theme', theme);
}

function renderMobileLayout() {
  if (isMobileView()) {
    sidebar.classList.remove('hidden-panel');
  }
  setMobileView(isMobileView() ? mobileView : 'chat');
  mobileWorkspaceBtn.innerHTML = isMobileView() && mobileView !== 'chat' ? '&#10005;' : '&#9776;';
}

function renderChannels() {
  const server = getCurrentServer();
  channelTree.innerHTML = '';

  if (!server) {
    return;
  }

  server.categories.forEach((category) => {
    const group = document.createElement('div');
    group.className = 'channel-group';

    const title = document.createElement('div');
    title.className = 'channel-group-title';
    title.textContent = category.name;
    group.appendChild(title);

    category.channels.forEach((channel) => {
      const item = document.createElement('button');
      item.className = `channel-item ${channel.id === currentChannelId ? 'active' : ''}`;
      item.innerHTML = `<span class="channel-prefix">${channelPrefix(channel)}</span><span>${escapeHtml(channel.name)}</span>`;
      item.onclick = () => switchChannel(channel.id);
      group.appendChild(item);
    });

    channelTree.appendChild(group);
  });
}

function renderHeader() {
  const server = getCurrentServer();
  const channel = getCurrentChannel();
  if (!server || !channel) {
    return;
  }

  currentLocation.textContent = isDmConversation()
    ? `DM / ${activeDmUser}`
    : channelDisplayName(channel);
  const me = server.members.find((member) => member.username === currentUser);
  userBadge.textContent = `${currentUser} (${me?.role || 'member'})`;
  serverInfoName.textContent = server.name;
  mobileContextTag.textContent = isDmConversation() ? `${server.name} • DM` : server.name;
  mobileChannelsSummary.textContent = `${server.name} icindeki kanallar ve odalar`;
  mobileContextTag.textContent = isDmConversation() ? `${server.name} | DM` : server.name;
  mobileWorkspaceBtn.title = isDmConversation() ? 'DM listesi' : 'Kanal listesi';
  mobileWorkspaceBtn.innerHTML = isMobileView() && mobileView !== 'chat' ? '&#10005;' : '&#9776;';
  helperText.textContent = isDmConversation()
    ? 'Direkt mesajlasma alani'
    : (channel.kind === 'voice' ? 'Sesli oda kanali' : 'Topluluk metin kanali');
  pinnedMessageText.textContent = getPinnedMessage();
}

function renderMembers() {
  const server = getCurrentServer();
  memberList.innerHTML = '';
  if (!server) {
    return;
  }

  const sortedMembers = [...server.members].sort((a, b) => {
    const presenceOrder = { online: 0, away: 1, busy: 2, offline: 3 };
    const aPresence = appState.presence[a.username]?.status || 'offline';
    const bPresence = appState.presence[b.username]?.status || 'offline';
    const diff = (presenceOrder[aPresence] ?? 4) - (presenceOrder[bPresence] ?? 4);
    if (diff !== 0) {
      return diff;
    }
    return a.username.localeCompare(b.username, 'tr');
  });

  const activeCount = sortedMembers.filter((member) => (appState.presence[member.username]?.status || 'offline') !== 'offline').length;
  membersPanelTitle.textContent = 'Uyeler';
  membersPanelSubtitle.textContent = `${activeCount} aktif, ${sortedMembers.length} toplam uye`;
  membersCountPill.textContent = String(sortedMembers.length);

  const sections = [
    {
      title: 'Cevrimici',
      members: sortedMembers.filter((member) => (appState.presence[member.username]?.status || 'offline') !== 'offline')
    },
    {
      title: 'Cevrimdisi',
      members: sortedMembers.filter((member) => (appState.presence[member.username]?.status || 'offline') === 'offline')
    }
  ].filter((section) => section.members.length);

  const buildMemberMarkup = (member) => {
    const presence = appState.presence[member.username]?.status || 'offline';
    const lastSeenAt = appState.presence[member.username]?.lastSeenAt || null;
    const subtitle = [
      member.role.toUpperCase(),
      member.username === currentUser ? 'Sen' : null,
      presence === 'offline' && lastSeenAt ? `Son gorulme ${formatLastSeen(lastSeenAt)}` : null
    ].filter(Boolean).join(' • ');

    return `
      <div class="member-row" data-username="${member.username}">
        <div class="member-row-main">
          ${avatarMarkup(member.username, 'member-avatar')}
          <div class="member-copy">
            <div class="member-name">${escapeHtml(member.username)}</div>
            <div class="member-role">${escapeHtml(subtitle)}</div>
          </div>
        </div>
        <div class="member-actions">
          <span class="presence ${presence}">${formatPresenceLabel(presence)}</span>
          <button class="mini-action-btn member-profile-btn" data-username="${member.username}">Profil</button>
        </div>
      </div>
    `;
  };

  memberList.innerHTML = sections.map((section) => `
    <section class="member-group">
      <div class="member-group-title">${section.title} — ${section.members.length}</div>
      <div class="member-group-list">
        ${section.members.map((member) => buildMemberMarkup(member)).join('')}
      </div>
    </section>
  `).join('');

  memberList.querySelectorAll('.member-profile-btn').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      showUserProfile(button.dataset.username);
    };
  });

  memberList.querySelectorAll('.member-row').forEach((row) => {
    row.onclick = () => showUserProfile(row.dataset.username);
  });
}

function renderDmList() {
  dmList.innerHTML = '';
  const users = appState.users
    .filter((user) => user.username !== currentUser)
    .sort((a, b) => {
      const aLast = getLastDmMessage(a.username)?.time || 0;
      const bLast = getLastDmMessage(b.username)?.time || 0;
      if (aLast !== bLast) {
        return bLast - aLast;
      }
      return a.username.localeCompare(b.username, 'tr');
    });

  membersPanelTitle.textContent = 'DM';
  membersPanelSubtitle.textContent = `${users.length} kullanici ile direkt mesaj`;
  membersCountPill.textContent = String(users.length);

  dmList.innerHTML = users.map((user) => {
    const presence = appState.presence[user.username]?.status || 'offline';
    const lastSeenAt = appState.presence[user.username]?.lastSeenAt || null;
    const lastMessage = getLastDmMessage(user.username);
    const preview = lastMessage
      ? `${lastMessage.user === currentUser ? 'Sen: ' : ''}${lastMessage.text || '[Ek]'}` 
      : 'Henuz direkt mesaj yok';

    return `
      <div class="dm-row">
        <button class="dm-user ${activeDmUser === user.username ? 'active' : ''}" data-username="${user.username}">
          <span class="dm-user-top">
            <span class="dm-user-head">
              ${avatarMarkup(user.username, 'member-avatar')}
              <span class="dm-name-wrap">
                <strong>${escapeHtml(user.username)}</strong>
                <span class="report-meta">${presence === 'offline' && lastSeenAt ? `Son gorulme ${formatLastSeen(lastSeenAt)}` : formatPresenceLabel(presence)}</span>
              </span>
            </span>
            <span class="dm-user-tail">
              ${unreadDmCounts[user.username] ? `<span class="badge-dot">${unreadDmCounts[user.username]}</span>` : ''}
              <span class="presence ${presence}">${formatPresenceLabel(presence)}</span>
            </span>
          </span>
          <span class="dm-user-bottom">
            <span class="dm-preview">${escapeHtml(preview)}</span>
            <span class="report-meta">${lastMessage ? formatTime(lastMessage.time) : ''}</span>
          </span>
        </button>
        <button class="mini-action-btn dm-profile-btn" data-username="${user.username}">Profil</button>
      </div>
    `;
  }).join('');

  dmList.querySelectorAll('.dm-user').forEach((button) => {
    button.onclick = () => openDm(button.dataset.username);
    button.oncontextmenu = (event) => {
      event.preventDefault();
      showUserProfile(button.dataset.username);
    };
  });

  dmList.querySelectorAll('.dm-profile-btn').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      showUserProfile(button.dataset.username);
    };
  });
}

function renderCallOverlay() {
  if (!callOverlay) {
    return;
  }

  const callChannel = getCallChannel() || getFirstVoiceChannel();
  const participants = getCurrentCallMembers();
  const tiles = getCallTiles();
  const focusedTile = getPreferredStageTile(tiles);
  const hasCall = Boolean(localStream || participants.length || remoteStreams.size || activeCallChannelId);
  const hasAudioTrack = Boolean(getActiveTrack(localStream, 'audio'));
  const hasVideoTrack = Boolean(getActiveTrack(localStream, 'video'));
  const cameraOnCount = tiles.filter((tile) => tile.hasVideo).length;
  const audioOnCount = tiles.filter((tile) => tile.hasAudio).length;
  const galleryLayoutClass = tiles.length <= 1
    ? 'layout-1'
    : tiles.length === 2
      ? 'layout-2'
      : tiles.length === 3
        ? 'layout-3'
        : tiles.length === 4
          ? 'layout-4'
          : 'layout-many';

  callOverlayTitle.textContent = callChannel
    ? `Voice / ${callChannel.name}`
    : 'Sesli Oda Sec';
  callOverlayMeta.textContent = callChannel
    ? `${Math.max(participants.length, tiles.length || 1)} kisi | ${cameraOnCount} kamera | ${audioOnCount} mikrofon`
    : 'Once bir sesli odaya katil, sonra kamerayi baslat.';

  callOverlayStatus.textContent = hasCall
    ? (lastCallCapabilityMessage || 'Goruntulu konusma aktif. Galeri yerlesiminde tum katilimcilari ayni anda takip edebilirsin.')
    : (isSecureMediaContext()
        ? 'Henuz aktif goruntulu konusma yok. Voice kanala girip buradan cagriyi baslat.'
        : 'Bu ozellik icin HTTPS veya localhost gerekli.');

  callOverlaySummary.textContent = hasVideoTrack
    ? (cameraEnabled ? 'Kamera yayinliyor. Karsi taraf ayni voice odada kamerayi actiginda galeride gorunur.' : 'Kamera mevcut ama su an kapali.')
    : 'Yerel kamera henuz baglanmadi. Kamera izni verip tekrar dene.';

  callOverlayJoinBtn.disabled = !callChannel || currentVoiceChannelId === callChannel.id;
  callOverlayJoinBtn.textContent = callChannel && currentVoiceChannelId === callChannel.id ? 'Voice Odadasin' : 'Voice Katil';
  callOverlayStartBtn.disabled = !callChannel;
  callOverlayMicBtn.disabled = !hasAudioTrack;
  callOverlayCameraBtn.disabled = false;
  callOverlayEndBtn.disabled = !hasCall;

  callOverlayMicBtn.textContent = hasAudioTrack ? (micEnabled ? 'Mikrofon Acik' : 'Mikrofon Kapali') : 'Mikrofon Yok';
  callOverlayCameraBtn.textContent = hasVideoTrack ? (cameraEnabled ? 'Kamera Acik' : 'Kamera Kapali') : 'Kamerayi Ac';
  callOverlayMicBtn.className = `call-dock-btn ${hasAudioTrack ? (micEnabled ? 'active' : 'muted') : ''}`.trim();
  callOverlayCameraBtn.className = `call-dock-btn ${hasVideoTrack ? (cameraEnabled ? 'active' : 'muted') : 'primary'}`.trim();

  if (!focusedTile) {
    callStage.innerHTML = `
      <div class="call-stage-card placeholder">
        <div class="call-empty-big">
          <strong>Canli sahne hazir</strong>
          <p>${escapeHtml(lastCallCapabilityMessage || 'Sesli odaya katilip Video Ac dugmesine bastiginda cagri galerisi burada acilir.')}</p>
        </div>
      </div>
    `;
    callFilmstrip.innerHTML = '';
    callOverlayMembers.innerHTML = '<div class="empty-state">Henuz katilimci yok.</div>';
    callOverlay.classList.toggle('hidden', !callOverlayOpen);
    callOverlay.setAttribute('aria-hidden', String(!callOverlayOpen));
    document.body.classList.toggle('call-open', callOverlayOpen);
    return;
  }

  callStage.innerHTML = `
    <div class="call-gallery ${galleryLayoutClass}">
      ${tiles.map((tile) => {
        const videoId = tile.hasVideo ? `callGalleryVideo_${tile.key}` : '';
        return `
          <article class="call-gallery-tile ${tile.key === focusedTile.key ? 'active' : ''}" data-call-focus="${escapeHtml(tile.key)}">
            <div class="call-gallery-media">
              ${tile.hasVideo
                ? `<video id="${videoId}" autoplay ${tile.isSelf ? 'muted' : ''} playsinline></video>`
                : `<div class="call-stage-fallback">
                    ${callAvatarMarkup(tile.username)}
                    <strong>${escapeHtml(tile.isSelf ? 'Kameran kapali' : `${tile.username} kamera acmadi`)}</strong>
                    <div>${escapeHtml(callStatusText(tile))}</div>
                  </div>`}
            </div>
            <div class="call-gallery-overlay">
              <div class="call-gallery-corner">
                <span class="call-gallery-chip ${tile.hasAudio ? '' : 'off'}">${tile.hasAudio ? 'Ses acik' : 'Mute'}</span>
                <span class="call-gallery-chip ${tile.hasVideo ? '' : 'off'}">${tile.hasVideo ? 'Kamera acik' : 'Kamera kapali'}</span>
              </div>
              <div class="call-gallery-meta">
                <div class="call-gallery-info">
                  <div class="call-gallery-name">${escapeHtml(tile.isSelf ? 'Sen' : tile.username)}</div>
                  <div class="call-gallery-copy">${escapeHtml(callStatusText(tile))}</div>
                </div>
                ${tile.key === focusedTile.key ? '<span class="call-gallery-chip">Odak</span>' : ''}
              </div>
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;

  callFilmstrip.innerHTML = `
    <span class="call-summary-chip accent">Galeri</span>
    <span class="call-summary-chip">${tiles.length} panel</span>
    <span class="call-summary-chip">${cameraOnCount} kamera acik</span>
    <span class="call-summary-chip">${audioOnCount} mikrofon acik</span>
    ${callChannel ? `<span class="call-summary-chip">${escapeHtml(callChannel.name)}</span>` : ''}
  `;

  callOverlayMembers.innerHTML = tiles.map((tile) => `
    <div class="call-member-row">
      <div class="call-member-left">
        ${callAvatarMarkup(tile.username, 'call-avatar small')}
        <div class="call-member-meta">
          <div class="call-member-name">${escapeHtml(tile.isSelf ? 'Sen' : tile.username)}</div>
          <div class="call-member-subtitle">${escapeHtml(callStatusText(tile))}</div>
        </div>
      </div>
      <div class="call-member-right">
        <span class="call-badge ${tile.hasAudio ? 'on' : 'off'}">${tile.hasAudio ? 'Ses' : 'Mute'}</span>
        <span class="call-badge ${tile.hasVideo ? 'on' : 'off'}">${tile.hasVideo ? 'Cam' : 'Kapali'}</span>
      </div>
    </div>
  `).join('');

  callStage.querySelectorAll('[data-call-focus]').forEach((tile) => {
    tile.onclick = () => {
      focusedCallTileKey = tile.dataset.callFocus;
      renderCallOverlay();
    };
  });

  tiles.forEach((tile) => {
    if (tile.hasVideo && tile.stream) {
      attachRenderedVideo(`callGalleryVideo_${tile.key}`, tile.stream, tile.isSelf);
    }
  });

  callOverlay.classList.toggle('hidden', !callOverlayOpen);
  callOverlay.setAttribute('aria-hidden', String(!callOverlayOpen));
  document.body.classList.toggle('call-open', callOverlayOpen);
}

window.onload = () => {
  applyTheme(currentTheme);
  renderMobileLayout();
  document.getElementById('appShell').classList.add('hidden');
  showLogin();
  document.body.addEventListener('click', () => {
    ensureNotificationsEnabled();
    if (audioContext?.state === 'suspended') {
      audioContext.resume();
    }
  }, { once: true });

  searchBtn.innerHTML = '&#128269;';
  pinBtn.innerHTML = '&#128204;';
  videoBtn.innerHTML = '&#127909;';
  membersToggleBtn.innerHTML = '&#128101;';
  document.querySelector('.pinned-icon').innerHTML = '&#128204;';

  sendBtn.onclick = sendMessage;
  attachmentInput.onchange = async () => {
    try {
      await loadAttachmentFiles(attachmentInput.files);
    } catch (error) {
      showToast(error.message || 'Dosya eklenemedi.');
    }
  };
  messageInput.onkeydown = (event) => {
    if (event.key === 'Enter') {
      sendMessage();
    }
  };
  messageInput.oninput = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(JSON.stringify({
      type: 'typing',
      scope: isDmConversation() ? 'dm' : 'channel',
      username: currentUser,
      peerUsername: activeDmUser,
      channelId: currentChannelId,
      isTyping: Boolean(messageInput.value.trim())
    }));

    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'typing',
          scope: isDmConversation() ? 'dm' : 'channel',
          username: currentUser,
          peerUsername: activeDmUser,
          channelId: currentChannelId,
          isTyping: false
        }));
      }
    }, 1200);
  };
  modalOverlay.onclick = (event) => {
    if (event.target === modalOverlay) {
      hideModal();
    }
  };
  createServerBtn.onclick = createServer;
  createCategoryBtn.onclick = createCategory;
  createChannelBtn.onclick = createChannel;
  assignRoleBtn.onclick = assignRole;
  moderateBtn.onclick = moderateUser;
  reportBtn.onclick = reportUser;
  joinVoiceBtn.onclick = joinVoice;
  leaveVoiceBtn.onclick = leaveVoice;
  logoutBtn.onclick = logout;
  themeToggleBtn.onclick = () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  };
  startVideoBtn.onclick = startVideoCall;
  endVideoBtn.onclick = endVideoCall;
  toggleMicBtn.onclick = toggleMic;
  toggleCameraBtn.onclick = toggleCamera;
  videoBtn.onclick = openCallOverlay;
  callOverlayJoinBtn.onclick = joinVoice;
  callOverlayStartBtn.onclick = startVideoCall;
  callOverlayMicBtn.onclick = toggleMic;
  callOverlayCameraBtn.onclick = toggleCamera;
  callOverlayEndBtn.onclick = endVideoCall;
  callOverlayCloseBtn.onclick = () => closeCallOverlay({ minimized: Boolean(activeCallChannelId || localStream) });
  callOverlayMinimizeBtn.onclick = () => closeCallOverlay({ minimized: Boolean(activeCallChannelId || localStream) });
  searchBtn.onclick = showSearchModal;
  pinBtn.onclick = showPinnedInfo;
  membersToggleBtn.onclick = toggleMembersPanel;
  mobileWorkspaceBtn.onclick = () => {
    const drawerTarget = isDmConversation() ? 'members' : 'channels';
    if (isDmConversation()) {
      activeSidebarTab = 'dm';
      renderSidebarTab();
    }
    setMobileView(mobileView === drawerTarget ? 'chat' : drawerTarget);
  };
  mobileNavButtons.forEach((button) => {
    button.onclick = () => {
      setMobileView(button.dataset.mobileTarget);
    };
  });
  membersTabBtn.onclick = () => {
    activeSidebarTab = 'members';
    renderAll();
  };
  dmTabBtn.onclick = () => {
    activeSidebarTab = 'dm';
    if (!activeDmUser) {
      activeDmUser = appState.users
        .filter((user) => user.username !== currentUser)
        .sort((a, b) => (getLastDmMessage(b.username)?.time || 0) - (getLastDmMessage(a.username)?.time || 0))[0]?.username || null;
    }
    if (activeDmUser) {
      openDm(activeDmUser);
    } else {
      renderAll();
    }
  };
  composerAddBtn.onclick = openQuickActions;
  navHomeBtn.onclick = () => handleNavAction('home');
  navChatBtn.onclick = () => handleNavAction('chat');
  navGameBtn.onclick = () => handleNavAction('game');
  navAppsBtn.onclick = () => handleNavAction('apps');

  presenceSelect.onchange = async () => {
    try {
      await request(API.presence, {
        method: 'POST',
        body: JSON.stringify({ username: currentUser, status: presenceSelect.value })
      });
      appState.presence[currentUser] = appState.presence[currentUser] || {};
      appState.presence[currentUser].status = presenceSelect.value;
      renderMembers();
    } catch (error) {
      alert(error.message);
    }
  };

  window.addEventListener('resize', () => {
    renderMobileLayout();
    renderCallOverlay();
  });

  callOverlay.onclick = (event) => {
    if (event.target === callOverlay) {
      closeCallOverlay({ minimized: Boolean(activeCallChannelId || localStream) });
    }
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && callOverlayOpen) {
      closeCallOverlay({ minimized: Boolean(activeCallChannelId || localStream) });
    }
  });
};
