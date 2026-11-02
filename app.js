'use strict';
// VYRA client: lobby, rooms, WebRTC voice + screenshare (mesh),
// synced watch-together, and a shared scroll feed.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Safe DOM builder: text always goes in as text, never as HTML.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}
const isHttp = (s) => /^https?:\/\//i.test(s);

const AVATARS = ['👾', '🦖', '🐸', '🦊', '🐙', '🧌', '🦄', '🐲', '🤖', '👻', '🍕', '🌮', '🐧', '🦝', '🧙', '🐝'];
const COLORS = ['#ff4fa3', '#b6ff3b', '#36e0ff', '#ff8a3d', '#7c5cff', '#ffd23f', '#ff6b6b', '#4dffb8'];
const ROOM_REACTS = ['😂', '💀', '🔥', '👏', '😭', '🤯', '🫡', '❤️'];
const FEED_REACTS = ['💀', '😭', '🔥', '🫠', '👀', '🤡'];
const ADJ = ['sneaky', 'cursed', 'spicy', 'soggy', 'feral', 'cozy', 'turbo', 'haunted', 'chaotic', 'crispy'];
const NOUN = ['waffle', 'goblin', 'couch', 'raccoon', 'pizza', 'lobby', 'noodle', 'gremlin', 'burrito', 'cave'];

const S = {
  ws: null, me: null, profile: null, config: { needsCode: false, ice: [{ urls: 'stun:stun.l.google.com:19302' }] },
  users: [], rooms: [], lfg: [],
  room: null, roomUsers: new Map(), peers: new Map(),
  mic: null, micOn: false, screen: null,
  pendingRoom: new URLSearchParams(location.search).get('room'),
  denied: false, activeTab: 'chat'
};

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
};

function show(name) {
  for (const s of $$('.screen')) s.classList.toggle('hidden', s.id !== `screen-${name}`);
  window.scrollTo(0, 0);
}
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
const tx = (m) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); };
const bubble = (u, extra = '') => el('span', { class: `bubble ${extra}`, style: `background:${/^#[0-9a-f]{6}$/i.test(u.color) ? u.color : '#fff'}`, text: u.avatar });

// =====================================================================
// LOGIN
// =====================================================================
// NOTE: the saved-settings keys below ('gremlin-profile', 'gremlin-status') keep their old names on purpose,
// so everyone's saved name, avatar, color and status carry over after the rebrand.
const profile = Object.assign({ name: '', avatar: AVATARS[0], color: COLORS[0] }, store.get('gremlin-profile'));

function buildLogin() {
  $('#login-name').value = profile.name;
  const ag = $('#avatar-grid');
  const cg = $('#color-grid');
  for (const a of AVATARS) {
    ag.append(el('button', {
      type: 'button', class: 'avatar-btn', text: a, 'aria-label': `Avatar ${a}`, 'aria-pressed': String(a === profile.avatar),
      onclick: () => { profile.avatar = a; $$('.avatar-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === a))); }
    }));
  }
  for (const c of COLORS) {
    cg.append(el('button', {
      type: 'button', class: 'swatch', style: `background:${c}`, 'aria-label': `Color ${c}`, 'aria-pressed': String(c === profile.color), 'data-c': c,
      onclick: () => { profile.color = c; $$('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === c))); }
    }));
  }
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    profile.name = $('#login-name').value.trim() || 'Mystery Wanderer';
    store.set('gremlin-profile', profile);
    connect($('#login-code').value);
  });
}

// =====================================================================
// SOCKET
// =====================================================================
function connect(code) {
  S.denied = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: profile.name, avatar: profile.avatar, color: profile.color, code }));
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    if (S.denied || ws !== S.ws) return;
    $('#overlay').classList.remove('hidden');
    teardownMedia();
  };
}

