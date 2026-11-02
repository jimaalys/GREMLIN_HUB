// Gremlin Den: tiny real-time server for lobby presence, rooms,
// WebRTC signaling, chat, watch-together sync and a shared scroll feed.
// Everything lives in memory; restart the server and the den resets.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim(); // optional "squad code"
const MAX_ROOM_SIZE = 8; // screenshare mesh gets heavy past this

// STUN servers are public, so they are safe to hand to anyone.
// TURN (relay) costs money, so it is never sent to anonymous visitors and never uses a permanent password.
// Relay is enabled only when BOTH of these are set:
//   TURN_URL     comma-separated turn:/turns: addresses of your coturn server
//   TURN_SECRET  coturn's `static-auth-secret`. It stays on this server; clients only ever
//                receive short-lived credentials derived from it.
// If either is missing, everyone gets STUN only (direct connections, no relay).
const STUN_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const TURN_URLS = (process.env.TURN_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL = Number(process.env.TURN_TTL) > 0 ? Number(process.env.TURN_TTL) : 12 * 60 * 60; // seconds a credential stays valid

// Built per connected user, only after the squad code has been checked.
function iceServersFor(user) {
  const servers = [...STUN_SERVERS];
  if (!TURN_URLS.length || !TURN_SECRET) return servers;
  // coturn "TURN REST API" scheme: username = expiry:id, credential = base64(HMAC-SHA1(secret, username))
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${user.id}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  servers.push({ urls: TURN_URLS, username, credential });
  return servers;
}

// ---------- accounts (optional) ----------
// Accounts use Supabase Auth. They switch on only when BOTH of these are set (both are PUBLIC values):
//   SUPABASE_URL              e.g. https://abcd1234.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  the "publishable" (anon) key. NEVER a secret / service_role key.
// Without them VYRA behaves exactly as before (guests only).
//   ALLOW_GUESTS=false        optional: once accounts are on, require an account to enter.
// The server never stores or forwards emails or tokens: it checks the token with Supabase, reads the
// signed-in person's own profile (under their own permissions), and keeps only the safe public fields.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
function looksSecret(key) {
  if (/^sb_secret_/i.test(key)) return true;
  try { return JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role === 'service_role'; } catch { return false; }
}
const URL_OK = /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(SUPABASE_URL);
let AUTH_ENABLED = URL_OK && SUPABASE_KEY.length > 10 && !looksSecret(SUPABASE_KEY);
if (SUPABASE_KEY && looksSecret(SUPABASE_KEY)) console.warn('SUPABASE_PUBLISHABLE_KEY looks like a SECRET key. Accounts are switched off. Use the publishable key instead.');
else if ((SUPABASE_URL || SUPABASE_KEY) && !AUTH_ENABLED) console.warn('Supabase settings are incomplete or invalid. Accounts are switched off.');
const ALLOW_GUESTS = String(process.env.ALLOW_GUESTS || 'true').toLowerCase() !== 'false';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODES = ['online', 'idle', 'dnd', 'invisible'];
let verifying = 0;
const supaGet = (p, token) => fetch(SUPABASE_URL + p, {
  headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, Accept: 'application/json' },
  signal: AbortSignal.timeout(6000)
});

// Returns { uid, profile } for a valid token, or { error } ('token' | 'profile' | 'unavailable' | 'busy').
async function loadAccount(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return { error: 'token' };
  if (verifying >= 25) return { error: 'busy' };
  verifying++;
  try {
    const ur = await supaGet('/auth/v1/user', token);
    if (!ur.ok) return { error: ur.status === 401 || ur.status === 403 ? 'token' : 'unavailable' };
    const au = await ur.json();
    const uid = String((au && au.id) || '').toLowerCase();
    if (!UUID_RE.test(uid)) return { error: 'token' };
    // From here on only `uid` is used. The email address in `au` is never read, stored, logged or sent.
    const pr = await supaGet(`/rest/v1/profiles?id=eq.${uid}&select=username,display_name,avatar,avatar_url,accent_color,status,updated_at&limit=1`, token);
    if (!pr.ok) return { error: 'unavailable' };
    const rows = await pr.json();
    const p = Array.isArray(rows) ? rows[0] : null;
    if (!p || !/^[a-z0-9_]{3,20}$/.test(String(p.username || ''))) return { uid, error: 'profile' };
    const ver = Math.max(0, Date.parse(p.updated_at) || 0);
    return {
      uid,
      profile: {
        name: clean(p.display_name, 30) || p.username,
        avatar: clean(p.avatar, 8) || '👾',
        color: /^#[0-9a-f]{6}$/i.test(p.accent_color || '') ? p.accent_color : '#7c5cff',
        // only the person's own folder is ever accepted, and the version makes replaced pictures refresh
        img: p.avatar_url === `${uid}/profile.webp` ? `${p.avatar_url}?v=${ver}` : '',
        mode: MODES.includes(p.status) ? p.status : (p.status === 'offline' ? 'invisible' : 'online')
      }
    };
  } catch { return { error: 'unavailable' }; } finally { verifying--; }
}

