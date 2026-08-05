import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { pool, initDb } from "./db.js";
import { sendMail } from "./mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "cambia-questa-chiave-in-produzione";

app.use(cors());
app.use(express.json());

// ---------- Helpers ----------
function sign(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non autenticato." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Sessione scaduta, effettua di nuovo l'accesso." });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Riservato all'amministratore." });
  next();
}

// Le richieste modificabili sono solo quelle in attesa e con data di inizio futura (o oggi).
function canEdit(r) {
  const today = new Date().toISOString().slice(0, 10);
  const di = (r.data_inizio instanceof Date ? r.data_inizio.toISOString().slice(0,10) : String(r.data_inizio).slice(0,10));
  return r.stato === "in_attesa" && di >= today;
}

// ============================================================
//  AUTENTICAZIONE
// ============================================================
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Inserisci il nome." });
  if (!/^\S+@\S+\.\S+$/.test(email || "")) return res.status(400).json({ error: "Email non valida." });
  if ((password || "").length < 4) return res.status(400).json({ error: "Password troppo corta (min 4)." });

  try {
    const exists = await pool.query("SELECT 1 FROM users WHERE lower(email)=lower($1)", [email]);
    if (exists.rowCount) return res.status(409).json({ error: "Email già registrata." });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      "INSERT INTO users (name, email, pw_hash, role) VALUES ($1,$2,$3,'user') RETURNING id, name, email, role",
      [name.trim(), email.trim(), hash]
    );
    res.json({ token: sign(rows[0]), user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore durante la registrazione." });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE lower(email)=lower($1)", [email || ""]);
    const u = rows[0];
    if (!u) return res.status(401).json({ error: "Nessun account con questa email." });
    const ok = await bcrypt.compare(password || "", u.pw_hash);
    if (!ok) return res.status(401).json({ error: "Password errata." });
    const safe = { id: u.id, name: u.name, email: u.email, role: u.role };
    res.json({ token: sign(safe), user: safe });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore durante l'accesso." });
  }
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role } });
});

// ============================================================
//  RICHIESTE (permessi / ferie / assenze)
// ============================================================
app.get("/api/requests", auth, async (req, res) => {
  // utente: solo le proprie; admin: tutte
  const q = req.user.role === "admin"
    ? await pool.query(`SELECT r.*, u.name AS user_name, u.email AS user_email
                        FROM requests r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC`)
    : await pool.query(`SELECT * FROM requests WHERE user_id=$1 ORDER BY created_at DESC`, [req.user.id]);
  res.json(q.rows);
});