function handle(m) {
  switch (m.t) {
    case 'welcome':
      if (m.ice) S.config.ice = m.ice;
      S.me = { id: m.id, ...profile };
      renderMe();
      show('lobby');
      { const saved = store.get('gremlin-status'); if (saved) tx({ t: 'status', playing: saved }); }
      if (S.pendingRoom) { tx({ t: 'join', room: S.pendingRoom }); S.pendingRoom = null; }
      break;
    case 'denied':
      S.denied = true;
      toast('That squad code is not right.');
      break;
    case 'error': toast(m.message); break;
    case 'lobby':
      S.users = m.users; S.rooms = m.rooms; S.lfg = m.lfg;
      renderLobby();
      break;
    case 'lfg-posted': tx({ t: 'join', room: m.room }); break;
    case 'joined': enterRoom(m); break;
    case 'peer-join':
      S.roomUsers.set(m.user.id, m.user);
      makePeer(m.user);
      sys(`${m.user.name} joined`);
      renderPeople();
      break;
    case 'peer-leave': {
      const u = S.roomUsers.get(m.id);
      closePeer(m.id);
      S.roomUsers.delete(m.id);
      if (u) sys(`${u.name} left`);
      renderPeople();
      break;
    }
    case 'signal': onSignal(m.from, m.data); break;
    case 'sharing': if (!m.on) removeTile(m.from); break;
    case 'chat': addChat(m); break;
    case 'react': burst(m.emoji); break;
    case 'watch':
      if (m.action === 'load') { playerLoad(m.state.url, m.state); toast(`${m.by} queued up a video 🍿`); }
      else if (m.action === 'stop') { playerClear(); toast(`${m.by} stopped the video`); }
      else playerApply(m.state);
      break;
    case 'feed-post': addPostCard(m.post); if (S.activeTab !== 'scroll') ping('scroll'); break;
    case 'feed-react': updateReacts(m); break;
    case 'spotlight': onSpotlight(m); break;
  }
}

// =====================================================================
// LOBBY
// =====================================================================
function renderMe() {
  const chip = $('#me-chip');
  chip.replaceChildren(bubble(S.me), el('span', { text: S.me.name }));
}

function renderLobby() {
  $('#lurk-count').textContent = `(${S.users.length})`;
  $('#user-list').replaceChildren(...S.users.map((u) => el('li', { class: 'row' },
    bubble(u),
    el('div', { class: 'grow' },
      el('div', { class: 'name', text: u.name + (S.me && u.id === S.me.id ? ' (you)' : '') }),
      el('div', { class: 'sub', text: u.room ? `in #${u.room}` : (u.playing ? `playing ${u.playing}` : 'just vibing') }),
    ),
    u.playing && u.room ? el('span', { class: 'badge', text: u.playing }) : null
  )));

  $('#room-empty').classList.toggle('hidden', S.rooms.length > 0);
  $('#room-list').replaceChildren(...S.rooms.map((r) => el('li', { class: 'row' },
    el('div', { class: 'grow' },
      el('div', { class: 'name', text: `#${r.name}` }),
      el('div', { class: 'sub', text: `${r.count} in here` })
    ),
    el('span', { class: 'faces' }, r.members.slice(0, 5).map((m) => bubble(m))),
    r.watching ? el('span', { class: 'badge', text: '🍿 watching' }) : null,
    el('button', { class: 'btn tiny', text: 'Join', onclick: () => tx({ t: 'join', room: r.name }) })
  )));

  $('#lfg-empty').classList.toggle('hidden', S.lfg.length > 0);
  $('#lfg-list').replaceChildren(...[...S.lfg].reverse().map((p) => el('li', { class: 'row' },
    el('span', { class: 'bubble', text: p.avatar }),
    el('div', { class: 'grow' },
      el('div', { class: 'name', text: `${p.name} wants to play ${p.game}` }),
      el('div', { class: 'sub', text: p.note || 'no notes, just vibes' })
    ),
    el('button', { class: 'btn tiny', text: 'Hop in', onclick: () => tx({ t: 'join', room: p.room }) })
  )));
}

function buildLobby() {
  const status = $('#status-input');
  status.value = store.get('gremlin-status') || '';
  const sendStatus = () => { store.set('gremlin-status', status.value); tx({ t: 'status', playing: status.value }); };
  status.addEventListener('change', sendStatus);
  status.addEventListener('keydown', (e) => { if (e.key === 'Enter') status.blur(); });

  const randomRoom = () => `${ADJ[Math.floor(Math.random() * ADJ.length)]}-${NOUN[Math.floor(Math.random() * NOUN.length)]}`;
  $('#room-dice').addEventListener('click', () => { $('#room-name').value = randomRoom(); });
  $('#room-form').addEventListener('submit', (e) => {
    e.preventDefault();
    tx({ t: 'join', room: $('#room-name').value.trim() || randomRoom() });
    $('#room-name').value = '';
  });
  $('#lfg-form').addEventListener('submit', (e) => {
    e.preventDefault();
    tx({ t: 'lfg', game: $('#lfg-game').value, note: $('#lfg-note').value });
    $('#lfg-game').value = ''; $('#lfg-note').value = '';
  });
}