// Everything lives in one flat folder, so only these files are ever served.
const STATIC_FILES = new Set([
  'index.html', 'style.css', 'app.js', 'auth.js', 'account.js', 'sw.js', 'manifest.webmanifest', 'icon.svg',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png'
};

// Minimal static file server (no framework needed).
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }

  if (pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const cfg = { needsCode: !!ACCESS_CODE };
    // The Supabase URL and PUBLISHABLE key are public by design. No secret ever goes here.
    if (AUTH_ENABLED) Object.assign(cfg, { auth: true, guests: ALLOW_GUESTS, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY });
    return res.end(JSON.stringify(cfg)); // nothing secret: this is served before login
  }
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!STATIC_FILES.has(name)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(__dirname, name);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...(name === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

let nextUserId = 1;
let nextLfgId = 1;
const users = new Map(); // id -> { id, ws, name, avatar, color, playing, room, img, guest, mode, uid }
const byUid = new Map(); // account uid -> user (one live connection per account)
const rooms = new Map(); // name -> { name, members:Set, watch, feed:[], nextPost }
let lfg = [];

const REACTIONS = ['💀', '😭', '🔥', '🫠', '👀', '🤡'];
const CHAOS_PROMPTS = [
  'Hot take: cereal is a soup. Defend or deny.',
  'Rank your last 3 rage quits from most to least justified.',
  'What game would you delete from existence and why?',
  'Describe your gaming setup using only lies.',
  'Worst teammate you ever had. Go.',
  'You can only play one game for the rest of your life. Pick it. No take-backs.',
  'Post the most unhinged thing in your search history that you are willing to admit.',
  'Which friend here would survive longest in a horror game? Which would die first?',
  'Confess: what is your most embarrassing in-game moment?',
  'Pitch a terrible movie we should all watch together.',
  'Snack tier list. Controversy encouraged.',
  'What is the dumbest way you have ever lost a match?'
];

// ---------- helpers ----------
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const slug = (s) => clean(s, 30).toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
const isHttpUrl = (s) => /^https?:\/\/[^\s]{3,500}$/i.test(s);
const isImageUrl = (s) => isHttpUrl(s) && /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i.test(s);

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function pub(u) {
  // `img` and `guest` are additive fields; older clients simply ignore them. Never includes email or uid.
  return { id: u.id, name: u.name, avatar: u.avatar, color: u.color, playing: u.playing, room: u.room, img: u.img || '', guest: !!u.guest, mode: u.mode === 'invisible' ? 'online' : (u.mode || 'online') };
}
function sendToRoom(room, msg, exceptId) {
  for (const id of room.members) {
    if (id === exceptId) continue;
    const u = users.get(id);
    if (u) send(u.ws, msg);
  }
}
function watchNow(room) {
  const w = room.watch;
  const time = w.playing ? w.time + (Date.now() - w.at) / 1000 : w.time;
  return { url: w.url, playing: w.playing, time };
}
function lobbyState() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  lfg = lfg.filter((p) => p.ts > cutoff);
  return {
    t: 'lobby',
    users: [...users.values()].filter((u) => u.mode !== 'invisible').map(pub), // "invisible" accounts stay out of the lurker list
    rooms: [...rooms.values()].map((r) => ({
      name: r.name,
      count: r.members.size,
      // faces on a room card: "invisible" accounts are left out (the head-count still includes them, without saying who)
      members: [...r.members].map((id) => users.get(id)).filter((u) => u && u.mode !== 'invisible').map((u) => ({ avatar: u.avatar, name: u.name, color: u.color, img: u.img || '' })),
      watching: !!r.watch.url
    })),
    lfg
  };
}
function broadcastLobby() {
  const state = lobbyState();
  for (const u of users.values()) send(u.ws, state);
}

function leaveRoom(user) {
  if (!user.room) return;
  const room = rooms.get(user.room);
  user.room = null;
  if (!room) return;
  room.members.delete(user.id);
  sendToRoom(room, { t: 'peer-leave', id: user.id, name: user.name });
  if (room.members.size === 0) rooms.delete(room.name);
}

