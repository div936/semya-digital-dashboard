// semya_auth_guard.js  (Phase 8 — Supabase Magic Link Auth)
// ─────────────────────────────────────────────────────────────────
// Add to <head> of dashboard.html BEFORE other scripts:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="semya_auth_guard.js"></script>
// ─────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const API_BASE      = 'https://semya-api.onrender.com';
  const SUPABASE_URL  = 'https://oeusnopzqsrbgqqarepj.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ldXNub3B6cXNyYmdxcWFyZXBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzNzI0MDUsImV4cCI6MjA5OTk0ODQwNX0.DU4xBf6fib8EKiAqh1AFn86RqFQNo3vgm48MwbDY1eM';
  const LOGIN_PAGE    = '/semya-digital-dashboard/index.html';
  const TOKEN_KEY     = 'semya_token';

  // Read slug from URL
  const urlMatch   = window.location.pathname.match(/\/clients\/([^/]+)/);
  const clientSlug = urlMatch ? urlMatch[1] : null;
  if (clientSlug) localStorage.setItem('semya_last_slug', clientSlug);

  // One-shot guard: prevents redirectToLogin from firing more than once
  // per page load — specifically stops the SIGNED_OUT event loop where
  // semyaLogout() calls signOut() → fires SIGNED_OUT → redirectToLogin()
  // calls signOut() again → fires SIGNED_OUT again → infinite loop.
  let _redirecting = false;

  function redirectToLogin() {
    if (_redirecting) return;   // ← breaks the loop
    _redirecting = true;
    localStorage.removeItem(TOKEN_KEY);
    // Don't call signOut() here — the caller already did, or we don't
    // need to. Calling it again is what caused the infinite loop.
    window.location.replace(LOGIN_PAGE);
  }

  async function checkAuth() {
    // 1. Init Supabase client
    if (!window.supabase) { redirectToLogin(); return; }
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    window._supabaseClient = client;

    // 2. Get Supabase session (handles magic link automatically)
    const { data: { session } } = await client.auth.getSession();

    if (!session) { redirectToLogin(); return; }

    // 3. Store access token for API calls
    const token = session.access_token;
    localStorage.setItem(TOKEN_KEY, token);

    // 4. Validate against our backend + get role/client info
    try {
      const res = await fetch(API_BASE + '/auth/me', {
        headers: { 'Authorization': 'Bearer ' + token },
        credentials: 'include',
      });

      if (!res.ok) { redirectToLogin(); return; }

      const me = await res.json();
      window.semyaUser = { ...me, token, clientSlug: clientSlug || me.clientSlug };

      applyRBAC(me.role);
      document.dispatchEvent(new CustomEvent('semya:auth-ready', { detail: window.semyaUser }));

    } catch (err) {
      console.error('[auth guard] /me failed:', err.message);
      // If server unreachable, still allow UI to load with session data
      window.semyaUser = {
        userId: session.user.id, email: session.user.email,
        role: 'client', token, clientSlug,
      };
      applyRBAC('client');
      document.dispatchEvent(new CustomEvent('semya:auth-ready', { detail: window.semyaUser }));
    }

    // 5. Listen for session expiry events — but NOT for our own logout
    // (semyaLogout sets _redirecting=true before calling signOut so this
    // handler sees the flag and does nothing, avoiding the infinite loop).
    client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && !_redirecting) redirectToLogin();
    });
  }

  function applyRBAC(role) {
    if (role !== 'admin') {
      document.querySelectorAll('[data-role="admin"]').forEach(el => {
        el.style.display = 'none';
      });
    }
  }

  window.semyaLogout = async function () {
    // Set guard FIRST so the SIGNED_OUT event handler doesn't
    // trigger a second redirectToLogin() while we're signing out.
    _redirecting = true;
    localStorage.removeItem(TOKEN_KEY);
    if (window._supabaseClient) {
      try { await window._supabaseClient.auth.signOut(); } catch (_) {}
    }
    window.location.replace(LOGIN_PAGE);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAuth);
  } else {
    checkAuth();
  }
})();