// =====================================================================
// ROOM
// =====================================================================
function enterRoom(m) {
  if (m.ice) S.config.ice = m.ice; // fresh TURN credentials on every room join
  S.room = m.room;
  S.roomUsers = new Map(m.peers.map((u) => [u.id, u]));
  S.roomUsers.set(S.me.id, S.me);
  $('#room-title').textContent = `#${m.room}`;
  $('#chat-log').replaceChildren();
  $('#feed-list').replaceChildren();
  $('#screens').replaceChildren();
  switchTab('chat');
  show('room');
  try { history.replaceState(null, '', `?room=${encodeURIComponent(m.room)}`); } catch { /* ignore */ }
  sys(`You joined #${m.room}`);
  m.peers.forEach(makePeer);
  renderPeople();
  for (const p of m.feed) addPostCard(p);
  updateFeedEmpty();
  if (m.watch && m.watch.url) playerLoad(m.watch.url, m.watch);
  updateStageEmpty();
  updateControls();
}

function leaveRoom() {
  tx({ t: 'leave' });
  teardownMedia();
  S.room = null;
  S.roomUsers.clear();
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  show('lobby');
}

function teardownMedia() {
  for (const id of [...S.peers.keys()]) closePeer(id);
  if (S.mic) S.mic.getTracks().forEach((t) => t.stop());
  if (S.screen) S.screen.getTracks().forEach((t) => t.stop());
  S.mic = null; S.micOn = false; S.screen = null;
  for (const [, iv] of speakTimers) clearInterval(iv);
  speakTimers.clear();
  playerClear();
  $('#screens').replaceChildren();
  updateControls();
}

function renderPeople() {
  $('#people').replaceChildren(...[...S.roomUsers.values()].map((u) => {
    const chip = el('div', { class: 'chip', 'data-uid': u.id }, bubble(u), el('span', { text: u.name + (u.id === S.me.id ? ' (you)' : '') }));
    return chip;
  }));
}

function updateStageEmpty() {
  const hasTiles = $('#screens').children.length > 0;
  const hasWatch = !$('#watchStage').classList.contains('hidden');
  $('#stage-empty').classList.toggle('hidden', hasTiles || hasWatch);
}

function updateControls() {
  const mic = $('#mic-btn');
  $('span', mic).textContent = S.micOn ? 'Mic on' : 'Mic off';
  mic.classList.toggle('on', S.micOn);
  const sh = $('#share-btn');
  $('span', sh).textContent = S.screen ? 'Stop sharing' : 'Share screen';
  sh.classList.toggle('live', !!S.screen);
}

// ---------- tabs ----------
function switchTab(name) {
  S.activeTab = name;
  for (const t of $$('.tab')) { t.classList.toggle('active', t.dataset.tab === name); if (t.dataset.tab === name) t.classList.remove('ping'); }
  for (const p of $$('.panel')) p.classList.toggle('hidden', p.dataset.panel !== name);
  if (name === 'chat') { const l = $('#chat-log'); l.scrollTop = l.scrollHeight; }
}
function ping(tab) { const t = $(`.tab[data-tab="${tab}"]`); if (t && !t.classList.contains('active')) t.classList.add('ping'); }

// ---------- chat ----------
function addChat(m) {
  const mine = m.from === S.me.id;
  const log = $('#chat-log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  log.append(el('div', { class: `msg ${mine ? 'mine' : ''}` },
    bubble(m),
    el('div', { class: 'body' }, el('div', { class: 'who' }, el('span', { text: mine ? 'You' : m.name }), el('time', { text: new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })), el('div', { class: 'txt', text: m.text }))
  ));
  if (stick || mine) log.scrollTop = log.scrollHeight;
  if (!mine && S.activeTab !== 'chat') ping('chat');
}
function sys(text) {
  const log = $('#chat-log');
  log.append(el('div', { class: 'sys', text }));
  log.scrollTop = log.scrollHeight;
}