app.post("/api/requests", auth, async (req, res) => {
  const { tipo, mode, dataInizio, dataFine, oraInizio, oraFine, note } = req.body;
  if (!["permesso", "ferie", "assenza"].includes(tipo)) return res.status(400).json({ error: "Tipo non valido." });
  if (!["ore", "giorni"].includes(mode)) return res.status(400).json({ error: "Modalità non valida." });
  const df = mode === "giorni" ? dataFine : dataInizio;
  try {
    const { rows } = await pool.query(
      `INSERT INTO requests (user_id, tipo, mode, data_inizio, data_fine, ora_inizio, ora_fine, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, tipo, mode, dataInizio, df,
       mode === "ore" ? oraInizio : null, mode === "ore" ? oraFine : null, (note || "").trim()]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore nel salvataggio della richiesta." });
  }
});

app.put("/api/requests/:id", auth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM requests WHERE id=$1", [req.params.id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Richiesta non trovata." });
    if (r.user_id !== req.user.id) return res.status(403).json({ error: "Non puoi modificare questa richiesta." });
    if (!canEdit(r)) return res.status(400).json({ error: "Modificabile solo se in attesa e futura." });

    const { tipo, mode, dataInizio, dataFine, oraInizio, oraFine, note } = req.body;
    const df = mode === "giorni" ? dataFine : dataInizio;
    const { rows: upd } = await pool.query(
      `UPDATE requests SET tipo=$1, mode=$2, data_inizio=$3, data_fine=$4, ora_inizio=$5, ora_fine=$6, note=$7
       WHERE id=$8 RETURNING *`,
      [tipo, mode, dataInizio, df, mode === "ore" ? oraInizio : null, mode === "ore" ? oraFine : null,
       (note || "").trim(), req.params.id]
    );
    res.json(upd[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore nella modifica." });
  }
});

app.delete("/api/requests/:id", auth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM requests WHERE id=$1", [req.params.id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Richiesta non trovata." });
    if (r.user_id !== req.user.id) return res.status(403).json({ error: "Non puoi eliminare questa richiesta." });
    if (!canEdit(r)) return res.status(400).json({ error: "Eliminabile solo se in attesa e futura." });
    await pool.query("DELETE FROM requests WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore nell'eliminazione." });
  }
});

// Admin: approva / respingi + notifica (in-app sempre, email se SMTP configurato)
app.post("/api/requests/:id/decide", auth, adminOnly, async (req, res) => {
  const { stato } = req.body; // approvata | respinta
  if (!["approvata", "respinta"].includes(stato)) return res.status(400).json({ error: "Stato non valido." });
  try {
    const { rows } = await pool.query(
      `UPDATE requests SET stato=$1 WHERE id=$2 RETURNING *`, [stato, req.params.id]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Richiesta non trovata." });

    const { rows: us } = await pool.query("SELECT name, email FROM users WHERE id=$1", [r.user_id]);
    const u = us[0];
    const tipoLabel = { permesso: "Permesso", ferie: "Ferie", assenza: "Assenza" }[r.tipo];
    const esito = stato === "approvata" ? "APPROVATA" : "RESPINTA";
    const subject = `Esito richiesta ${tipoLabel}`;
    const body = `Ciao ${u.name}, la tua richiesta di ${tipoLabel.toLowerCase()} del ${String(r.data_inizio).slice(0,10)} è stata ${esito}.`;

    await pool.query(
      "INSERT INTO messages (user_id, subject, body) VALUES ($1,$2,$3)",
      [r.user_id, subject, body]
    );
    // email reale se configurata
    const emailSent = await sendMail(u.email, subject, body);
    res.json({ request: r, emailSent });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore nella decisione." });
  }
});

// ============================================================
//  ORE LAVORATE (dichiarate dall'utente)
// ============================================================
app.get("/api/worklogs", auth, async (req, res) => {
  const q = req.user.role === "admin"
    ? await pool.query(`SELECT w.*, u.name AS user_name FROM worklogs w JOIN users u ON u.id=w.user_id ORDER BY w.data DESC`)
    : await pool.query("SELECT * FROM worklogs WHERE user_id=$1 ORDER BY data DESC", [req.user.id]);
  res.json(q.rows);
});

app.post("/api/worklogs", auth, async (req, res) => {
  const { data, inizio, fine, pausa, ore } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO worklogs (user_id, data, inizio, fine, pausa, ore) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, data, inizio, fine, Number(pausa || 0), Number(ore)]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore nel salvataggio delle ore." });
  }
});

app.delete("/api/worklogs/:id", auth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM worklogs WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Non trovato." });
    if (rows[0].user_id !== req.user.id && req.user.role !== "admin")
      return res.status(403).json({ error: "Non consentito." });
    await pool.query("DELETE FROM worklogs WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Errore nell'eliminazione." });
  }
});

// ============================================================
//  RILEVAZIONI (ore rilevate dall'admin)
// ============================================================
app.get("/api/detected", auth, async (req, res) => {
  const q = req.user.role === "admin"
    ? await pool.query(`SELECT d.*, u.name AS user_name FROM detected d JOIN users u ON u.id=d.user_id ORDER BY d.data DESC`)
    : await pool.query("SELECT * FROM detected WHERE user_id=$1 ORDER BY data DESC", [req.user.id]);
  res.json(q.rows);
});

app.post("/api/detected", auth, adminOnly, async (req, res) => {
  const { userId, data, ore } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO detected (user_id, data, ore) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, data) DO UPDATE SET ore=EXCLUDED.ore RETURNING *`,
      [userId, data, Number(ore)]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore nel salvataggio della rilevazione." });
  }
});

app.delete("/api/detected/:id", auth, adminOnly, async (req, res) => {
  await pool.query("DELETE FROM detected WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ============================================================
//  UTENTI (elenco per admin)
// ============================================================
app.get("/api/users", auth, adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, email, role FROM users WHERE role='user' ORDER BY name"
  );
  res.json(rows);
});

// ============================================================
//  MESSAGGI / COMUNICAZIONI
// ============================================================
app.get("/api/messages", auth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM messages WHERE user_id=$1 ORDER BY created_at DESC", [req.user.id]
  );
  res.json(rows);
});

app.post("/api/messages/:id/read", auth, async (req, res) => {
  await pool.query("UPDATE messages SET read=true WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ============================================================
//  SERVING DEL FRONTEND (build di Vite in client/dist)
// ============================================================
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));
app.get("*", (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// ---------- Avvio ----------
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✓ Server in ascolto sulla porta ${PORT}`));
  })
  .catch((e) => {
    console.error("Errore inizializzazione DB:", e);
    process.exit(1);
  });
