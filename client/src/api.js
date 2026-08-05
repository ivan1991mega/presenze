// Piccolo wrapper attorno a fetch che aggiunge il token JWT e gestisce gli errori.

const TOKEN_KEY = "gestore_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function req(method, url, body) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* risposta senza corpo */ }

  if (!res.ok) {
    const msg = (data && data.error) || `Errore ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  get: (u) => req("GET", u),
  post: (u, b) => req("POST", u, b),
  put: (u, b) => req("PUT", u, b),
  del: (u) => req("DELETE", u),
};