// ---------- reactions ----------
function burst(emoji) {
  const n = el('span', { class: 'burst', text: emoji });
  n.style.left = `${8 + Math.random() * 84}%`;
  n.style.setProperty('--dx', `${Math.round(Math.random() * 120 - 60)}px`);
  $('#burst').append(n);
  setTimeout(() => n.remove(), 2300);
}

// =====================================================================
// WEBRTC (mesh: every person connects to every other person)
// =====================================================================
const speakTimers = new Map();
let audioCtx = null;

function sendSignal(to, data) { tx({ t: 'signal', to, data }); }

function makePeer(user) {
  if (S.peers.has(user.id) || user.id === S.me.id) return S.peers.get(user.id);
  const pc = new RTCPeerConnection({ iceServers: S.config.ice });
  const peer = {
    id: user.id, user, pc,
    polite: S.me.id > user.id, // deterministic tie-break for "perfect negotiation"
    makingOffer: false, ignoreOffer: false,
    micSenders: [], screenSenders: [], audioEl: null
  };
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal(user.id, { candidate: e.candidate }); };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(user.id, { description: pc.localDescription });
    } catch (err) { console.warn('negotiation failed', err); }
    finally { peer.makingOffer = false; }
  };
  pc.ontrack = (e) => onRemoteTrack(peer, e);
  // If a connection ever drops hard, try to find a new network path automatically.
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch { /* old browser */ } }
  };
  S.peers.set(user.id, peer);
  // If we're already talking or sharing, give the newcomer our tracks.
  if (S.mic) addMicTracks(peer);
  if (S.screen) addScreenTracks(peer);
  return peer;
}

function closePeer(id) {
  const peer = S.peers.get(id);
  if (!peer) return;
  try { peer.pc.close(); } catch { /* ignore */ }
  if (peer.audioEl) peer.audioEl.remove();
  const iv = speakTimers.get(id);
  if (iv) { clearInterval(iv); speakTimers.delete(id); }
  removeTile(id);
  S.peers.delete(id);
}

async function onSignal(from, data) {
  let peer = S.peers.get(from);
  if (!peer) {
    const u = S.roomUsers.get(from);
    if (!u) return;
    peer = makePeer(u);
  }
  const pc = peer.pc;
  try {
    if (data.description) {
      const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal(from, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); }
      catch (err) { if (!peer.ignoreOffer) throw err; }
    }
  } catch (err) { console.warn('signal error', err); }
}

function onRemoteTrack(peer, e) {
  const stream = e.streams[0] || new MediaStream([e.track]);
  if (stream.getVideoTracks().length > 0) {
    // A screenshare (its audio, if any, plays through the video element).
    if (e.track.kind === 'video') {
      addTile(peer.id, stream, `${peer.user.name}'s screen`, false);
      stream.onremovetrack = () => { if (stream.getVideoTracks().length === 0) removeTile(peer.id); };
    }
    return;
  }
  // Voice.
  if (!peer.audioEl) {
    peer.audioEl = el('audio', { autoplay: true });
    $('#voices').append(peer.audioEl);
  }
  peer.audioEl.srcObject = stream;
  peer.audioEl.play().catch(() => {});
  watchSpeaking(stream, peer.id);
}

function addMicTracks(peer) {
  if (!S.mic || peer.micSenders.length) return;
  peer.micSenders = S.mic.getTracks().map((t) => peer.pc.addTrack(t, S.mic));
}
function addScreenTracks(peer) {
  if (!S.screen || peer.screenSenders.length) return;
  peer.screenSenders = S.screen.getTracks().map((t) => peer.pc.addTrack(t, S.screen));
}

async function toggleMic() {
  if (!S.mic) {
    try {
      S.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      toast('Could not get your mic. Check browser permissions.');
      return;
    }
    S.micOn = true;
    S.peers.forEach(addMicTracks);
    watchSpeaking(S.mic, S.me.id);
  } else {
    S.micOn = !S.micOn;
    S.mic.getAudioTracks().forEach((t) => { t.enabled = S.micOn; });
  }
  updateControls();
}

async function toggleShare() {
  if (S.screen) return stopShare();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('Screen sharing needs a desktop browser (and HTTPS).');
    return;
  }
  try {
    S.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch {
    toast('Screen share cancelled.');
    return;
  }
  const vt = S.screen.getVideoTracks()[0];
  if (vt) vt.addEventListener('ended', stopShare);
  S.peers.forEach(addScreenTracks);
  addTile(S.me.id, S.screen, 'You (sharing)', true);
  tx({ t: 'sharing', on: true });
  updateControls();
}