function joinRoom(user, rawName) {
  const name = slug(rawName);
  if (!name) return send(user.ws, { t: 'error', message: 'Give the room a name first.' });
  if (user.room === name) return;
  let room = rooms.get(name);
  if (room && room.members.size >= MAX_ROOM_SIZE) {
    return send(user.ws, { t: 'error', message: `That room is full (${MAX_ROOM_SIZE} max).` });
  }
  leaveRoom(user);
  if (!room) {
    room = { name, members: new Set(), watch: { url: '', playing: false, time: 0, at: Date.now() }, feed: [], nextPost: 1 };
    rooms.set(name, room);
  }
  const peers = [...room.members].map((id) => users.get(id)).filter(Boolean).map(pub);
  room.members.add(user.id);
  user.room = name;
  send(user.ws, { t: 'joined', room: name, peers, watch: watchNow(room), feed: room.feed, ice: iceServersFor(user) });
  sendToRoom(room, { t: 'peer-join', user: pub(user) }, user.id);
}

function addPost(room, user, content, kindHint) {
  content = clean(content, 500);
  if (!content) return;
  let kind = 'text';
  if (isImageUrl(content)) kind = 'image';
  else if (isHttpUrl(content)) kind = 'link';
  const post = {
    id: room.nextPost++,
    by: user ? user.id : 0,
    name: user ? user.name : 'Gremlin Bot',
    avatar: user ? user.avatar : '🤖',
    color: user ? user.color : '#b6ff3b',
    img: user ? (user.img || '') : '',
    guest: !!(user && user.guest),
    kind: kindHint || kind,
    content,
    reacts: {},
    ts: Date.now()
  };
  room.feed.push(post);
  if (room.feed.length > 50) room.feed.shift();
  sendToRoom(room, { t: 'feed-post', post });
}

