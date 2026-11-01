# 👾 Gremlin Den

A chaotic little hangout app for friends who game, screenshare and doomscroll together.

- **Lobby**: see who's online and what they're playing, post a "squad up" call (it opens a room for you)
- **Rooms**: voice chat + screenshare (with sound), chat, floating emoji reactions, speaking glow
- **Watch together**: paste a YouTube link or direct .mp4/.webm and play / pause / seek stay in sync for everyone (late joiners land on the right second)
- **Scroll**: a shared feed. Drop links, images or hot takes, react live (💀😭🔥), spotlight a post for the whole room, or roll a random chaos prompt
- **Invite links**: `?room=name` drops friends straight into a room

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Needs Node 18+. One dependency (`ws`).

## Get your friends in

Screenshare and mic only work on **HTTPS** (or localhost), so you can't just share your home IP. Easiest options:

1. **Quick tunnel** (runs on your computer while you play):
   `cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`) and send the https link to your friends.
2. **Deploy it** to anything that runs a Node app and gives you HTTPS (Render, Railway, Fly.io…). Start command: `npm start`. It reads `PORT` from the environment.

### Settings (environment variables)

| Variable | What it does |
|---|---|
| `ACCESS_CODE` | A "squad code" friends must type to enter. **Set this if the URL is public**, otherwise anyone who finds it can join. |
| `PORT` | Port to listen on (default 3000). |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | Optional TURN relay for friends behind strict networks (some school/work Wi-Fi, some mobile carriers) where direct connections fail. `TURN_URL` can be comma-separated, e.g. `turn:turn.example.com:3478`. |

## Good to know

- **Size**: every person connects directly to every other person (mesh), so it's great for a friend group and gets heavy past ~5–6 people sharing video. Rooms are capped at 8.
- **Screenshare** needs a desktop browser. Phones can join, chat, talk, watch and scroll, but can't share their screen.
- **Netflix / Disney+ / etc.** block synced playback. Use *Share screen* for those and press play together.
- **Nothing is saved.** Rooms, chat and feeds live in memory and vanish when the server restarts or a room empties.
- **YouTube sync** loads YouTube's player, so viewers need to be able to reach youtube.com. Some videos disable embedding and won't load.

## Files

```
server.js    WebSocket server: presence, rooms, WebRTC signaling, watch sync, feed
index.html   the page
style.css    the look
app.js       the client
```