function stopShare() {
  if (!S.screen) return;
  S.screen.getTracks().forEach((t) => t.stop());
  S.screen = null;
  S.peers.forEach((p) => {
    p.screenSenders.forEach((s) => { try { p.pc.removeTrack(s); } catch { /* ignore */ } });
    p.screenSenders = [];
  });
  removeTile(S.me.id);
  tx({ t: 'sharing', on: false });
  updateControls();
}

function addTile(peerId, stream, label, local) {
  removeTile(peerId);
  const v = el('video', { autoplay: true, playsinline: true });
  v.muted = !!local;
  v.srcObject = stream;
  const tile = el('div', { class: 'tile', 'data-peer': peerId },
    v,
    el('div', { class: 'tile-label', text: label }),
    el('button', { class: 'tile-fs', title: 'Fullscreen', 'aria-label': 'Fullscreen', text: '⛶', onclick: () => { if (v.requestFullscreen) v.requestFullscreen(); } })
  );
  $('#screens').append(tile);
  v.play().catch(() => {});
  updateStageEmpty();
}
function removeTile(peerId) {
  const t = $(`.tile[data-peer="${peerId}"]`);
  if (t) t.remove();
  updateStageEmpty();
}

// "Who's talking" glow using an analyser on each voice stream.
function watchSpeaking(stream, id) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const old = speakTimers.get(id);
    if (old) clearInterval(old);
    speakTimers.set(id, setInterval(() => {
      an.getByteFrequencyData(buf);
      let sum = 0;
      for (const b of buf) sum += b;
      const chip = $(`.chip[data-uid="${id}"]`);
      if (chip) chip.classList.toggle('speaking', sum / buf.length > 16);
    }, 150));
  } catch { /* speaking glow is optional */ }
}

// =====================================================================
// WATCH TOGETHER (YouTube + direct video files)
// =====================================================================
const Player = {
  kind: null, url: '', video: null, yt: null, ytReady: false, quiet: false, quietTimer: null, poll: null,
  lastT: 0, lastAt: 0, lastPlaying: false,
  ignore: { play: false, pause: false, seeked: false }, ignoreTimer: null
};

function ytId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}
function loadYTApi(cb) {
  if (window.YT && window.YT.Player) return cb();
  if (!loadYTApi.q) {
    loadYTApi.q = [];
    window.onYouTubeIframeAPIReady = () => loadYTApi.q.forEach((f) => f());
    document.head.append(el('script', { src: 'https://www.youtube.com/iframe_api' }));
  }
  loadYTApi.q.push(cb);
}
function quietly(fn) {
  Player.quiet = true;
  fn();
  clearTimeout(Player.quietTimer);
  Player.quietTimer = setTimeout(() => { Player.quiet = false; }, 700);
}

function playerClear() {
  clearInterval(Player.poll);
  if (Player.yt && Player.yt.destroy) { try { Player.yt.destroy(); } catch { /* ignore */ } }
  clearTimeout(Player.ignoreTimer);
  Object.assign(Player, { kind: null, url: '', video: null, yt: null, ytReady: false, poll: null, ignore: { play: false, pause: false, seeked: false } });
  $('#playerBox').replaceChildren();
  $('#watchStage').classList.add('hidden');
  updateStageEmpty();
}

