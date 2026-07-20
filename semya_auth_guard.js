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
  const LOGIN_PAGE    = '/index.html';
  const TOKEN_KEY     = 'semya_token';

  // Read slug from URL
  const urlMatch   = window.location.pathname.match(/\/clients\/([^/]+)/);
  const clientSlug = urlMatch ? urlMatch[1] : null;
  if (clientSlug) localStorage.setItem('semya_last_slug', clientSlug);

  function redirectToLogin() {
    localStorage.removeItem(TOKEN_KEY);
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

    // 5. Listen for session expiry
    client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') redirectToLogin();
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
    if (window._supabaseClient) await window._supabaseClient.auth.signOut();
    localStorage.removeItem(TOKEN_KEY);
    window.location.replace(LOGIN_PAGE);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAuth);
  } else {
    checkAuth();
  }
})();
