// Gremlin Den: tiny real-time server for lobby presence, rooms,
// WebRTC signaling, chat, watch-together sync and a shared scroll feed.
// Everything lives in memory; restart the server and the den resets.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim(); // optional "squad code"
const MAX_ROOM_SIZE = 8; // screenshare mesh gets heavy past this

// STUN is enough for most home networks. If some friends can't connect
// (strict NATs, school/work Wi-Fi), add a TURN relay via env vars.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
    username: process.env.TURN_USER || '',
    credential: process.env.TURN_PASS || ''
  });
}

// Everything lives in one flat folder, so only these files are ever served.
const STATIC_FILES = new Set(['index.html', 'style.css', 'app.js']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
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
    return res.end(JSON.stringify({ needsCode: !!ACCESS_CODE, ice: ICE_SERVERS }));
  }
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!STATIC_FILES.has(name)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(__dirname, name);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

let nextUserId = 1;
let nextLfgId = 1;
const users = new Map(); // id -> { id, ws, name, avatar, color, playing, room }
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
  return { id: u.id, name: u.name, avatar: u.avatar, color: u.color, playing: u.playing, room: u.room };
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
    users: [...users.values()].map(pub),
    rooms: [...rooms.values()].map((r) => ({
      name: r.name,
      count: r.members.size,
      members: [...r.members].map((id) => users.get(id)).filter(Boolean).map((u) => ({ avatar: u.avatar, name: u.name })),
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
  send(user.ws, { t: 'joined', room: name, peers, watch: watchNow(room), feed: room.feed });
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
  let tokens = 100;
  const refill = setInterval(() => { tokens = Math.min(100, tokens + 50); }, 1000);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (--tokens < 0) return; // flood protection
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (user) return;
      if (ACCESS_CODE && clean(m.code, 100) !== ACCESS_CODE) {
        send(ws, { t: 'denied' });
        return ws.close();
      }
      const name = clean(m.name, 20) || 'Mystery Gremlin';
      const color = /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : '#ff4fa3';
      user = { id: nextUserId++, ws, name, avatar: clean(m.avatar, 8) || '👾', color, playing: '', room: null };
      users.set(user.id, user);
      send(ws, { t: 'welcome', id: user.id });
      broadcastLobby();
      return;
    }
    if (!user) return;
    const room = user.room ? rooms.get(user.room) : null;

    switch (m.t) {
      case 'status':
        user.playing = clean(m.playing, 40);
        broadcastLobby();
        break;
      case 'lfg': {
        const game = clean(m.game, 40);
        if (!game) break;
        const id = nextLfgId++;
        const roomName = slug(`${game}-${id}`) || `squad-${id}`;
        lfg.push({
          id, name: user.name, avatar: user.avatar, game, note: clean(m.note, 80),
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
        if (room && text) sendToRoom(room, { t: 'chat', from: user.id, name: user.name, avatar: user.avatar, color: user.color, text, ts: Date.now() });
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