function playerLoad(url, state) {
  playerClear();
  if (!isHttp(url)) return;
  Player.url = url;
  $('#watchStage').classList.remove('hidden');
  updateStageEmpty();
  const box = $('#playerBox');
  const id = ytId(url);

  if (id) {
    Player.kind = 'yt';
    box.append(el('div', { id: 'ytHolder' }));
    loadYTApi(() => {
      if (Player.url !== url) return; // someone loaded something else meanwhile
      Player.yt = new window.YT.Player('ytHolder', {
        videoId: id,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => { Player.ytReady = true; playerApply(state); },
          onStateChange: (e) => {
            if (Player.quiet) return;
            const t = Player.yt.getCurrentTime();
            if (e.data === 1) tx({ t: 'watch', action: 'play', time: t });
            else if (e.data === 2) tx({ t: 'watch', action: 'pause', time: t });
          }
        }
      });
    });
    // YouTube has no "seeked" event, so notice big jumps by polling.
    Player.poll = setInterval(() => {
      if (!Player.ytReady || Player.quiet) return;
      const t = Player.yt.getCurrentTime();
      const playing = Player.yt.getPlayerState() === 1;
      const expected = Player.lastT + (Player.lastPlaying ? (Date.now() - Player.lastAt) / 1000 : 0);
      if (Math.abs(t - expected) > 1.8) tx({ t: 'watch', action: 'seek', time: t });
      Player.lastT = t; Player.lastAt = Date.now(); Player.lastPlaying = playing;
    }, 500);
  } else {
    Player.kind = 'video';
    const v = el('video', { controls: true, playsinline: true, preload: 'auto', src: url });
    Player.video = v;
    v.addEventListener('loadedmetadata', () => playerApply(state));
    // Events we caused ourselves (while applying someone else's action) are swallowed
    // exactly once; anything else is the person really pressing a button.
    const own = (kind, action) => () => {
      if (Player.ignore[kind]) { Player.ignore[kind] = false; return; }
      tx({ t: 'watch', action, time: v.currentTime });
    };
    v.addEventListener('play', own('play', 'play'));
    v.addEventListener('pause', own('pause', 'pause'));
    v.addEventListener('seeked', own('seeked', 'seek'));
    v.addEventListener('error', () => toast("Couldn't load that video. It needs to be a direct .mp4/.webm link or YouTube."));
    box.append(v);
  }
}

function expectOwnEvents(flags) {
  Object.assign(Player.ignore, flags);
  clearTimeout(Player.ignoreTimer);
  // Safety net in case the browser never fires an event we expected.
  Player.ignoreTimer = setTimeout(() => { Player.ignore = { play: false, pause: false, seeked: false }; }, 2500);
}

function playerApply(s) {
  if (!s) return;
  if (Player.kind === 'video' && Player.video) {
    const v = Player.video;
    const needSeek = Math.abs(v.currentTime - s.time) > 0.7;
    const wasPaused = v.paused;
    expectOwnEvents({ seeked: needSeek, play: !!s.playing && wasPaused, pause: !s.playing && !wasPaused });
    if (needSeek) v.currentTime = s.time;
    if (s.playing) {
      v.play().catch(() => { Player.ignore.play = false; toast('Tap play to join the movie night 🍿'); });
    } else {
      v.pause();
    }
  } else if (Player.kind === 'yt' && Player.ytReady) {
    quietly(() => {
      const y = Player.yt;
      if (Math.abs(y.getCurrentTime() - s.time) > 0.7) y.seekTo(s.time, true);
      if (s.playing) y.playVideo(); else y.pauseVideo();
    });
  }
  Player.lastT = s.time; Player.lastAt = Date.now(); Player.lastPlaying = !!s.playing;
}

// =====================================================================
// SCROLL FEED
// =====================================================================
function postCard(p) {
  let body;
  if (p.kind === 'image' && isHttp(p.content)) body = el('img', { class: 'post-img', src: p.content, alt: 'Shared image', referrerpolicy: 'no-referrer', loading: 'lazy' });
  else if (p.kind === 'link' && isHttp(p.content)) body = el('a', { class: 'post-link', href: p.content, target: '_blank', rel: 'noopener noreferrer nofollow', text: p.content });
  else body = el('p', { class: `post-text ${p.kind === 'prompt' ? 'prompt' : ''}`, text: p.content });

  const reacts = el('div', { class: 'reacts' }, FEED_REACTS.map((emoji) => el('button', {
    class: 'rbtn', type: 'button', 'data-emoji': emoji, 'aria-label': `React ${emoji}`,
    onclick: () => tx({ t: 'feed-react', postId: p.id, emoji })
  }, emoji, el('span', { class: 'n', text: String((p.reacts && p.reacts[emoji]) || '') }))));

  return el('article', { class: 'post', id: `post-${p.id}` },
    el('div', { class: 'post-head' }, bubble(p), el('span', { text: p.name }),
      el('button', { class: 'spotbtn', type: 'button', title: 'Spotlight for everyone', 'aria-label': 'Spotlight for everyone', text: '📣', onclick: () => tx({ t: 'spotlight', postId: p.id }) })),
    body, reacts);
}
// Newest on top. History arrives oldest→newest, so prepending each one works for both.
function addPostCard(p) {
  $('#feed-list').prepend(postCard(p));
  updateFeedEmpty();
}
function updateFeedEmpty() { $('#feed-empty').classList.toggle('hidden', $('#feed-list').children.length > 0); }

