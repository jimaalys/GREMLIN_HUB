'use strict';
// VYRA accounts UI: sign up / sign in / reset password, profile setup and editing, and profile-picture cropping.
// Loaded after app.js (it uses app.js helpers such as show(), toast(), el(), bubble(), connect()).
// Everything here is optional: it starts only when the server reports that Supabase accounts are on.

(function () {
  const A = window.VyraAuth;
  const Account = { profile: null };
  window.Account = Account;

  let pendingEmail = '';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const USER_RE = /^[a-z0-9_]{3,20}$/;
  const redirectTo = () => `${location.origin}/${S.pendingRoom ? `?room=${encodeURIComponent(S.pendingRoom)}` : ''}`;

  const say = (id, text, kind) => { const n = $(id); if (!n) return; n.textContent = text || ''; n.className = `form-msg${text ? ` ${kind || 'bad'}` : ''}`; };
  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const imgOf = (p) => (p && p.avatar_url && A.uid && p.avatar_url === `${A.uid}/profile.webp` ? `${p.avatar_url}?v=${Math.max(0, Date.parse(p.updated_at) || 0)}` : '');
  const asUser = (p) => ({ avatar: p.avatar || '👾', color: p.accent_color || '#7c5cff', img: imgOf(p) });

  // =====================================================================
  // START + ROUTING
  // =====================================================================
  Account.start = async function () {
    const info = A.init(S.config);
    wire();
    A.on((ev) => {
      if (ev === 'expired') onExpired();
      else if (ev === 'signed-out') { toast('You signed out in another tab.'); if (!S.ws || S.ws.readyState !== 1) show('start'); }
    });
    $('#start-guest').classList.toggle('hidden', S.config.guests === false);
    addGuestBackLink();
    if (info.linkType === 'recovery') return show('newpass');
    if (info.linkError) toast('That email link expired or was already used. Request a new one.');
    if (A.signedIn) return afterSignIn(info.linkType ? 'Email confirmed. Welcome to VYRA!' : '');
    show(info.linkError ? 'signin' : 'start');
  };

  function addGuestBackLink() {
    if ($('#guest-to-account')) return;
    const b = el('button', { id: 'guest-to-account', class: 'link-btn', type: 'button', text: 'Have an account? Sign in', onclick: () => show(A.signedIn ? 'home' : 'start') });
    $('#install-btn-login').before(b);
  }

  async function afterSignIn(note, attempt = 0) {
    let prof = null;
    try { prof = await A.getProfile(); } catch (e) {
      if (!A.signedIn) return show('signin'); // the session was just cleared (the "expired" notice is already showing)
      if (e.status === 401 || e.code === 'no_session') { toast('Your session ended. Please sign in again.'); return show('signin'); }
      toast(A.friendly(e)); return show('signin');
    }
    if (!prof) { // the profile row is created automatically after email confirmation; give it a moment
      if (attempt < 4) { await new Promise((r) => setTimeout(r, 1200)); return afterSignIn(note, attempt + 1); }
      toast('We are still setting up your profile. Please try again in a minute.');
      return show('signin');
    }
    Account.profile = prof;
    if (note) toast(note);
    if (!prof.username) return openProfile(true);
    showHome();
  }

  function showHome(message) {
    const p = Account.profile;
    $('#home-avatar').replaceChildren(bubble(asUser(p), 'big'));
    $('#home-name').textContent = p.display_name || p.username;
    $('#home-user').textContent = `@${p.username}`;
    $('#home-code-field').classList.toggle('hidden', !S.config.needsCode);
    say('#home-msg', message);
    show('home');
  }

  Account.onAuthFailed = function (reason) {
    switch (reason) {
      case 'profile': toast('Finish your profile first.'); return openProfile(true);
      case 'unavailable': case 'busy': showHome('VYRA accounts are busy right now. Try again in a moment.'); return;
      case 'guests-off': toast('This VYRA needs an account.'); return show('start');
      case 'disabled': toast('Accounts are not available right now.'); return show('login');
      default: // 'token'
        A.signOut(); toast('Your session ended. Please sign in again.'); show('signin');
    }
  };

  function onExpired() {
    toast('Your sign-in expired. Please sign in again.');
    if (!S.ws || S.ws.readyState !== 1) show('signin'); // someone already in the lobby is not kicked out mid-call
  }

  async function signOutNow() {
    await A.signOut();
    location.replace('/'); // a clean reload closes the connection and any microphone or screen share
  }

  // =====================================================================
  // FORMS
  // =====================================================================
  function wire() {
    for (const b of $$('[data-go]')) b.addEventListener('click', () => show(b.dataset.go));
    $('#start-signin').onclick = () => show('signin');
    $('#start-signup').onclick = () => show('signup');
    $('#start-guest').onclick = () => show('login');
    $('#signin-forgot').onclick = () => { $('#forgot-email').value = $('#signin-email').value; say('#forgot-msg', ''); show('forgot'); };
    $('#signin-signup').onclick = () => show('signup');
    $('#signup-signin').onclick = () => show('signin');

    $('#signin-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('#signin-email').value.trim().toLowerCase();
      const pass = $('#signin-pass').value;
      if (!EMAIL_RE.test(email) || !pass) return say('#signin-msg', 'Enter your email and password.');
      say('#signin-msg', '');
      busy(e.submitter || $('#signin-form button[type=submit]'), async () => {
        try {
          await A.signIn(email, pass);
          $('#signin-pass').value = '';
          await afterSignIn();
        } catch (err) {
          if (err.code === 'email_not_confirmed') { pendingEmail = email; say('#check-msg', ''); show('check'); return; }
          say('#signin-msg', A.friendly(err));
        }
      });
    });

    $('#signup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('#signup-email').value.trim().toLowerCase();
      const pass = $('#signup-pass').value;
      if (!EMAIL_RE.test(email)) return say('#signup-msg', 'That email address does not look right.');
      if (pass.length < 10) return say('#signup-msg', 'Use at least 10 characters for your password.');
      say('#signup-msg', '');
      busy(e.submitter || $('#signup-form button[type=submit]'), async () => {
        try {
          const r = await A.signUp(email, pass, redirectTo());
          $('#signup-pass').value = '';
          if (r.signedIn) return afterSignIn();
          pendingEmail = email;
          say('#check-msg', '');
          $('#check-text').textContent = `We sent a link to ${email}. Open it on this phone to finish. It can take a minute, and it may land in spam.`;
          show('check');
        } catch (err) { say('#signup-msg', A.friendly(err)); }
      });
    });

    $('#check-resend').onclick = () => {
      if (!pendingEmail) return say('#check-msg', 'Sign in or create an account first.');
      busy($('#check-resend'), async () => {
        try { await A.resendConfirmation(pendingEmail, redirectTo()); say('#check-msg', 'Sent again. Give it a minute.', 'ok'); }
        catch (err) { say('#check-msg', A.friendly(err)); }
      });
    };

    $('#forgot-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('#forgot-email').value.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return say('#forgot-msg', 'That email address does not look right.');
      busy(e.submitter || $('#forgot-form button[type=submit]'), async () => {
        try { await A.sendReset(email, redirectTo()); } catch (err) {
          if (err.status === 0 || err.status === 429) return say('#forgot-msg', A.friendly(err));
          // anything else gets the same answer, so nobody can use this form to learn which emails have accounts
        }
        say('#forgot-msg', 'If that email has an account, a reset link is on its way.', 'ok');
      });
    });

    $('#newpass-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const pass = $('#newpass-pass').value;
      if (pass.length < 10) return say('#newpass-msg', 'Use at least 10 characters.');
      busy(e.submitter || $('#newpass-form button[type=submit]'), async () => {
        try { await A.setPassword(pass); $('#newpass-pass').value = ''; say('#newpass-msg', ''); await afterSignIn('Password updated.'); }
        catch (err) { say('#newpass-msg', A.friendly(err)); }
      });
    });

    $('#home-enter').onclick = () => busy($('#home-enter'), async () => {
      say('#home-msg', '');
      const token = await A.getToken().catch(() => null);
      if (!token) { toast('Your session ended. Please sign in again.'); return show('signin'); }
      connect($('#home-code').value, token);
    });
    $('#home-edit').onclick = () => openProfile(false);
    $('#home-signout').onclick = signOutNow;

    // tapping your own name in the lobby
    const chip = $('#me-chip');
    const chipAction = () => {
      if (S.account) openProfile(false, 'lobby');
      else if (confirm('Leave this room and sign in with an account?')) location.replace('/');
    };
    chip.addEventListener('click', chipAction);
    chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chipAction(); } });

    wireProfile();
  }

  // =====================================================================
  // PROFILE SETUP / EDIT
  // =====================================================================
  const P = { setup: false, back: 'home', kind: 'emoji', avatar: AVATARS[0], color: COLORS[4], avatarUrl: null, hasStored: false, blob: null, blobUrl: '', removeFile: false };

  function paintSelection() {
    for (const b of $$('#pf-avatar-grid .avatar-btn')) b.setAttribute('aria-pressed', String(b.textContent === P.avatar));
    for (const b of $$('#pf-color-grid .swatch')) b.setAttribute('aria-pressed', String(b.dataset.c.toLowerCase() === P.color.toLowerCase()));
    $('#seg-emoji').setAttribute('aria-selected', String(P.kind === 'emoji'));
    $('#seg-photo').setAttribute('aria-selected', String(P.kind === 'photo'));
    $('#pf-emoji-panel').classList.toggle('hidden', P.kind !== 'emoji');
    $('#pf-photo-panel').classList.toggle('hidden', P.kind !== 'photo');
    // preview bubble
    const prev = $('#pf-photo-preview');
    const color = P.color;
    let node;
    if (P.blobUrl) { node = el('span', { class: 'bubble big has-img', style: `background:${color}` }, el('img', { src: P.blobUrl, alt: '' })); }
    else if (P.avatarUrl && !P.removeFile) node = bubble({ avatar: P.avatar, color, img: `${P.avatarUrl}?v=${P.ver || 0}` }, 'big');
    else node = el('span', { class: 'bubble big', style: `background:${color}`, text: '📷' });
    prev.replaceChildren(node);
    const hasPhoto = !!(P.blobUrl || (P.avatarUrl && !P.removeFile) || (P.hasStored && !P.removeFile));
    $('#pf-photo-remove').classList.toggle('hidden', !hasPhoto);
    $('#pf-photo-choose').textContent = hasPhoto ? 'Replace photo' : 'Choose photo';
  }

  function suggestUsername(name) {
    const s = String(name || '').toLowerCase().replace(/[^a-z0-9_ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 20);
    return USER_RE.test(s) ? s : '';
  }

  async function openProfile(setup, back) {
    const p = Account.profile || {};
    const guestSaved = store.get('gremlin-profile') || {};
    P.setup = !!setup;
    P.back = back || (S.me && S.ws && S.ws.readyState === 1 ? 'lobby' : 'home');
    P.blob = null; if (P.blobUrl) URL.revokeObjectURL(P.blobUrl); P.blobUrl = ''; P.removeFile = false; P.hasStored = false;
    // first-time setup starts from what this device remembered about the old guest profile; later edits start from the account
    const fresh = !p.username;
    P.avatar = fresh && AVATARS.includes(guestSaved.avatar) ? guestSaved.avatar : (AVATARS.includes(p.avatar) ? p.avatar : AVATARS[0]);
    P.color = fresh && COLORS.includes(guestSaved.color) ? guestSaved.color : (/^#[0-9a-f]{6}$/i.test(p.accent_color || '') ? p.accent_color : '#7c5cff');
    P.avatarUrl = p.avatar_url && p.avatar_url === `${A.uid}/profile.webp` ? p.avatar_url : null;
    P.ver = Math.max(0, Date.parse(p.updated_at) || 0);
    P.kind = P.avatarUrl ? 'photo' : 'emoji';
    $('#profile-title').textContent = setup ? 'Finish your profile' : 'Edit profile';
    $('#pf-username').value = p.username || suggestUsername(guestSaved.name);
    $('#pf-name').value = p.display_name && p.display_name !== 'Wanderer' ? p.display_name : cleanName(guestSaved.name).slice(0, 30);
    $('#pf-status').value = ['online', 'idle', 'dnd', 'invisible'].includes(p.status) ? p.status : 'online';
    $('#pf-cancel').classList.toggle('hidden', !!setup);
    say('#pf-msg', ''); say('#pf-photo-msg', '');
    paintSelection();
    show('profile');
    if (!P.avatarUrl) A.avatarFileExists().then((yes) => { P.hasStored = yes; if ($('#screen-profile').classList.contains('hidden') === false) paintSelection(); });
  }

  function buildProfilePickers() {
    const ag = $('#pf-avatar-grid');
    for (const a of AVATARS) ag.append(el('button', { type: 'button', class: 'avatar-btn', text: a, 'aria-label': `Avatar ${a}`, onclick: () => { P.avatar = a; paintSelection(); } }));
    const cg = $('#pf-color-grid');
    for (const c of COLORS) cg.append(el('button', { type: 'button', class: 'swatch', style: `background:${c}`, 'aria-label': `Color ${c}`, 'data-c': c, onclick: () => { P.color = c; paintSelection(); } }));
  }

  function wireProfile() {
    buildProfilePickers();
    $('#seg-emoji').onclick = () => { P.kind = 'emoji'; paintSelection(); };
    $('#seg-photo').onclick = () => { P.kind = 'photo'; paintSelection(); };
    $('#pf-photo-choose').onclick = () => $('#pf-file').click();
    $('#pf-photo-remove').onclick = () => {
      P.blob = null; if (P.blobUrl) URL.revokeObjectURL(P.blobUrl); P.blobUrl = '';
      P.removeFile = true; P.kind = 'emoji';
      say('#pf-photo-msg', 'Photo removed. It is deleted when you tap Save.', 'ok');
      paintSelection();
    };
    $('#pf-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      say('#pf-photo-msg', '');
      try { await openCrop(f); } catch (err) { say('#pf-photo-msg', err.userMessage || 'We could not read that picture. Try a different one.'); }
    });
    $('#pf-username').addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); });
    $('#pf-cancel').onclick = () => { if (P.back === 'lobby') show('lobby'); else showHome(); };
    $('#pf-signout').onclick = signOutNow;
    $('#profile-form').addEventListener('submit', (e) => { e.preventDefault(); saveProfile(); });
  }

  async function saveProfile() {
    const btn = $('#pf-save');
    const username = $('#pf-username').value.trim().toLowerCase();
    const display = cleanName($('#pf-name').value).slice(0, 30);
    const status = $('#pf-status').value;
    if (!USER_RE.test(username)) return say('#pf-msg', 'Pick a username with 3 to 20 lowercase letters, numbers or underscores.');
    if (!display) return say('#pf-msg', 'Enter a display name.');
    if (P.kind === 'photo' && !(P.blob || P.avatarUrl || (P.hasStored && !P.removeFile))) return say('#pf-msg', 'Choose a photo first, or switch to Emoji.');
    say('#pf-msg', '');
    await busy(btn, async () => {
      try {
        const mine = Account.profile && Account.profile.username === username;
        if (!mine) { // friendly early check; the database still enforces uniqueness
          const token = await A.getToken();
          const r = await fetch(`${S.config.supabaseUrl}/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&select=id&limit=1`, { headers: { apikey: S.config.supabaseKey, Authorization: `Bearer ${token}` }, cache: 'no-store' });
          if (r.ok && (await r.json()).length) return say('#pf-msg', 'That username is already taken. Try another one.');
        }
        let avatarUrl = null;
        if (P.kind === 'photo') {
          if (P.blob) avatarUrl = await A.uploadAvatar(P.blob);
          else avatarUrl = A.avatarPath();
        }
        const row = await A.saveProfile({ username, display_name: display, avatar: P.avatar, avatar_url: avatarUrl, accent_color: P.color, status });
        if (P.removeFile && P.kind === 'emoji') { try { await A.removeAvatarFile(); } catch { toast('Saved, but the old photo could not be deleted. Try Remove photo again.'); } }
        Account.profile = row;
        // tell the live connection (if any) so everyone sees the new name, picture and status
        if (S.ws && S.ws.readyState === 1 && S.account) {
          tx({ t: 'mode', mode: row.status });
          const token = await A.getToken().catch(() => null);
          if (token) tx({ t: 'refresh', token });
        }
        toast(P.setup ? 'Profile saved. Welcome to VYRA!' : 'Profile saved.');
        if (P.back === 'lobby' && S.ws && S.ws.readyState === 1) show('lobby'); else showHome();
      } catch (err) {
        say('#pf-msg', A.friendly(err, 'profile'));
        if (err.status === 401 || err.code === 'no_session') show('signin');
      }
    });
  }

  // =====================================================================
  // PICTURE: choose -> crop to a square -> WebP
  // =====================================================================
  const C = { bmp: null, cx: 0, cy: 0, zoom: 1, drag: null };
  const CV = 320; // canvas pixels for the crop view
  const OUT = 512; // final picture size
  const fail = (msg) => Object.assign(new Error(msg), { userMessage: msg });

  function sniff(b) { // look at the file's first bytes, not its name or claimed type
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    return null;
  }
  async function decode(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* older browsers: try without options */ }
    return createImageBitmap(file);
  }
  async function openCrop(file) {
    if (file.size > 15 * 1024 * 1024) throw fail('That file is too big. Pick a picture under 15 MB.');
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!sniff(head)) throw fail('Please choose a JPEG, PNG or WebP picture.');
    let bmp;
    try { bmp = await decode(file); } catch { throw fail('We could not read that picture. Try a different one.'); }
    if (bmp.width < 64 || bmp.height < 64) throw fail('That picture is too small. Pick one at least 64 pixels wide.');
    if (bmp.width * bmp.height > 60e6) throw fail('That picture is too large to process on this device. Pick a smaller one.');
    C.bmp = bmp; C.cx = bmp.width / 2; C.cy = bmp.height / 2; C.zoom = 1;
    $('#crop-zoom').value = '1';
    say('#crop-msg', '');
    $('#crop').classList.remove('hidden');
    $('#crop-canvas').focus({ preventScroll: true });
    drawCrop();
  }
  const baseScale = () => CV / Math.min(C.bmp.width, C.bmp.height);
  function sourceRect() {
    const half = CV / (2 * baseScale() * C.zoom);
    C.cx = Math.min(Math.max(C.cx, half), C.bmp.width - half);
    C.cy = Math.min(Math.max(C.cy, half), C.bmp.height - half);
    return { sx: C.cx - half, sy: C.cy - half, size: half * 2 };
  }
  function drawCrop() {
    if (!C.bmp) return;
    const ctx = $('#crop-canvas').getContext('2d');
    const r = sourceRect();
    ctx.clearRect(0, 0, CV, CV);
    ctx.drawImage(C.bmp, r.sx, r.sy, r.size, r.size, 0, 0, CV, CV);
  }
  function closeCrop() { $('#crop').classList.add('hidden'); if (C.bmp && C.bmp.close) C.bmp.close(); C.bmp = null; }

  async function exportWebp() {
    const r = sourceRect();
    const out = document.createElement('canvas');
    out.width = out.height = OUT;
    out.getContext('2d').drawImage(C.bmp, r.sx, r.sy, r.size, r.size, 0, 0, OUT, OUT); // a fresh canvas carries no photo metadata
    for (const q of [0.88, 0.75, 0.6, 0.45]) {
      const blob = await new Promise((res) => out.toBlob(res, 'image/webp', q));
      if (!blob || blob.type !== 'image/webp') throw fail('This browser cannot make WebP pictures. Try Chrome or Samsung Internet.');
      if (blob.size <= 1.9 * 1024 * 1024) return blob;
    }
    throw fail('That picture is still over 2 MB after shrinking. Pick another.');
  }

  // wired once, at load
  document.addEventListener('DOMContentLoaded', () => {
    const cv = $('#crop-canvas');
    if (!cv) return;
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); C.drag = { x: e.clientX, y: e.clientY }; });
    cv.addEventListener('pointermove', (e) => {
      if (!C.drag || !C.bmp) return;
      const k = CV / cv.getBoundingClientRect().width; // screen pixels -> canvas pixels
      const s = baseScale() * C.zoom;
      C.cx -= ((e.clientX - C.drag.x) * k) / s;
      C.cy -= ((e.clientY - C.drag.y) * k) / s;
      C.drag = { x: e.clientX, y: e.clientY };
      drawCrop();
    });
    const end = () => { C.drag = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('keydown', (e) => {
      const step = 20 / (baseScale() * C.zoom);
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d && C.bmp) { e.preventDefault(); C.cx += d[0]; C.cy += d[1]; drawCrop(); }
    });
    $('#crop-zoom').addEventListener('input', (e) => { C.zoom = Number(e.target.value) || 1; drawCrop(); });
    $('#crop-cancel').onclick = closeCrop;
    $('#crop-ok').onclick = async () => {
      const ok = $('#crop-ok');
      ok.disabled = true;
      try {
        const blob = await exportWebp();
        if (P.blobUrl) URL.revokeObjectURL(P.blobUrl);
        P.blob = blob; P.blobUrl = URL.createObjectURL(blob); P.removeFile = false; P.kind = 'photo';
        closeCrop();
        say('#pf-photo-msg', 'Picture ready. It is uploaded when you tap Save.', 'ok');
        paintSelection();
      } catch (err) { say('#crop-msg', err.userMessage || 'Something went wrong. Try again.'); } finally { ok.disabled = false; }
    };
  });
})();
