/* Minimal Supabase client (PostgREST + Auth) over fetch. No library download needed. */
(function () {
  const cfg = window.BB_CONFIG || {};
  const url = (cfg.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = cfg.SUPABASE_ANON_KEY || "";
  const SESSION_KEY = "bb-sb-session";

  const SB = (window.SB = {
    configured: !!(url && key),
    session: null,
  });

  try { SB.session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (e) {}

  async function request(path, { method = "GET", body, headers = {}, auth = true } = {}) {
    if (!SB.configured) throw new Error("Supabase is not configured (docs/js/config.js).");
    if (auth && SB.session) await refreshIfNeeded();
    const h = { apikey: key, "Content-Type": "application/json", ...headers };
    h.Authorization = "Bearer " + (auth && SB.session ? SB.session.access_token : key);
    let res;
    try { res = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { const err = new Error("No internet connection."); err.offline = true; throw err; }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error_description || data.msg || data.error)) || `Request failed (${res.status})`;
      const err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  SB.rpc = (fn, args = {}) => request(`/rest/v1/rpc/${fn}`, { method: "POST", body: args });
  SB.select = (table, query = "") => request(`/rest/v1/${table}?${query}`);
  SB.insert = (table, row, upsert) => request(`/rest/v1/${table}`, {
    method: "POST", body: row,
    headers: { Prefer: "return=representation" + (upsert ? ",resolution=merge-duplicates" : "") },
  });
  SB.update = (table, query, patch) => request(`/rest/v1/${table}?${query}`, { method: "PATCH", body: patch, headers: { Prefer: "return=representation" } });
  SB.remove = (table, query) => request(`/rest/v1/${table}?${query}`, { method: "DELETE" });

  function saveSession(s) {
    SB.session = s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() / 1000 + (s.expires_in || 3600), email: s.user?.email || SB.session?.email } : null;
    try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(SB.session)) : sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  async function refreshIfNeeded() {
    if (!SB.session || SB.session.expires_at - Date.now() / 1000 > 120) return;
    try {
      const s = await request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: SB.session.refresh_token }, auth: false });
      saveSession(s);
    } catch (e) { if (!e.offline) saveSession(null); }
  }

  SB.signIn = async (email, password) => {
    const s = await request("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password }, auth: false });
    saveSession(s);
    return s;
  };
  SB.signOut = () => saveSession(null);
})();
