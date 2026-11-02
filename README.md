# VYRA

**Find Your Somewhere.**

A mobile-first hangout app for friends who game, screenshare and doomscroll together. Open it in any browser, or install it to your phone's home screen like a regular app. (VYRA grew out of an earlier project called Gremlin Den.)

Its mascot is **The Wanderer**, a small hooded shadow creature with glowing lime eyes and a glowing V on its hood.

- **Lobby**: see who's online and what they're playing, post a "squad up" call (it opens a room for you)
- **Rooms**: voice chat + screenshare (with sound), chat, floating emoji reactions, speaking glow
- **Watch together**: paste a YouTube link or direct .mp4/.webm and play / pause / seek stay in sync for everyone (late joiners land on the right second)
- **Scroll**: a shared feed. Drop links, images or hot takes, react live (💀😭🔥), spotlight a post for the whole room, or roll a random chaos prompt
- **Invite links**: `?room=name` drops friends straight into a room

## Install it as an app

VYRA is a web app that can be installed, so there is no app store.

- **Android (Chrome or Samsung Internet):** open the site, tap **Install** when it appears (or the browser menu, then **Install app** / **Add to Home screen**).
- **iPhone / iPad:** open the site in **Safari**, tap **Share**, then **Add to Home Screen**.
- **Computer (Chrome or Edge):** click the install icon at the right end of the address bar.

If the home-screen icon doesn't change after an update, remove the installed app and install it again.

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
| `TURN_URL` and `TURN_SECRET` | Optional TURN relay for friends behind strict networks (some school/work Wi-Fi, some mobile carriers) where direct connections fail. **Both must be set**, otherwise everyone just uses public STUN servers. `TURN_URL` can be comma-separated, e.g. `turn:turn.example.com:3478`. `TURN_SECRET` is your coturn server's `static-auth-secret` (with `use-auth-secret` turned on). |
| `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` | Optional. Turns on **accounts** (see below). Both are public values from your Supabase project. **Never** put a secret or `service_role` key here: if one is detected, accounts stay off and nothing is sent to browsers. Leave both unset and VYRA works as guests-only, exactly as before. |
| `ALLOW_GUESTS` | Optional, default `true`. Set to `false` (only meaningful once accounts are on) to require an account to enter. |
| `TURN_TTL` | Optional. How many seconds a relay credential stays valid (default 43200, which is 12 hours). |

**How relay credentials stay private:** the server never sends the TURN secret to anyone. After someone enters the squad code, it creates a short-lived username and password from the secret and sends only those. The public `/config` page reveals only whether a squad code is needed. There is no setting for a permanent TURN username and password.

## Accounts (optional)

With Supabase configured, people can create an account (email + password, with email confirmation), pick a unique username, a display name, an accent color, an emoji avatar **or** an uploaded profile picture, and a status (online / idle / do not disturb / invisible). Guests can still enter and are tagged "guest".

- **Signing in to the app:** the browser sends only a sign-in token. The server checks it with Supabase and takes name, picture and color from the account, never from the browser. Emails and tokens are never shared with other people.
- **Squad code:** if `ACCESS_CODE` is set, it is still required for everyone, accounts and guests alike.
- **Profile pictures** are cropped to a square and converted to WebP in the browser (which also drops hidden photo data), then stored in the public `avatars` bucket as `{account-id}/profile.webp`. They are **public**.
- **No extra libraries:** `auth.js` talks to Supabase's public web endpoints directly.
- **Database:** the Phase 2 release includes `001-verify-existing-supabase.sql` (read-only checks) and `002-proposed-migrations.sql` (proposals, to be reviewed before running). They are not part of the website files.

## Good to know

- **Size**: every person connects directly to every other person (mesh), so it's great for a friend group and gets heavy past ~5–6 people sharing video. Rooms are capped at 8.
- **Screenshare** needs a desktop browser. Phones can join, chat, talk, watch and scroll, but can't share their screen.
- **Netflix / Disney+ / etc.** block synced playback. Use *Share screen* for those and press play together.
- **Nothing about rooms is saved on the server.** Rooms, chat and feeds live in memory and vanish when the server restarts or a room empties.
- **Your own settings are saved on your device.** Your name, avatar, color and status are remembered in your browser's local storage (under the keys `gremlin-profile` and `gremlin-status`, which keep their old names on purpose so nobody's settings reset). A signed-in session is kept under `vyra-auth` (tokens only, no email).
- **YouTube sync** loads YouTube's player, so viewers need to be able to reach youtube.com. Some videos disable embedding and won't load.

## Files

```
server.js                  WebSocket server: presence, rooms, WebRTC signaling, watch sync, feed, account check
index.html                 the page
style.css                  the look (VYRA colors, layout, embedded wordmark font)
app.js                     the client
auth.js                    account client (sign up/in/out, reset, profile, pictures), no dependencies
account.js                 account screens: sign-in, profile setup, photo crop
manifest.webmanifest       tells phones the app's name, colors and icons
sw.js                      service worker: lets the app install and open quickly
icon.svg                   browser tab icon
icon-192.png, icon-512.png            app icons
icon-maskable-512.png      Android icon that survives round / squircle cropping
apple-touch-icon.png       iPhone / iPad home-screen icon
THIRD_PARTY_LICENSES.md    font and library credits
```

`server.js` only serves the files named in its list, so a new file the page needs also has to be added to that list.

## Brand colors

| Name | Hex | Used for |
|---|---|---|
| Midnight | `#120D26` | main background |
| Deep purple | `#261C48` | cards and panels |
| Purple | `#7C5CFF` | primary accent: buttons, active tabs, your chat bubbles |
| Lime | `#B6FF3B` | highlights: speaking glow, live mic, The Wanderer's eyes |
| Pink | `#FF4FA3` | notification dots, sharing state |
| Cyan | `#36E0FF` | links, focus rings, watch-together panel |

## Credits and licenses

The VYRA wordmark uses the Michroma typeface (SIL Open Font License 1.1). See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for the copyright notice and the full license text.
