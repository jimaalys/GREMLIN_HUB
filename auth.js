'use strict';
// VYRA account client: a small, dependency-free wrapper around Supabase's public REST endpoints
// (Auth, the profiles table, and the public "avatars" Storage bucket).
//
// It only ever uses the PUBLIC project URL and PUBLISHABLE key. No secret key belongs in this file or anywhere in the browser.
// The signed-in person's own access token is what grants permissions, and Supabase's rules (RLS + Storage policies) enforce them.
//
// Privacy: the saved session holds only the tokens and the account id. The email address is never saved
// in the browser by this code, and it is never sent to other VYRA users.

(function () {
  const SESSION_KEY = 'vyra-auth';
  const AVATAR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/profile\.webp\?v=\d{1,15}$/;
  const PROFILE_COLS = 'id,username,display_name,avatar,avatar_url,accent_color,status,updated_at';

  let base = '';
  let key = '';
  let session = null; // { access_token, refresh_token, expires_at (seconds), uid }
  let refreshing = null;
  let timer = null;
  const listeners = new Set();
  const emit = (ev, data) => listeners.forEach((fn) => { try { fn(ev, data); } catch { /* listener errors must not break auth */ } });

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } },
    set(v) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(v)); } catch { /* private mode: session lasts until the tab closes */ } },
    del() { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }
  };

  // AbortSignal.timeout is missing on older phone browsers; fall back to a plain timer so requests still work there.
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return { signal: AbortSignal.timeout(ms), done() {} };
    const c = new AbortController(); const id = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, done() { clearTimeout(id); } };
  }

  // ---------- low-level request ----------
  class ApiError extends Error {
    constructor(status, code, message, extra) { super(message || code || 'Request failed'); this.status = status; this.code = code || ''; this.extra = extra || ''; }
  }
  async function api(path, { method = 'GET', token, body, headers = {}, raw = false } = {}) {
    const h = { apikey: key, ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (body instanceof Blob) payload = body;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    const t = timeoutSignal(20000);
    try {
      res = await fetch(base + path, { method, headers: h, body: payload, signal: t.signal, cache: 'no-store' });
    } catch { throw new ApiError(0, 'network', 'Could not reach the account service.'); } finally { t.done(); }
    if (raw && res.ok) return res;
    let data = null;
    try { data = await res.json(); } catch { /* empty body is fine */ }
    if (!res.ok) {
      const code = (data && (data.error_code || data.code || data.error)) || '';
      const msg = (data && (data.msg || data.message || data.error_description || data.error)) || '';
      throw new ApiError(res.status, String(code), String(msg), (data && (data.details || data.hint)) || '');
    }
    return data;
  }

  // ---------- session ----------
  function setSession(s) {
    if (!s || !s.access_token || !s.refresh_token) return;
    const exp = Number(s.expires_at) || (Math.floor(Date.now() / 1000) + (Number(s.expires_in) || 3600));
    const uid = (s.user && s.user.id) || (session && session.uid) || uidFromToken(s.access_token);
    session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: exp, uid };
    store.set(session);
    schedule();
  }
  function uidFromToken(t) { // convenience only; the server and database check the token themselves
    try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || null; } catch { return null; }
  }
  function clearSession(why) {
    session = null; store.del(); clearTimeout(timer);
    if (why) emit(why);
  }
  function schedule() {
    clearTimeout(timer);
    if (!session) return;
    const ms = Math.max(5000, (session.expires_at - 60) * 1000 - Date.now());
    timer = setTimeout(() => { refresh().catch(() => {}); }, Math.min(ms, 2 ** 31 - 1));
  }
  // One refresh at a time (refresh tokens are single use). A definite "no" ends the session; a network blip does not.
  // Only one tab at a time may refresh (the Web Locks API shares the lock across tabs). Refresh tokens are single use:
  // presenting an old one makes the service end the WHOLE session, so a tab that loses the race must adopt the
  // newer session the winner saved instead of using its own old token.
  const withLock = (fn) => (navigator.locks && navigator.locks.request ? navigator.locks.request('vyra-auth-refresh', fn) : fn());
  function refresh() {
    if (!session) return Promise.reject(new ApiError(401, 'no_session', 'Not signed in.'));
    if (refreshing) return refreshing;
    refreshing = withLock(async () => {
      if (!session) throw new ApiError(401, 'no_session', 'Not signed in.');
      const saved = store.get();
      if (saved && saved.refresh_token && saved.refresh_token !== session.refresh_token && Number(saved.expires_at) > session.expires_at) {
        session = saved; schedule();
        return session;
      }
      const d = await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
      setSession(d);
      return session;
    }).catch((e) => {
      if (e.status === 400 || e.status === 401 || e.status === 403) clearSession('expired');
      throw e;
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function getToken() {
    if (!session) return null;
    if (session.expires_at - 30 <= Date.now() / 1000) await refresh();
    return session ? session.access_token : null;
  }
  // Runs an authorized call; if the token just expired, refreshes once and retries.
  async function authed(fn) {
    let token = await getToken();
    if (!token) throw new ApiError(401, 'no_session', 'Not signed in.');
    try { return await fn(token); } catch (e) {
      if (e.status === 401 || /jwt/i.test(e.message)) { await refresh(); token = session && session.access_token; if (token) return fn(token); }
      throw e;
    }
  }

  // Keep this tab in step with other tabs: they may refresh, or sign out.
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_KEY || !base) return;
    if (!e.newValue) { if (session) { session = null; clearTimeout(timer); emit('signed-out'); } return; }
    try {
      const s = JSON.parse(e.newValue);
      if (s && s.access_token && s.refresh_token) { session = s; schedule(); }
    } catch { /* ignore */ }
  });

  // ---------- public API ----------
  const Auth = {
    ApiError,
    enabled: false,
    init(cfg) {
      if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey) return { enabled: false };
      base = String(cfg.supabaseUrl).replace(/\/+$/, ''); key = cfg.supabaseKey; this.enabled = true;
      // Links from the confirmation / reset emails land here with the result in the address after "#".
      const out = { enabled: true, linkType: null, linkError: null };
      const h = new URLSearchParams(location.hash.replace(/^#/, ''));
      if (location.hash.length > 1 && (h.get('access_token') || h.get('error') || h.get('error_code'))) {
        if (h.get('error') || h.get('error_code')) out.linkError = h.get('error_code') || h.get('error');
        else if (h.get('refresh_token')) { setSession({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: h.get('expires_in') }); out.linkType = h.get('type') || 'signup'; }
        history.replaceState(null, '', location.pathname + location.search); // never leave tokens in the address bar
      }
      if (!session) { const saved = store.get(); if (saved && saved.access_token && saved.refresh_token) { session = saved; schedule(); } }
      return out;
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get signedIn() { return !!session; },
    get uid() { return session ? session.uid : null; },
    getToken,

    async signUp(email, password, redirectTo) {
      const d = await api(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', body: { email, password } });
      if (d && d.access_token && d.refresh_token) { setSession(d); return { signedIn: true }; } // only if the project does not require email confirmation
      return { signedIn: false };
    },
    async resendConfirmation(email, redirectTo) {
      return api(`/auth/v1/resend?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', body: { type: 'signup', email } });
    },
    async signIn(email, password) {
      const d = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
      setSession(d);
      return true;
    },
    async signOut() {
      const token = session && session.access_token;
      clearSession();
      if (token) { try { await api('/auth/v1/logout', { method: 'POST', token }); } catch { /* local sign-out already done */ } }
    },
    async sendReset(email, redirectTo) {
      return api(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', body: { email } });
    },
    async setPassword(password) {
      return authed((token) => api('/auth/v1/user', { method: 'PUT', token, body: { password } }));
    },

    // ----- profile (the signed-in person's own row; RLS decides what is allowed) -----
    async getProfile() {
      const uid = session && session.uid;
      if (!uid) throw new ApiError(401, 'no_session', 'Not signed in.');
      const rows = await authed((token) => api(`/rest/v1/profiles?id=eq.${uid}&select=${PROFILE_COLS}&limit=1`, { token }));
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },
    async saveProfile(fields) {
      const uid = session && session.uid;
      if (!uid) throw new ApiError(401, 'no_session', 'Not signed in.');
      const allowed = ['username', 'display_name', 'avatar', 'avatar_url', 'accent_color', 'status'];
      const body = {};
      for (const k of allowed) if (k in fields) body[k] = fields[k];
      const rows = await authed((token) => api(`/rest/v1/profiles?id=eq.${uid}`, { method: 'PATCH', token, body, headers: { Prefer: 'return=representation' } }));
      if (!Array.isArray(rows) || !rows[0]) throw new ApiError(404, 'no_profile', 'Profile not found.');
      return rows[0];
    },

    // ----- profile picture (public bucket "avatars", one file per person: {uid}/profile.webp) -----
    avatarPath() { return session && session.uid ? `${session.uid}/profile.webp` : null; },
    avatarSrc(img) { return img && AVATAR_RE.test(img) && base ? `${base}/storage/v1/object/public/avatars/${img}` : ''; },
    async uploadAvatar(blob) {
      const path = Auth.avatarPath();
      if (!path) throw new ApiError(401, 'no_session', 'Not signed in.');
      if (!(blob instanceof Blob) || blob.type !== 'image/webp') throw new ApiError(0, 'bad_type', 'Only WebP pictures are uploaded.');
      if (blob.size > 2 * 1024 * 1024) throw new ApiError(413, 'too_big', 'That picture is over 2 MB.');
      await authed((token) => api(`/storage/v1/object/avatars/${path}`, { method: 'POST', token, body: blob, headers: { 'Content-Type': 'image/webp', 'x-upsert': 'true', 'cache-control': 'max-age=3600' } }));
      return path;
    },
    async removeAvatarFile() {
      const path = Auth.avatarPath();
      if (!path) return;
      await authed((token) => api('/storage/v1/object/avatars', { method: 'DELETE', token, body: { prefixes: [path] } }));
    },
    async avatarFileExists() { // is a stored picture still there (e.g. after switching to an emoji)?
      const path = Auth.avatarPath();
      if (!path) return false;
      try { const r = await fetch(`${base}/storage/v1/object/public/avatars/${path}?c=${Date.now()}`, { method: 'HEAD', cache: 'no-store' }); return r.ok; } catch { return false; }
    },

    // ----- friendly messages (never show raw server text) -----
    friendly(e, ctx) {
      if (!e) return 'Something went wrong. Please try again.';
      const c = String(e.code || '').toLowerCase();
      const m = String(e.message || '').toLowerCase();
      if (e.status === 0 || c === 'network') return 'Could not reach VYRA accounts. Check your connection and try again.';
      if (e.status === 429 || c.includes('rate_limit') || m.includes('rate limit')) return 'Too many tries. Please wait a few minutes and try again.';
      if (c === 'signup_disabled') return 'New sign-ups are closed right now.';
      if (c === 'user_banned') return 'This account is not allowed to sign in.';
      if (c === 'reauthentication_needed' || c === 'reauthentication_not_valid') return 'For safety, please sign in again, then change your password.';
      if (c === 'captcha_failed' || m.includes('captcha')) return 'Sign-ups need a human check that this version of VYRA does not support yet.';
      if (c === 'over_request_rate_limit' || c === 'over_sms_send_rate_limit') return 'Too many tries. Please wait a few minutes and try again.';
      if (c === 'email_not_confirmed' || m.includes('not confirmed')) return 'Please confirm your email first. Check your inbox (and spam) for the link.';
      if (c === 'invalid_credentials' || m.includes('invalid login')) return 'That email and password do not match.';
      if (c === 'weak_password' || m.includes('password should') || m.includes('weak')) return 'That password is too weak. Use at least 10 characters with a mix of letters and numbers.';
      if (c === 'same_password' || m.includes('different from the old')) return 'Choose a password you have not used before.';
      if (c === 'validation_failed' || m.includes('valid email') || m.includes('unable to validate email')) return 'That email address does not look right.';
      if (c === 'user_already_exists' || c === 'email_exists') return 'Check your email for the confirmation link. If you already have an account, sign in instead.';
      if (c === 'email_address_not_authorized') return 'Account emails are not enabled for that address yet.';
      if (c === 'over_email_send_rate_limit') return 'Too many emails sent. Please wait a few minutes and try again.';
      if (c === '23505' || e.status === 409) return ctx === 'avatar' ? 'Please try again.' : 'That username is already taken. Try another one.';
      if (c === '23514') return /username/i.test(e.message + e.extra) ? 'That username is not allowed. Use 3 to 20 lowercase letters, numbers or underscores.' : 'One of those values is not allowed. Please check the fields and try again.';
      if (c === 'too_big' || e.status === 413) return 'That picture is over 2 MB. Pick a smaller one.';
      if (e.status === 401 || c === 'no_session' || c === 'bad_jwt') return 'Your session ended. Please sign in again.';
      if (e.status === 403) return 'That action is not allowed for your account.';
      return 'Something went wrong. Please try again.';
    }
  };
  window.VyraAuth = Auth;
})();