// ---------- socket handling ----------
wss.on('connection', (ws) => {
  let user = null;
  let busy = false; // true while a token is being checked with Supabase
  let tokens = 100;
  const refill = setInterval(() => { tokens = Math.min(100, tokens + 50); }, 1000);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  function register(f) {
    if (f.uid) { // one live connection per account: a newer sign-in replaces the older one
      const old = byUid.get(f.uid);
      if (old) { send(old.ws, { t: 'replaced' }); old.ws.close(); byUid.delete(f.uid); }
    }
    user = { id: nextUserId++, ws, ...f, playing: '', room: null };
    users.set(user.id, user);
    if (user.uid) byUid.set(user.uid, user);
    send(ws, { t: 'welcome', id: user.id, ice: iceServersFor(user), me: pub(user), account: !user.guest });
    broadcastLobby();
  }

  ws.on('message', (raw) => {
    if (--tokens < 0) return; // flood protection
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (user || busy) return;
      // 1) The shared squad code is checked first, for guests and accounts alike.
      if (ACCESS_CODE && clean(m.code, 100) !== ACCESS_CODE) {
        send(ws, { t: 'denied' });
        return ws.close();
      }
      // 2) Accounts: the browser sends only a token. Name, picture and color come from Supabase, never from the browser.
      if (typeof m.token === 'string' && m.token) {
        if (!AUTH_ENABLED) { send(ws, { t: 'auth-failed', reason: 'disabled' }); return ws.close(); }
        busy = true;
        loadAccount(m.token).then((acct) => {
          busy = false;
          if (ws.readyState !== 1) return;
          if (acct.error) { send(ws, { t: 'auth-failed', reason: acct.error }); return ws.close(); }
          register({ ...acct.profile, uid: acct.uid, guest: false });
        });
        return;
      }
      // 3) Guests: the original experience, clearly marked as guests.
      if (AUTH_ENABLED && !ALLOW_GUESTS) { send(ws, { t: 'auth-failed', reason: 'guests-off' }); return ws.close(); }
      register({
        name: clean(m.name, 20) || 'Mystery Gremlin',
        avatar: clean(m.avatar, 8) || '👾',
        color: /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : '#ff4fa3',
        img: '', mode: 'online', uid: null, guest: true
      });
      return;
    }
    if (!user) return;
    const room = user.room ? rooms.get(user.room) : null;

    switch (m.t) {
      case 'mode':
        if (MODES.includes(m.mode)) {
          user.mode = m.mode;
          if (m.mode === 'invisible') lfg = lfg.filter((p) => p.by !== user.id); // an earlier squad call would still show their name
          broadcastLobby();
        }
        break;
      case 'refresh': { // an account changed its profile: re-read it from Supabase using a fresh token
        if (user.guest || busy) break;
        busy = true;
        loadAccount(m.token).then((acct) => {
          busy = false;
          if (ws.readyState !== 1 || !users.has(user.id)) return;
          if (acct.error || acct.uid !== user.uid) return send(ws, { t: 'error', message: 'Could not refresh your profile. Please sign in again.' });
          const keepMode = user.mode;
          Object.assign(user, acct.profile, { mode: keepMode });
          send(ws, { t: 'me', me: pub(user) });
          const r = user.room ? rooms.get(user.room) : null;
          if (r) sendToRoom(r, { t: 'peer-update', user: pub(user) }, user.id);
          broadcastLobby();
        });
        break;
      }
      case 'status':
        user.playing = clean(m.playing, 40);
        broadcastLobby();
        break;
      case 'lfg': {
        const game = clean(m.game, 40);
        if (!game) break;
        // a squad call publishes your name in the lobby, which is the opposite of being invisible
        if (user.mode === 'invisible') return send(ws, { t: 'error', message: 'You are invisible. Switch your status to Online to post a squad call.' });
        const id = nextLfgId++;
        const roomName = slug(`${game}-${id}`) || `squad-${id}`;
        lfg.push({
          id, by: user.id, name: user.name, avatar: user.avatar, img: user.img || '', guest: !!user.guest, game, note: clean(m.note, 80),
          room: roomName, ts: Date.now()
        });
        if (lfg.length > 15) lfg.shift();
        send(ws, { t: 'lfg-posted', room: roomName });
        broadcastLobby();
        break;
      }
      case 'join':
        joinRoom(user, m.room);
        broadcastLobby();
        break;
      case 'leave':
        leaveRoom(user);
        broadcastLobby();
        break;
      case 'signal': {
        if (!room) break;
        const target = users.get(Number(m.to));
        if (target && target.room === room.name) send(target.ws, { t: 'signal', from: user.id, data: m.data });
        break;
      }
      case 'sharing':
        if (room) sendToRoom(room, { t: 'sharing', from: user.id, on: !!m.on }, user.id);
        break;
      case 'chat': {
        const text = clean(m.text, 400);
        if (room && text) sendToRoom(room, { t: 'chat', from: user.id, name: user.name, avatar: user.avatar, color: user.color, img: user.img || '', guest: !!user.guest, text, ts: Date.now() });
        break;
      }
      case 'react': {
        const emoji = clean(m.emoji, 8);
        if (room && emoji) sendToRoom(room, { t: 'react', from: user.id, emoji });
        break;
      }
      case 'watch': {
        if (!room) break;
        const w = room.watch;
        const time = Number.isFinite(m.time) ? Math.max(0, m.time) : 0;
        if (m.action === 'load') {
          const url = clean(m.url, 500);
          if (!isHttpUrl(url)) return send(ws, { t: 'error', message: 'That does not look like a link.' });
          Object.assign(w, { url, playing: false, time: 0, at: Date.now() });
        } else if (m.action === 'play') {
          Object.assign(w, { playing: true, time, at: Date.now() });
        } else if (m.action === 'pause') {
          Object.assign(w, { playing: false, time, at: Date.now() });
        } else if (m.action === 'seek') {
          Object.assign(w, { time, at: Date.now() });
        } else if (m.action === 'stop') {
          Object.assign(w, { url: '', playing: false, time: 0, at: Date.now() });
        } else break;
        sendToRoom(room, { t: 'watch', action: m.action, by: user.name, state: watchNow(room) }, user.id);
        broadcastLobby();
        break;
      }
      case 'feed-post':
        if (room) addPost(room, user, m.content);
        break;
      case 'feed-prompt':
        if (room) addPost(room, null, CHAOS_PROMPTS[Math.floor(Math.random() * CHAOS_PROMPTS.length)], 'prompt');
        break;
      case 'feed-react': {
        if (!room || !REACTIONS.includes(m.emoji)) break;
        const post = room.feed.find((p) => p.id === m.postId);
        if (!post) break;
        post.reacts[m.emoji] = (post.reacts[m.emoji] || 0) + 1;
        sendToRoom(room, { t: 'feed-react', postId: post.id, emoji: m.emoji, reacts: post.reacts, from: user.id });
        break;
      }
      case 'spotlight':
        if (room) sendToRoom(room, { t: 'spotlight', postId: m.postId, by: user.name });
        break;
    }
  });

  ws.on('close', () => {
    clearInterval(refill);
    if (!user) return;
    leaveRoom(user);
    users.delete(user.id);
    if (user.uid && byUid.get(user.uid) === user) byUid.delete(user.uid);
    broadcastLobby();
  });
  ws.on('error', () => {});
});

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Gremlin Den is awake on http://localhost:${PORT}${ACCESS_CODE ? ' (squad code required)' : ''}`);
});
