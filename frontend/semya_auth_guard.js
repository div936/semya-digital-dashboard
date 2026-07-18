// semya_auth_guard.js
// ─────────────────────────────────────────────────────────────────
// Drop-in auth guard for the Phase 1 dashboard (semya_phase1_dashboard.html)
//
// HOW TO USE:
//   Add this ONE line inside the <head> of your dashboard HTML,
//   before any other scripts:
//
//     <script src="semya_auth_guard.js"></script>
//
// What it does on every page load:
//   1. Reads the JWT from localStorage (or httpOnly cookie via /auth/me)
//   2. Calls GET /auth/me to validate the token is still live
//   3. If invalid/expired → redirects to /login immediately
//   4. If valid → attaches the user context to window.semyaUser
//      and hides/shows admin-only UI elements based on role
//   5. Reads the client slug from the URL and stores it for later use
// ─────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────────
  const API_BASE    = 'http://localhost:3000';   // ← update to your server URL
  const TOKEN_KEY   = 'semya_token';
  const LOGIN_PAGE  = '/login';                  // ← update to your login page path

  // ── Read slug from URL: /clients/{slug}/dashboard ───────────────
  const urlMatch = window.location.pathname.match(/\/clients\/([^/]+)/);
  const clientSlug = urlMatch ? urlMatch[1] : null;
  if (clientSlug) localStorage.setItem('semya_last_slug', clientSlug);

  // ── Redirect helper ─────────────────────────────────────────────
  function redirectToLogin(reason) {
    console.warn('[semya-auth]', reason);
    localStorage.removeItem(TOKEN_KEY);
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`${LOGIN_PAGE}?next=${returnTo}`);
  }

  // ── Main auth check ─────────────────────────────────────────────
  async function checkAuth() {
    const token = localStorage.getItem(TOKEN_KEY);

    // No token at all — go to login immediately
    if (!token) {
      redirectToLogin('No token found.');
      return;
    }

    // Quick local expiry check before hitting the network
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        redirectToLogin('Token expired (local check).');
        return;
      }
    } catch {
      redirectToLogin('Malformed token.');
      return;
    }

    // Server-side validation via /auth/me
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers:     { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });

      if (!res.ok) {
        redirectToLogin(`/auth/me returned ${res.status}.`);
        return;
      }

      const me = await res.json();

      // Client-role users: enforce they're only viewing their own client
      if (me.role === 'client' && clientSlug) {
        const { data: config } = await fetchDashboardConfig(token, clientSlug);
        if (!config) {
          redirectToLogin('Client cannot access this dashboard.');
          return;
        }
      }

      // Expose user context globally for other scripts to read
      window.semyaUser = {
        ...me,
        token,
        clientSlug,
      };

      // Apply RBAC to the UI
      applyRBAC(me.role);

      // Dispatch event so the dashboard script knows auth is done
      document.dispatchEvent(new CustomEvent('semya:auth-ready', { detail: window.semyaUser }));

    } catch (err) {
      // Network error — don't log out, just warn (might be offline dev)
      console.error('[semya-auth] Could not reach /auth/me:', err.message);
      // Still expose whatever we have from the local token
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        window.semyaUser = { ...payload, token, clientSlug };
        applyRBAC(payload.role);
        document.dispatchEvent(new CustomEvent('semya:auth-ready', { detail: window.semyaUser }));
      } catch {
        redirectToLogin('Token unreadable and server unreachable.');
      }
    }
  }

  // ── Fetch dashboard config (tab permissions + theme) ─────────────
  async function fetchDashboardConfig(token, slug) {
    try {
      const res = await fetch(`${API_BASE}/clients/${slug}/dashboard-config`, {
        headers:     { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!res.ok) return { data: null };
      const data = await res.json();

      // Apply dynamic theme from the server
      if (data.client?.theme) applyTheme(data.client.theme);

      // Store permissions on window for tab-gating in the dashboard
      window.semyaPermissions = data.tabs ?? {};

      return { data };
    } catch {
      return { data: null };
    }
  }

  // ── Apply CSS variable theme from server JSON ─────────────────────
  // Expects: { primary, accent, bg, surface, border }
  function applyTheme(theme) {
    const root = document.documentElement.style;
    if (theme.primary) root.setProperty('--theme-primary',  theme.primary);
    if (theme.accent)  root.setProperty('--theme-accent',   theme.accent);
    if (theme.bg)      root.setProperty('--color-bg',       theme.bg);
    if (theme.surface) root.setProperty('--color-surface',  theme.surface);
    if (theme.border)  root.setProperty('--color-border',   theme.border);
  }

  // ── Apply RBAC to the DOM ─────────────────────────────────────────
  // Elements with data-role="admin" are hidden for client users.
  // Elements with data-tab="sku_performance" etc. are hidden if disabled.
  function applyRBAC(role) {
    // Hide admin-only elements from client users
    if (role !== 'admin') {
      document.querySelectorAll('[data-role="admin"]').forEach(el => {
        el.style.display = 'none';
      });
    }

    // Gate tabs by permission once permissions are loaded
    if (window.semyaPermissions) {
      gateTabs(window.semyaPermissions);
    } else {
      // Permissions load asynchronously — gate after they arrive
      document.addEventListener('semya:auth-ready', () => {
        if (window.semyaPermissions) gateTabs(window.semyaPermissions);
      });
    }
  }

  function gateTabs(permissions) {
    document.querySelectorAll('[data-tab]').forEach(el => {
      const tabKey = el.dataset.tab;
      const perm   = permissions[tabKey];
      if (perm && !perm.enabled) {
        el.style.display = 'none';
      }
    });
  }

  // ── Logout helper (attach to your logout button) ──────────────────
  window.semyaLogout = async function () {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method:      'POST',
        credentials: 'include',
      });
    } finally {
      localStorage.removeItem(TOKEN_KEY);
      window.location.replace(LOGIN_PAGE);
    }
  };

  // ── Run ──────────────────────────────────────────────────────────
  // If DOM is already parsed, run now; otherwise wait for it
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAuth);
  } else {
    checkAuth();
  }

})();