function updateReacts(m) {
  const card = $(`#post-${m.postId}`);
  if (!card) return;
  for (const btn of $$('.rbtn', card)) {
    const n = m.reacts[btn.dataset.emoji];
    $('.n', btn).textContent = n ? String(n) : '';
  }
  const hit = $(`.rbtn[data-emoji="${m.emoji}"]`, card);
  if (hit) { hit.classList.remove('pop'); void hit.offsetWidth; hit.classList.add('pop'); }
}
function onSpotlight(m) {
  const card = $(`#post-${m.postId}`);
  if (!card) return;
  if (S.activeTab !== 'scroll') { switchTab('scroll'); }
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('spot'); void card.offsetWidth; card.classList.add('spot');
  toast(`${m.by} spotlighted a post 📣`);
}

// =====================================================================
// WIRING
// =====================================================================
function wireRoom() {
  $('#back-btn').addEventListener('click', leaveRoom);
  $('#mic-btn').addEventListener('click', toggleMic);
  $('#share-btn').addEventListener('click', toggleShare);
  $('#invite-btn').addEventListener('click', async () => {
    const link = `${location.origin}/?room=${encodeURIComponent(S.room)}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied. Throw it in the group chat.'); }
    catch { window.prompt('Copy this invite link:', link); }
  });
  $('#react-bar').replaceChildren(...ROOM_REACTS.map((emoji) => el('button', {
    class: 'react-btn', type: 'button', text: emoji, 'aria-label': `Send ${emoji}`,
    onclick: () => tx({ t: 'react', emoji })
  })));
  for (const t of $$('.tab')) t.addEventListener('click', () => switchTab(t.dataset.tab));

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const i = $('#chat-input');
    if (i.value.trim()) tx({ t: 'chat', text: i.value });
    i.value = '';
  });
  $('#watch-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#watch-url').value.trim();
    if (!isHttp(url)) return toast('Paste a full link starting with http(s)://');
    playerLoad(url, { playing: false, time: 0 });
    tx({ t: 'watch', action: 'load', url });
    $('#watch-url').value = '';
  });
  $('#watch-stop').addEventListener('click', () => { playerClear(); tx({ t: 'watch', action: 'stop' }); });
  $('#feed-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const i = $('#feed-input');
    if (i.value.trim()) tx({ t: 'feed-post', content: i.value });
    i.value = '';
  });
  $('#feed-chaos').addEventListener('click', () => tx({ t: 'feed-prompt' }));
}

// =====================================================================
// APP SHELL: bottom nav, installable app
// =====================================================================
function wireNav() {
  for (const b of $$('.nav-btn')) {
    b.addEventListener('click', () => {
      $('#screen-lobby').dataset.view = b.dataset.view;
      $$('.nav-btn').forEach((x) => x.classList.toggle('active', x === b));
      window.scrollTo(0, 0);
    });
  }
}

let installEvent = null;
function wireInstall() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  const btns = [$('#install-btn'), $('#install-btn-login')];
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    btns.forEach((b) => b.classList.remove('hidden'));
  });
  window.addEventListener('appinstalled', () => { installEvent = null; btns.forEach((b) => b.classList.add('hidden')); toast('Installed. Find VYRA on your home screen.'); });
  for (const b of btns) {
    b.addEventListener('click', async () => {
      if (!installEvent) return;
      installEvent.prompt();
      await installEvent.userChoice.catch(() => {});
      installEvent = null;
      btns.forEach((x) => x.classList.add('hidden'));
    });
  }
  // iPhones never fire the install event, so show how to do it by hand.
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) $('#ios-hint').classList.remove('hidden');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

async function init() {
  try {
    const res = await fetch('/config');
    const cfg = await res.json();
    S.config.needsCode = !!cfg.needsCode; // ICE servers arrive over the socket after login
  } catch { /* defaults are fine */ }
  $('#code-field').classList.toggle('hidden', !S.config.needsCode);
  buildLogin();
  buildLobby();
  wireRoom();
  wireNav();
  wireInstall();
}
init();
