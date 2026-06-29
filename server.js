/**
 * KORAWAVE — Serveur web (Express)
 * Site de streaming musical de Guinée. Mélange UX Spotify + identité KORAWAVE.
 *
 * Fonctions : inscription / connexion (JWT), catalogue audio & vidéo,
 * lecture en streaming, likes, dashboard admin avec upload audio (+ pochette)
 * et vidéo (+ fichier vidéo).
 *
 * Démarrage : npm install && npm start  ->  http://localhost:4000
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'korawave-dev-secret-change-me';

// VAPID keys — générés une fois, stockés en DB
(function initVapid() {
  const data = db.read();
  if (!data.vapid) {
    data.vapid = webpush.generateVAPIDKeys();
    db.write(data);
    console.log('[VAPID] Clés générées');
  }
  webpush.setVapidDetails('mailto:admin@korawave.gn', data.vapid.publicKey, data.vapid.privateKey);
})();

function sendPush(subscription, payload) {
  return webpush.sendNotification(subscription, JSON.stringify(payload)).catch(() => {});
}

function notifyFollowers(artistId, payload) {
  const data = db.read();
  const followerIds = (data.follows || []).filter((f) => f.artistId === artistId).map((f) => f.userId);
  const subs = (data.pushSubscriptions || []).filter((s) => followerIds.includes(s.userId));
  subs.forEach((s) => sendPush(s.subscription, payload));
}

// ---------------------------------------------------------------------------
// Dossiers d'upload
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SUBDIRS = ['audio', 'covers', 'videos', 'thumbs'];
for (const d of [UPLOAD_DIR, ...SUBDIRS.map((s) => path.join(UPLOAD_DIR, s))]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const map = {
      audio: 'audio',
      cover: 'covers',
      video: 'videos',
      thumb: 'thumbs',
    };
    cb(null, path.join(UPLOAD_DIR, map[file.fieldname] || ''));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname) || '';
    const safe = crypto.randomBytes(10).toString('hex');
    cb(null, `${Date.now()}_${safe}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 Mo max / fichier
});

// ---------------------------------------------------------------------------
// Middlewares de base
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers Auth
// ---------------------------------------------------------------------------
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function auth(required = true) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      if (required) return res.status(401).json({ error: 'Authentification requise' });
      req.user = null;
      return next();
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const data = db.read();
      req.user = data.users.find((u) => u.id === payload.id) || null;
      if (required && !req.user) return res.status(401).json({ error: 'Session invalide' });
      next();
    } catch (e) {
      if (required) return res.status(401).json({ error: 'Session expirée' });
      req.user = null;
      next();
    }
  };
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé à l’administrateur' });
  }
  next();
}

function artistOnly(req, res, next) {
  if (!req.user || (req.user.role !== 'artist' && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Accès réservé aux artistes' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Seed admin
// ---------------------------------------------------------------------------
function seedAdmin() {
  const data = db.read();
  const exists = data.users.find((u) => u.role === 'admin');
  if (exists) return;
  const admin = {
    id: crypto.randomUUID(),
    name: 'Administrateur KORAWAVE',
    email: 'admin@korawave.gn',
    phone: '+224600000000',
    role: 'admin',
    passwordHash: bcrypt.hashSync('Korawave2025', 10),
    koins: 0,
    createdAt: new Date().toISOString(),
  };
  data.users.push(admin);
  db.write();
  console.log('────────────────────────────────────────────────');
  console.log('  Compte ADMIN créé :');
  console.log('   Identifiant : admin@korawave.gn  (ou +224600000000)');
  console.log('   Mot de passe : Korawave2025');
  console.log('────────────────────────────────────────────────');
}

// ===========================================================================
// ROUTES AUTH
// ===========================================================================

// Inscription utilisateur standard (téléphone OU email + mot de passe)
app.post('/api/auth/register', (req, res) => {
  const data = db.read();
  let { name, phone, email, password, asArtist, artistName } = req.body || {};
  name = (name || '').trim();
  phone = (phone || '').trim();
  email = (email || '').trim().toLowerCase();
  artistName = (artistName || '').trim();
  if (!name || !password) return res.status(400).json({ error: 'Nom et mot de passe requis' });
  if (!phone && !email) return res.status(400).json({ error: 'Téléphone ou email requis' });
  if (password.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (min 4)' });

  const dup = data.users.find(
    (u) => (phone && u.phone === phone) || (email && u.email === email)
  );
  if (dup) return res.status(409).json({ error: 'Ce compte existe déjà' });

  const user = {
    id: crypto.randomUUID(),
    name,
    phone: phone || null,
    email: email || null,
    role: asArtist ? 'artist' : 'user',
    artistName: asArtist ? (artistName || name) : null,
    verified: false, // l'admin valide les artistes
    bio: '',
    passwordHash: bcrypt.hashSync(password, 10),
    koins: 1000, // bonus de bienvenue
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  db.write();
  res.json({ token: sign(user), user: publicUser(user) });
});

// Connexion (identifiant = email ou téléphone)
app.post('/api/auth/login', (req, res) => {
  const data = db.read();
  let { identifier, password } = req.body || {};
  identifier = (identifier || '').trim().toLowerCase();
  if (!identifier || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });

  const user = data.users.find(
    (u) =>
      (u.email && u.email.toLowerCase() === identifier) ||
      (u.phone && u.phone.toLowerCase() === identifier)
  );
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

// Profil courant
app.get('/api/auth/me', auth(), (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// AUTH PAR OTP (sans mot de passe — connexion par numéro de téléphone)
// ---------------------------------------------------------------------------

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

function normalizePhone(p) {
  p = (p || '').replace(/\s/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

// Étape 1 — demande d'OTP : créé ou trouvé l'utilisateur selon isRegister
app.post('/api/auth/request-otp', (req, res) => {
  let { phone, name, isRegister } = req.body || {};
  phone = normalizePhone(phone);
  if (!/^\+\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Numéro de téléphone invalide' });

  const data = db.read();
  if (!data.otpCodes) data.otpCodes = [];

  const existing = data.users.find((u) => u.phone === phone);

  if (!isRegister && !existing) {
    return res.status(404).json({ error: 'Numéro non trouvé. Crée un compte.' });
  }
  if (isRegister && existing) {
    return res.status(409).json({ error: 'Ce numéro est déjà enregistré. Connecte-toi.' });
  }
  if (isRegister && !name?.trim()) {
    return res.status(400).json({ error: 'Prénom requis pour l\'inscription' });
  }

  // Nettoie les anciens OTP pour ce numéro
  data.otpCodes = data.otpCodes.filter((o) => o.phone !== phone);

  const code = genOtp();
  const expiry = new Date(Date.now() + OTP_TTL_MS).toISOString();
  data.otpCodes.push({ phone, code, expiry, name: name?.trim() || null, isRegister: !!isRegister });
  db.write();

  // En production : appel API SMS (Orange SMS, MTN MoMo API, etc.)
  console.log(`[OTP] ${phone} → ${code}`);

  // En démo : on renvoie le code dans la réponse (à supprimer en prod)
  res.json({ sent: true, _demo_code: code });
});

// Étape 2 — vérification OTP → JWT
app.post('/api/auth/verify-otp', (req, res) => {
  let { phone, code } = req.body || {};
  phone = normalizePhone(phone);
  code = (code || '').trim();

  const data = db.read();
  if (!data.otpCodes) data.otpCodes = [];

  const entry = data.otpCodes.find((o) => o.phone === phone && o.code === code);
  if (!entry) return res.status(401).json({ error: 'Code incorrect' });
  if (new Date(entry.expiry) < new Date()) {
    data.otpCodes = data.otpCodes.filter((o) => o !== entry);
    db.write();
    return res.status(401).json({ error: 'Code expiré. Demande un nouveau code.' });
  }

  // Consomme le code
  data.otpCodes = data.otpCodes.filter((o) => o !== entry);

  let user = data.users.find((u) => u.phone === phone);
  if (!user) {
    // Création du compte (inscription)
    user = {
      id: crypto.randomUUID(),
      name: entry.name || 'Utilisateur',
      phone,
      email: null,
      passwordHash: null,
      role: 'user',
      koins: 0,
      verified: false,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
  }

  db.write();
  res.json({ token: sign(user), user: publicUser(user) });
});

// ===========================================================================
// ESPACE ARTISTE
// ===========================================================================

// Un utilisateur standard devient artiste
app.post('/api/artist/apply', auth(), (req, res) => {
  const data = db.read();
  const u = data.users.find((x) => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'Compte introuvable' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Un admin ne peut pas devenir artiste' });
  u.role = 'artist';
  u.artistName = (req.body.artistName || '').trim() || u.name;
  u.bio = (req.body.bio || '').trim();
  if (u.verified === undefined) u.verified = false;
  db.write();
  res.json({ token: sign(u), user: publicUser(u) });
});

// Met à jour le profil artiste (nom de scène + bio)
app.put('/api/artist/profile', auth(), artistOnly, (req, res) => {
  const data = db.read();
  const u = data.users.find((x) => x.id === req.user.id);
  if (req.body.artistName !== undefined) u.artistName = (req.body.artistName || '').trim() || u.name;
  if (req.body.bio !== undefined) u.bio = (req.body.bio || '').trim();
  // si le nom de scène change, on met à jour ses contenus
  data.tracks.forEach((t) => { if (t.ownerId === u.id) t.artist = u.artistName; });
  data.videos.forEach((v) => { if (v.ownerId === u.id) v.artist = u.artistName; });
  db.write();
  res.json({ user: publicUser(u) });
});

// L'artiste publie un AUDIO (lié à son compte)
app.post(
  '/api/artist/tracks',
  auth(),
  artistOnly,
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
  (req, res) => {
    const r = createTrack(req, req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ track: r.track });
  }
);

// L'artiste publie une VIDEO (liée à son compte)
app.post(
  '/api/artist/videos',
  auth(),
  artistOnly,
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
  (req, res) => {
    const r = createVideo(req, req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ video: r.video });
  }
);

// L'artiste supprime SON propre contenu
app.delete('/api/artist/tracks/:id', auth(), artistOnly, (req, res) => {
  const data = db.read();
  const idx = data.tracks.findIndex((t) => t.id === req.params.id && t.ownerId === req.user.id);
  if (idx < 0) return res.status(404).json({ error: 'Introuvable' });
  removeUpload(data.tracks[idx].audioUrl);
  removeUpload(data.tracks[idx].coverUrl);
  data.tracks.splice(idx, 1);
  db.write();
  res.json({ ok: true });
});

app.delete('/api/artist/videos/:id', auth(), artistOnly, (req, res) => {
  const data = db.read();
  const idx = data.videos.findIndex((v) => v.id === req.params.id && v.ownerId === req.user.id);
  if (idx < 0) return res.status(404).json({ error: 'Introuvable' });
  removeUpload(data.videos[idx].videoUrl);
  removeUpload(data.videos[idx].thumbUrl);
  data.videos.splice(idx, 1);
  db.write();
  res.json({ ok: true });
});

// Statistiques personnelles de l'artiste (INNOVATION_10 — version web)
app.get('/api/artist/stats', auth(), artistOnly, (req, res) => {
  const data = db.read();
  const myTracks = data.tracks.filter((t) => t.ownerId === req.user.id);
  const myVideos = data.videos.filter((v) => v.ownerId === req.user.id);
  const myIds = new Set([...myTracks, ...myVideos].map((x) => x.id));

  const plays =
    myTracks.reduce((s, t) => s + (t.plays || 0), 0) +
    myVideos.reduce((s, v) => s + (v.plays || 0), 0);
  const grossRevenue =
    myTracks.reduce((s, t) => s + (t.price || 0) * (t.plays || 0), 0) +
    myVideos.reduce((s, v) => s + (v.price || 0) * (v.plays || 0), 0);

  // Fans = utilisateurs uniques ayant liké au moins un contenu de l'artiste
  const fans = new Set(
    data.likes.filter((l) => myIds.has(l.contentId)).map((l) => l.userId)
  ).size;
  const likes = data.likes.filter((l) => myIds.has(l.contentId)).length;

  const topTracks = myTracks
    .slice()
    .sort((a, b) => (b.plays || 0) - (a.plays || 0))
    .slice(0, 5)
    .map((t) => ({ id: t.id, title: t.title, plays: t.plays || 0, coverUrl: t.coverUrl }));

  // Revenus RÉELS : ventes (achats KOINS de ses contenus) + pourboires reçus
  const mySales = data.purchases.filter((p) => myIds.has(p.contentId));
  const salesEarnings = mySales.reduce((s, p) => s + (p.split?.artist || 0), 0);
  const myTips = data.tips.filter((t) => t.artistId === req.user.id);
  const tipsEarnings = myTips.reduce((s, t) => s + (t.split?.artist || 0), 0);

  res.json({
    artistName: req.user.artistName || req.user.name,
    verified: !!req.user.verified,
    tracks: myTracks.length,
    videos: myVideos.length,
    scheduled: [...myTracks, ...myVideos].filter((x) => !isReleased(x)).length,
    totalPlays: plays,
    fans,
    likes,
    shares: myTracks.reduce((s, t) => s + (t.shares || 0), 0),
    sales: mySales.length,
    tipsCount: myTips.length,
    salesEarnings,
    tipsEarnings,
    earnings: salesEarnings + tipsEarnings, // KOINS réellement gagnés (part 50%)
    grossRevenue,
    artistRevenue: Math.round(grossRevenue * 0.5), // estimation basée sur les écoutes
    topTracks,
  });
});

// Contenu de l'artiste (pour la gestion)
app.get('/api/artist/content', auth(), artistOnly, (req, res) => {
  const data = db.read();
  res.json({
    tracks: data.tracks.filter((t) => t.ownerId === req.user.id),
    videos: data.videos.filter((v) => v.ownerId === req.user.id),
  });
});

// ===========================================================================
// PARTAGE D'EXTRAIT 30s (SKILL_07) — réservé aux ARTISTES VÉRIFIÉS
// Règle CLAUDE.md : seul un artiste vérifié peut partager ; jamais le fichier
// original ; lien universel vers la fiche du titre.
// ===========================================================================
app.post('/api/artist/tracks/:id/share', auth(), artistOnly, (req, res) => {
  if (!req.user.verified) {
    return res.status(403).json({ error: 'Réservé aux artistes vérifiés (badge ✔)' });
  }
  const data = db.read();
  const t = data.tracks.find((x) => x.id === req.params.id && x.ownerId === req.user.id);
  if (!t) return res.status(404).json({ error: 'Titre introuvable' });
  if (!isReleased(t)) return res.status(400).json({ error: 'Titre pas encore sorti' });

  t.shareEnabled = true;
  t.shareStart = Math.max(0, parseInt(req.body.start, 10) || 0); // début du passage de 30s
  t.shares = (t.shares || 0) + 1;
  db.write();

  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    shareUrl: `${base}/titre/${t.id}`, // lien universel (deep-link web)
    shareStart: t.shareStart,
    duration: 30,
    shares: t.shares,
  });
});

// Page publique d'un extrait partagé (accessible sans compte)
app.get('/api/share/:id', (req, res) => {
  const data = db.read();
  const t = data.tracks.find((x) => x.id === req.params.id);
  if (!t || !t.shareEnabled || !isReleased(t)) {
    return res.status(404).json({ error: 'Extrait indisponible' });
  }
  res.json({
    id: t.id,
    title: t.title,
    artist: t.artist,
    genre: t.genre,
    price: t.price,
    coverUrl: t.coverUrl,
    audioUrl: t.audioUrl, // l'extrait est borné à 30s côté client (watermark KORAWAVE)
    shareStart: t.shareStart || 0,
    duration: 30,
    verified: !!t.verified,
  });
});

// ===========================================================================
// CATALOGUE — lecture publique
// ===========================================================================
function withCounts(item, data, type) {
  const likes = data.likes.filter((l) => l.contentType === type && l.contentId === item.id).length;
  const comments = data.comments.filter(
    (c) => c.contentType === type && c.contentId === item.id && c.status !== 'deleted'
  ).length;
  const likedByMe = data._uid
    ? data.likes.some((l) => l.userId === data._uid && l.contentType === type && l.contentId === item.id)
    : false;
  return { ...item, likes, comments, likedByMe };
}

// Vue publique : un contenu non sorti n'expose PAS son média (verrouillé jusqu'à la date).
function publicTrack(t, data, userId) {
  const released = isReleased(t);
  return {
    ...withCounts(t, data, 'audio'),
    released,
    audioUrl: released ? t.audioUrl : null,
    owned: userId ? ownsContent(data, userId, 'audio', t.id) : false,
  };
}
function publicVideo(v, data, userId) {
  const released = isReleased(v);
  return {
    ...withCounts(v, data, 'video'),
    released,
    videoUrl: released ? v.videoUrl : null,
    owned: userId ? ownsContent(data, userId, 'video', v.id) : false,
  };
}

app.get('/api/tracks', auth(false), (req, res) => {
  const data = db.read();
  const uid = req.user?.id;
  data._uid = uid;
  const list = data.tracks
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((t) => {
      const pt = publicTrack(t, data, uid);
      if (t.ownerId) {
        const owner = data.users.find((u) => u.id === t.ownerId);
        pt.artistBattleWins = owner ? (owner.battleWins || 0) : 0;
      }
      return pt;
    });
  data._uid = null;
  res.json({ tracks: list });
});

app.get('/api/videos', auth(false), (req, res) => {
  const data = db.read();
  const uid = req.user?.id;
  data._uid = uid;
  const list = data.videos
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((v) => {
      const pv = publicVideo(v, data, uid);
      if (v.ownerId) {
        const owner = data.users.find((u) => u.id === v.ownerId);
        pv.artistBattleWins = owner ? (owner.battleWins || 0) : 0;
      }
      return pv;
    });
  data._uid = null;
  res.json({ videos: list });
});

// Incrémente le compteur d'écoutes
app.post('/api/tracks/:id/play', (req, res) => {
  const data = db.read();
  const t = data.tracks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Introuvable' });
  if (!isReleased(t)) return res.status(403).json({ error: 'Titre pas encore disponible' });
  t.plays = (t.plays || 0) + 1;
  if (!data.playEvents) data.playEvents = [];
  data.playEvents.push({ id: crypto.randomUUID(), trackId: t.id, artistId: t.ownerId || null, createdAt: new Date().toISOString() });
  db.write();
  res.json({ plays: t.plays });
});

app.post('/api/videos/:id/play', (req, res) => {
  const data = db.read();
  const v = data.videos.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Introuvable' });
  if (!isReleased(v)) return res.status(403).json({ error: 'Vidéo pas encore disponible' });
  v.plays = (v.plays || 0) + 1;
  db.write();
  res.json({ plays: v.plays });
});

// ---------------------------------------------------------------------------
// Helpers sociaux
// ---------------------------------------------------------------------------
function findContent(data, contentType, contentId) {
  return (contentType === 'audio' ? data.tracks : data.videos).find((x) => x.id === contentId);
}
function displayName(u) {
  if (!u) return 'Quelqu\'un';
  return u.role === 'artist' ? (u.artistName || u.name) : u.name;
}
// Notifie l'artiste propriétaire d'un contenu (like/commentaire). Pas d'auto-notif.
function notifyOwner(data, item, type, actor, extra = {}) {
  if (!item || !item.ownerId || item.ownerId === actor.id) return;
  data.notifications.push({
    id: crypto.randomUUID(),
    userId: item.ownerId,
    type, // 'like' | 'comment'
    actorName: displayName(actor),
    contentType: item.audioUrl !== undefined ? 'audio' : 'video',
    contentId: item.id,
    contentTitle: item.title,
    body: extra.body || '',
    read: false,
    createdAt: new Date().toISOString(),
  });
}

// Like / unlike (toggle) — utilisateur connecté
app.post('/api/like', auth(), (req, res) => {
  const data = db.read();
  const { contentType, contentId } = req.body || {};
  if (!['audio', 'video'].includes(contentType) || !contentId) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }
  const idx = data.likes.findIndex(
    (l) => l.userId === req.user.id && l.contentType === contentType && l.contentId === contentId
  );
  let liked;
  if (idx >= 0) {
    data.likes.splice(idx, 1);
    liked = false;
  } else {
    data.likes.push({
      id: crypto.randomUUID(),
      userId: req.user.id,
      contentType,
      contentId,
      createdAt: new Date().toISOString(),
    });
    liked = true;
    notifyOwner(data, findContent(data, contentType, contentId), 'like', req.user);
  }
  db.write();
  const count = data.likes.filter(
    (l) => l.contentType === contentType && l.contentId === contentId
  ).length;
  res.json({ liked, likes: count });
});

// ===========================================================================
// COMMENTAIRES (CLAUDE.md v1.1) — likes + commentaires, modération, anti-abus
// ===========================================================================

// Liste publique des commentaires d'un contenu
app.get('/api/comments', auth(false), (req, res) => {
  const data = db.read();
  const { contentType, contentId } = req.query || {};
  const list = data.comments
    .filter((c) => c.contentType === contentType && c.contentId === contentId && c.status !== 'deleted')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((c) => {
      const u = data.users.find((x) => x.id === c.userId);
      return {
        id: c.id,
        body: c.body,
        status: c.status,
        author: displayName(u),
        authorRole: u?.role || 'user',
        createdAt: c.createdAt,
        mine: req.user ? c.userId === req.user.id : false,
        reportedByMe: req.user ? (c.reports || []).includes(req.user.id) : false,
      };
    });
  res.json({ comments: list });
});

// Publier un commentaire — anti-abus : max 10 / heure / compte
app.post('/api/comments', auth(), (req, res) => {
  const data = db.read();
  let { contentType, contentId, body } = req.body || {};
  body = (body || '').trim();
  if (!['audio', 'video'].includes(contentType) || !contentId) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }
  if (!body) return res.status(400).json({ error: 'Commentaire vide' });
  if (body.length > 500) return res.status(400).json({ error: 'Commentaire trop long (max 500 caractères)' });
  const item = findContent(data, contentType, contentId);
  if (!item) return res.status(404).json({ error: 'Contenu introuvable' });

  const oneHourAgo = Date.now() - 3600 * 1000;
  const recent = data.comments.filter(
    (c) => c.userId === req.user.id && new Date(c.createdAt).getTime() > oneHourAgo
  ).length;
  if (recent >= 10) return res.status(429).json({ error: 'Limite atteinte (10 commentaires/heure)' });

  const comment = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    contentType,
    contentId,
    body,
    status: 'active',
    reports: [],
    createdAt: new Date().toISOString(),
  };
  data.comments.push(comment);
  notifyOwner(data, item, 'comment', req.user, { body });
  db.write();
  res.json({
    comment: {
      id: comment.id, body, status: 'active',
      author: displayName(req.user), authorRole: req.user.role,
      createdAt: comment.createdAt, mine: true, reportedByMe: false,
    },
  });
});

// Signaler un commentaire (modération manuelle ensuite)
app.post('/api/comments/:id/report', auth(), (req, res) => {
  const data = db.read();
  const c = data.comments.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  c.reports = c.reports || [];
  if (!c.reports.includes(req.user.id)) c.reports.push(req.user.id);
  if (c.status === 'active') c.status = 'flagged';
  db.write();
  res.json({ ok: true });
});

// Supprimer son propre commentaire
app.delete('/api/comments/:id', auth(), (req, res) => {
  const data = db.read();
  const c = data.comments.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  if (c.userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  c.status = 'deleted';
  db.write();
  res.json({ ok: true });
});

// ===========================================================================
// NOTIFICATIONS (like / commentaire) — destinataire = artiste
// ===========================================================================
app.get('/api/notifications', auth(), (req, res) => {
  const data = db.read();
  const list = data.notifications
    .filter((n) => n.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 40);
  res.json({ notifications: list, unread: list.filter((n) => !n.read).length });
});

app.post('/api/notifications/read', auth(), (req, res) => {
  const data = db.read();
  data.notifications.forEach((n) => { if (n.userId === req.user.id) n.read = true; });
  db.write();
  res.json({ ok: true });
});

// ===========================================================================
// ADMIN — modération des commentaires signalés
// ===========================================================================
app.get('/api/admin/comments', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const flagged = data.comments
    .filter((c) => c.status === 'flagged')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((c) => {
      const u = data.users.find((x) => x.id === c.userId);
      const item = findContent(data, c.contentType, c.contentId);
      return {
        id: c.id, body: c.body, author: displayName(u),
        reports: (c.reports || []).length,
        contentTitle: item?.title || '(supprimé)',
        createdAt: c.createdAt,
      };
    });
  res.json({ comments: flagged });
});

app.post('/api/admin/comments/:id/moderate', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const c = data.comments.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  const action = (req.body || {}).action;
  if (action === 'delete') c.status = 'deleted';
  else if (action === 'restore') { c.status = 'active'; c.reports = []; }
  else return res.status(400).json({ error: 'Action invalide' });
  db.write();
  res.json({ status: c.status });
});

// ===========================================================================
// PORTEFEUILLE KOINS + PAIEMENT MOBILE MONEY (INNOVATION_01 / 02)
//
// ⚠️ Le paiement est SIMULÉ (sandbox). En production : brancher Orange Money
// API v2, MTN MoMo API, Soutra API (webhooks HMAC + idempotence — SKILL_04).
// Règles KOINS (CLAUDE.md) : jamais de conversion KOINS->GNF, solde vérifié
// côté serveur, opérations atomiques.
// ===========================================================================

// Packs de recharge : 1 000 GNF = 1 000 KOINS + bonus fidélité
const KOIN_PACKS = [
  { id: 'p1', gnf: 1000, koins: 1000, bonus: 0 },
  { id: 'p2', gnf: 2000, koins: 2100, bonus: 5 },
  { id: 'p3', gnf: 5000, koins: 5500, bonus: 10 },
  { id: 'p4', gnf: 10000, koins: 11500, bonus: 15 },
];
const PAYMENT_METHODS = ['orange_money', 'mtn_momo', 'soutra_money'];
const REVENUE_SPLIT = { artist: 0.5, korawave: 0.4, ministry: 0.1 };

function ownsContent(data, userId, type, contentId) {
  return data.purchases.some(
    (p) => p.userId === userId && p.contentType === type && p.contentId === contentId
  );
}
function ownedIds(data, userId) {
  return {
    audio: data.purchases.filter((p) => p.userId === userId && p.contentType === 'audio').map((p) => p.contentId),
    video: data.purchases.filter((p) => p.userId === userId && p.contentType === 'video').map((p) => p.contentId),
  };
}

app.get('/api/koin-packs', (req, res) => res.json({ packs: KOIN_PACKS, methods: PAYMENT_METHODS }));

// Portefeuille de l'utilisateur courant
app.get('/api/wallet', auth(), (req, res) => {
  const data = db.read();
  const txs = data.koinTransactions
    .filter((t) => t.userId === req.user.id)
    .slice(-25)
    .reverse();
  res.json({
    balance: req.user.koins || 0,
    totalPurchased: req.user.totalPurchased || 0,
    transactions: txs,
    owned: ownedIds(data, req.user.id),
  });
});

// Recharge KOINS via Mobile Money (SIMULÉ)
app.post('/api/wallet/recharge', auth(), (req, res) => {
  const { packId, method, phone } = req.body || {};
  const pack = KOIN_PACKS.find((p) => p.id === packId);
  if (!pack) return res.status(400).json({ error: 'Pack invalide' });
  if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Moyen de paiement invalide' });
  if (!phone || !/^\+?\d{8,}$/.test(String(phone).replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Numéro de téléphone invalide' });
  }

  const data = db.read();
  const user = data.users.find((u) => u.id === req.user.id);

  // --- Simulation du paiement Mobile Money ---
  // En prod : POST vers l'API opérateur + attente du webhook de confirmation.
  const paymentRef = 'PAY-' + crypto.randomBytes(5).toString('hex').toUpperCase();

  // Crédit atomique du portefeuille
  user.koins = (user.koins || 0) + pack.koins;
  user.totalPurchased = (user.totalPurchased || 0) + pack.koins;
  data.koinTransactions.push({
    id: crypto.randomUUID(),
    userId: user.id,
    type: 'credit',
    amount: pack.koins,
    label: `Recharge ${pack.gnf} GNF${pack.bonus ? ` (+${pack.bonus}% bonus)` : ''}`,
    method,
    paymentRef,
    createdAt: new Date().toISOString(),
  });
  db.write();
  res.json({ balance: user.koins, credited: pack.koins, paymentRef, method });
});

// Achat permanent d'un contenu avec des KOINS
app.post('/api/purchase', auth(), (req, res) => {
  const { contentType, contentId } = req.body || {};
  if (!['audio', 'video'].includes(contentType) || !contentId) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }
  const data = db.read();
  const item = (contentType === 'audio' ? data.tracks : data.videos).find((x) => x.id === contentId);
  if (!item) return res.status(404).json({ error: 'Contenu introuvable' });
  if (ownsContent(data, req.user.id, contentType, contentId)) {
    return res.status(409).json({ error: 'Déjà acheté' });
  }
  const price = item.price || 0; // KOINS (1 KOIN = 1 GNF)
  const user = data.users.find((u) => u.id === req.user.id);
  if ((user.koins || 0) < price) {
    return res.status(402).json({ error: 'Solde KOINS insuffisant', need: price, balance: user.koins || 0 });
  }

  // Débit atomique + enregistrement de l'achat + répartition des revenus
  user.koins -= price;
  data.purchases.push({
    id: crypto.randomUUID(),
    userId: user.id,
    contentType,
    contentId,
    price,
    ownerId: item.ownerId || null,
    split: {
      artist: Math.round(price * REVENUE_SPLIT.artist),
      korawave: Math.round(price * REVENUE_SPLIT.korawave),
      ministry: Math.round(price * REVENUE_SPLIT.ministry),
    },
    createdAt: new Date().toISOString(),
  });
  data.koinTransactions.push({
    id: crypto.randomUUID(),
    userId: user.id,
    type: 'debit',
    amount: price,
    label: `Achat : ${item.title}`,
    createdAt: new Date().toISOString(),
  });
  db.write();
  res.json({ balance: user.koins, owned: true });
});

// Pourboire à un artiste (Tip Jar — INNOVATION_02)
app.post('/api/tip', auth(), (req, res) => {
  const { artistId, amount } = req.body || {};
  const amt = parseInt(amount, 10);
  if (!artistId || !amt || amt <= 0) return res.status(400).json({ error: 'Montant invalide' });
  const data = db.read();
  const artist = data.users.find((u) => u.id === artistId && u.role === 'artist');
  if (!artist) return res.status(404).json({ error: 'Artiste introuvable' });
  const user = data.users.find((u) => u.id === req.user.id);
  if (user.id === artist.id) return res.status(400).json({ error: 'Impossible de se soutenir soi-même' });
  if ((user.koins || 0) < amt) return res.status(402).json({ error: 'Solde KOINS insuffisant' });

  user.koins -= amt;
  data.tips.push({
    id: crypto.randomUUID(),
    fromUserId: user.id,
    artistId: artist.id,
    amount: amt,
    split: {
      artist: Math.round(amt * REVENUE_SPLIT.artist),
      korawave: Math.round(amt * REVENUE_SPLIT.korawave),
      ministry: Math.round(amt * REVENUE_SPLIT.ministry),
    },
    createdAt: new Date().toISOString(),
  });
  data.koinTransactions.push({
    id: crypto.randomUUID(),
    userId: user.id,
    type: 'debit',
    amount: amt,
    label: `Pourboire à ${artist.artistName || artist.name}`,
    createdAt: new Date().toISOString(),
  });
  db.write();
  res.json({ balance: user.koins });
});

// ===========================================================================
// Helpers de création de contenu (partagés admin + artiste)
// owner = null  -> upload admin (nom d'artiste libre via le formulaire)
// owner = user  -> upload artiste (rattaché à son compte, nom de scène forcé)
// ===========================================================================

// Release Scheduler (INNOVATION_11) : un contenu peut avoir une date de sortie.
// Avant cette date il est "programmé" (non lisible publiquement).
function parseReleaseAt(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d > new Date() ? d.toISOString() : null; // une date passée = sortie immédiate
}
function isReleased(item) {
  return !item.releaseAt || new Date(item.releaseAt) <= new Date();
}

function createTrack(req, owner) {
  const audioFile = req.files?.audio?.[0];
  const coverFile = req.files?.cover?.[0];
  if (!audioFile) return { error: 'Fichier audio requis' };
  const data = db.read();
  const track = {
    id: crypto.randomUUID(),
    title: (req.body.title || 'Sans titre').trim(),
    artist: owner ? owner.artistName || owner.name : (req.body.artist || 'Artiste inconnu').trim(),
    ownerId: owner ? owner.id : null,
    verified: owner ? !!owner.verified : true, // contenu admin = officiel
    genre: (req.body.genre || 'Autre').trim(),
    price: parseInt(req.body.price, 10) || 500, // 500 GNF (CLAUDE.md)
    audioUrl: `/uploads/audio/${audioFile.filename}`,
    coverUrl: coverFile ? `/uploads/covers/${coverFile.filename}` : null,
    releaseAt: parseReleaseAt(req.body.releaseAt),
    shareEnabled: false,
    shareStart: 0,
    shares: 0,
    plays: 0,
    createdAt: new Date().toISOString(),
  };
  data.tracks.push(track);
  db.write();
  // Notifier les abonnés si c'est un artiste qui publie immédiatement
  if (owner && isReleased(track)) {
    notifyFollowers(owner.id, {
      title: '🎵 Nouveau titre — ' + (owner.artistName || owner.name),
      body: track.title + ' est maintenant disponible sur KORAWAVE',
      url: '/',
    });
  }
  return { track };
}

function createVideo(req, owner) {
  const videoFile = req.files?.video?.[0];
  const thumbFile = req.files?.thumb?.[0];
  if (!videoFile) return { error: 'Fichier vidéo requis' };
  const data = db.read();
  const video = {
    id: crypto.randomUUID(),
    title: (req.body.title || 'Sans titre').trim(),
    artist: owner ? owner.artistName || owner.name : (req.body.artist || 'Artiste inconnu').trim(),
    ownerId: owner ? owner.id : null,
    verified: owner ? !!owner.verified : true,
    genre: (req.body.genre || 'Clip').trim(),
    price: parseInt(req.body.price, 10) || 1000, // 1 000 GNF (CLAUDE.md)
    videoUrl: `/uploads/videos/${videoFile.filename}`,
    thumbUrl: thumbFile ? `/uploads/thumbs/${thumbFile.filename}` : null,
    releaseAt: parseReleaseAt(req.body.releaseAt),
    plays: 0,
    createdAt: new Date().toISOString(),
  };
  data.videos.push(video);
  db.write();
  if (owner && isReleased(video)) {
    notifyFollowers(owner.id, {
      title: '🎬 Nouveau clip — ' + (owner.artistName || owner.name),
      body: video.title + ' est maintenant disponible sur KORAWAVE',
      url: '/',
    });
  }
  return { video };
}

// ===========================================================================
// ADMIN — gestion catalogue
// ===========================================================================

// Ajout d'un AUDIO : fichier audio + image de couverture
app.post(
  '/api/admin/tracks',
  auth(),
  adminOnly,
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
  (req, res) => {
    const r = createTrack(req, null);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ track: r.track });
  }
);

// Ajout d'une VIDEO : fichier vidéo + miniature optionnelle
app.post(
  '/api/admin/videos',
  auth(),
  adminOnly,
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
  (req, res) => {
    const r = createVideo(req, null);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ video: r.video });
  }
);

// Liste des artistes + vérification (badge)
app.get('/api/admin/artists', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const artists = data.users
    .filter((u) => u.role === 'artist')
    .map((u) => {
      const tracks = data.tracks.filter((t) => t.ownerId === u.id).length;
      const videos = data.videos.filter((v) => v.ownerId === u.id).length;
      return { ...publicUser(u), tracks, videos };
    });
  res.json({ artists });
});

app.post('/api/admin/artists/:id/verify', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const u = data.users.find((x) => x.id === req.params.id && x.role === 'artist');
  if (!u) return res.status(404).json({ error: 'Artiste introuvable' });
  u.verified = !u.verified;
  // propage le badge sur ses contenus
  data.tracks.forEach((t) => { if (t.ownerId === u.id) t.verified = u.verified; });
  data.videos.forEach((v) => { if (v.ownerId === u.id) v.verified = u.verified; });
  db.write();
  res.json({ verified: u.verified });
});

// Suppression
app.delete('/api/admin/tracks/:id', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const idx = data.tracks.findIndex((t) => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Introuvable' });
  removeUpload(data.tracks[idx].audioUrl);
  removeUpload(data.tracks[idx].coverUrl);
  data.tracks.splice(idx, 1);
  db.write();
  res.json({ ok: true });
});

app.delete('/api/admin/videos/:id', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const idx = data.videos.findIndex((v) => v.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Introuvable' });
  removeUpload(data.videos[idx].videoUrl);
  removeUpload(data.videos[idx].thumbUrl);
  data.videos.splice(idx, 1);
  db.write();
  res.json({ ok: true });
});

function removeUpload(url) {
  if (!url) return;
  const p = path.join(__dirname, url.replace(/^\//, ''));
  fs.promises.unlink(p).catch(() => {});
}

// Statistiques du dashboard
app.get('/api/admin/stats', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const audioPlays = data.tracks.reduce((s, t) => s + (t.plays || 0), 0);
  const videoPlays = data.videos.reduce((s, v) => s + (v.plays || 0), 0);
  // Revenu théorique = prix * écoutes (illustratif)
  const revenue =
    data.tracks.reduce((s, t) => s + (t.price || 0) * (t.plays || 0), 0) +
    data.videos.reduce((s, v) => s + (v.price || 0) * (v.plays || 0), 0);

  // KOINS & ventes réelles
  const koinsSold = data.koinTransactions.filter((t) => t.type === 'credit').reduce((s, t) => s + t.amount, 0);
  const salesRevenue = data.purchases.reduce((s, p) => s + (p.price || 0), 0);
  const tipsTotal = data.tips.reduce((s, t) => s + (t.amount || 0), 0);

  res.json({
    users: data.users.filter((u) => u.role === 'user').length,
    artists: data.users.filter((u) => u.role === 'artist').length,
    tracks: data.tracks.length,
    videos: data.videos.length,
    totalPlays: audioPlays + videoPlays,
    likes: data.likes.length,
    revenue,
    artistShare: Math.round(revenue * 0.5),
    korawaveShare: Math.round(revenue * 0.4),
    ministryShare: Math.round(revenue * 0.1),
    koinsSold,
    sales: data.purchases.length,
    salesRevenue,
    tipsTotal,
    recentUsers: data.users
      .filter((u) => u.role === 'user')
      .slice(-5)
      .reverse()
      .map(publicUser),
  });
});

// ===========================================================================
// FAN PACK (INNOVATION_03)  — bundles artiste avec réduction
// ===========================================================================

const FAN_PACK_DISCOUNT_MIN = 15;
const FAN_PACK_DISCOUNT_MAX = 30;
const FAN_PACK_TRACKS_MIN = 2;

function publicFanPack(fp, data, userId) {
  const artist = data.users.find((u) => u.id === fp.artistId);
  const tracks = fp.trackIds
    .map((tid) => data.tracks.find((t) => t.id === tid))
    .filter(Boolean)
    .map((t) => ({ id: t.id, title: t.title, coverUrl: t.coverUrl, price: t.price }));
  const originalPrice = tracks.reduce((s, t) => s + t.price, 0);
  const price = Math.round(originalPrice * (1 - fp.discountPct / 100));
  const isFan = userId
    ? data.fanPackPurchases.some((p) => p.userId === userId && p.packId === fp.id)
    : false;
  return {
    id: fp.id,
    artistId: fp.artistId,
    artistName: artist ? (artist.artistName || artist.name) : 'Artiste',
    artistVerified: artist ? !!artist.verified : false,
    title: fp.title,
    description: fp.description || '',
    tracks,
    trackCount: tracks.length,
    discountPct: fp.discountPct,
    originalPrice,
    price,
    status: fp.status,
    isFan,
    createdAt: fp.createdAt,
  };
}

// Liste des packs actifs (public)
app.get('/api/fan-packs', auth(false), (req, res) => {
  const data = db.read();
  const uid = req.user?.id || null;
  const packs = data.fanPacks
    .filter((fp) => fp.status === 'active')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((fp) => publicFanPack(fp, data, uid));
  res.json({ packs });
});

// Détail d'un pack
app.get('/api/fan-packs/:id', auth(false), (req, res) => {
  const data = db.read();
  const fp = data.fanPacks.find((x) => x.id === req.params.id);
  if (!fp) return res.status(404).json({ error: 'Fan Pack introuvable' });
  res.json({ pack: publicFanPack(fp, data, req.user?.id || null) });
});

// Artiste crée un pack
app.post('/api/artist/fan-packs', auth(), artistOnly, (req, res) => {
  const { title, description, trackIds, discountPct } = req.body || {};
  if (!title || !trackIds || !Array.isArray(trackIds)) {
    return res.status(400).json({ error: 'title et trackIds requis' });
  }
  if (trackIds.length < FAN_PACK_TRACKS_MIN) {
    return res.status(400).json({ error: `Minimum ${FAN_PACK_TRACKS_MIN} titres requis` });
  }
  const discount = Math.min(FAN_PACK_DISCOUNT_MAX, Math.max(FAN_PACK_DISCOUNT_MIN, parseInt(discountPct, 10) || 20));
  const data = db.read();
  const myTracks = data.tracks.filter((t) => t.ownerId === req.user.id);
  const validIds = trackIds.filter((id) => myTracks.some((t) => t.id === id));
  if (validIds.length < FAN_PACK_TRACKS_MIN) {
    return res.status(400).json({ error: 'Sélectionne au moins 2 de tes propres titres' });
  }
  const fp = {
    id: crypto.randomUUID(),
    artistId: req.user.id,
    title: title.trim(),
    description: (description || '').trim(),
    trackIds: validIds,
    discountPct: discount,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  data.fanPacks.push(fp);
  db.write();
  res.json({ pack: publicFanPack(fp, data, req.user.id) });
});

// Artiste supprime son pack
app.delete('/api/artist/fan-packs/:id', auth(), artistOnly, (req, res) => {
  const data = db.read();
  const idx = data.fanPacks.findIndex((fp) => fp.id === req.params.id && fp.artistId === req.user.id);
  if (idx < 0) return res.status(404).json({ error: 'Pack introuvable' });
  data.fanPacks.splice(idx, 1);
  db.write();
  res.json({ ok: true });
});

// Acheter un fan pack (KOINS)
app.post('/api/purchase-pack', auth(), (req, res) => {
  const { packId } = req.body || {};
  if (!packId) return res.status(400).json({ error: 'packId requis' });
  const data = db.read();
  const fp = data.fanPacks.find((x) => x.id === packId && x.status === 'active');
  if (!fp) return res.status(404).json({ error: 'Fan Pack introuvable' });

  // Anti-double-achat
  if (data.fanPackPurchases.find((p) => p.userId === req.user.id && p.packId === packId)) {
    return res.status(409).json({ error: 'Tu es déjà Fan Officiel de cet artiste !' });
  }

  const tracks = fp.trackIds.map((id) => data.tracks.find((t) => t.id === id)).filter(Boolean);
  const originalPrice = tracks.reduce((s, t) => s + t.price, 0);
  const price = Math.round(originalPrice * (1 - fp.discountPct / 100));

  const user = data.users.find((u) => u.id === req.user.id);
  if ((user.koins || 0) < price) return res.status(402).json({ error: 'Solde KOINS insuffisant' });

  user.koins -= price;

  // Crée les achats individuels de chaque titre (si pas déjà acheté)
  tracks.forEach((t) => {
    if (!data.purchases.find((p) => p.userId === user.id && p.contentId === t.id)) {
      data.purchases.push({
        id: crypto.randomUUID(),
        userId: user.id,
        contentType: 'audio',
        contentId: t.id,
        price: t.price,
        packId,
        createdAt: new Date().toISOString(),
      });
    }
  });

  // Enregistre l'achat du pack (pour le badge)
  data.fanPackPurchases.push({
    id: crypto.randomUUID(),
    userId: user.id,
    packId,
    artistId: fp.artistId,
    price,
    createdAt: new Date().toISOString(),
  });

  // Transaction KOINS
  const artist = data.users.find((u) => u.id === fp.artistId);
  data.koinTransactions.push({
    id: crypto.randomUUID(),
    userId: user.id,
    type: 'debit',
    amount: price,
    label: `Fan Pack « ${fp.title} » — ${fp.discountPct}% de réduction`,
    createdAt: new Date().toISOString(),
  });

  // Répartition revenus
  const split = {
    artist: Math.round(price * REVENUE_SPLIT.artist),
    korawave: Math.round(price * REVENUE_SPLIT.korawave),
    ministry: Math.round(price * REVENUE_SPLIT.ministry),
  };

  // Notification à l'artiste
  if (artist && artist.id !== user.id) {
    data.notifications.push({
      id: crypto.randomUUID(),
      userId: artist.id,
      type: 'fan_pack',
      contentType: 'fanpack',
      contentId: packId,
      contentTitle: fp.title,
      actorId: user.id,
      actorName: user.name || user.phone || 'Un fan',
      body: `est devenu Fan Officiel avec ton pack « ${fp.title} »`,
      read: false,
      createdAt: new Date().toISOString(),
    });
  }

  db.write();
  res.json({ balance: user.koins, split, artistName: artist?.artistName || artist?.name });
});

// ===========================================================================
// KORAWAVE EVENTS (INNOVATION_09) — billetterie concerts
// ===========================================================================

const EVENTS_COMMISSION = 0.15;

function publicEvent(ev, data, userId) {
  const sold = data.tickets.filter((t) => t.eventId === ev.id && t.status !== 'cancelled').length;
  const myTicket = userId
    ? data.tickets.find((t) => t.eventId === ev.id && t.userId === userId && t.status !== 'cancelled')
    : null;
  return {
    id: ev.id,
    title: ev.title,
    description: ev.description || '',
    artist: ev.artist,
    venue: ev.venue,
    date: ev.date,
    coverUrl: ev.coverUrl || null,
    price: ev.price,
    capacity: ev.capacity,
    ticketsSold: sold,
    spotsLeft: Math.max(0, ev.capacity - sold),
    status: ev.status,
    createdAt: ev.createdAt,
    myTicket: myTicket
      ? { id: myTicket.id, qrCode: myTicket.qrCode, status: myTicket.status, purchasedAt: myTicket.purchasedAt }
      : null,
  };
}

// Liste des événements (public)
app.get('/api/events', auth(false), (req, res) => {
  const data = db.read();
  const uid = req.user?.id || null;
  const events = data.events
    .filter((ev) => ev.status !== 'cancelled')
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((ev) => publicEvent(ev, data, uid));
  res.json({ events });
});

// Détail d'un événement
app.get('/api/events/:id', auth(false), (req, res) => {
  const data = db.read();
  const ev = data.events.find((x) => x.id === req.params.id);
  if (!ev) return res.status(404).json({ error: 'Événement introuvable' });
  res.json({ event: publicEvent(ev, data, req.user?.id || null) });
});

// Admin crée un événement
app.post(
  '/api/admin/events',
  auth(), adminOnly,
  upload.fields([{ name: 'cover', maxCount: 1 }]),
  (req, res) => {
    const { title, description, artist, venue, date, price, capacity } = req.body || {};
    if (!title || !venue || !date || price == null || !capacity) {
      return res.status(400).json({ error: 'title, venue, date, price, capacity requis' });
    }
    const data = db.read();
    const coverFile = req.files?.cover?.[0];
    const ev = {
      id: crypto.randomUUID(),
      title: title.trim(),
      description: (description || '').trim(),
      artist: (artist || 'KORAWAVE').trim(),
      venue: venue.trim(),
      date,
      coverUrl: coverFile ? `/uploads/covers/${coverFile.filename}` : null,
      price: parseInt(price, 10) || 0,
      capacity: parseInt(capacity, 10) || 100,
      status: 'upcoming',
      createdAt: new Date().toISOString(),
    };
    data.events.push(ev);
    db.write();
    res.json({ event: publicEvent(ev, data, null) });
  }
);

// Admin modifie le statut d'un événement
app.patch('/api/admin/events/:id', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const ev = data.events.find((x) => x.id === req.params.id);
  if (!ev) return res.status(404).json({ error: 'Événement introuvable' });
  const { status } = req.body || {};
  if (status) ev.status = status;
  db.write();
  res.json({ event: publicEvent(ev, data, null) });
});

// Admin supprime un événement
app.delete('/api/admin/events/:id', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const idx = data.events.findIndex((ev) => ev.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Événement introuvable' });
  data.events.splice(idx, 1);
  db.write();
  res.json({ ok: true });
});

// Acheter un billet
app.post('/api/purchase-ticket', auth(), (req, res) => {
  const { eventId } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'eventId requis' });
  const data = db.read();
  const ev = data.events.find((x) => x.id === eventId && x.status === 'upcoming');
  if (!ev) return res.status(404).json({ error: 'Événement introuvable ou terminé' });

  if (data.tickets.find((t) => t.eventId === eventId && t.userId === req.user.id && t.status !== 'cancelled')) {
    return res.status(409).json({ error: 'Tu as déjà un billet pour cet événement' });
  }
  const sold = data.tickets.filter((t) => t.eventId === eventId && t.status !== 'cancelled').length;
  if (sold >= ev.capacity) return res.status(400).json({ error: 'Événement complet !' });

  const user = data.users.find((u) => u.id === req.user.id);
  if ((user.koins || 0) < ev.price) return res.status(402).json({ error: 'Solde KOINS insuffisant' });

  user.koins -= ev.price;

  const ticketId = crypto.randomUUID();
  const qrCode = `KW:EV:${eventId}:TK:${ticketId}:UID:${req.user.id}`;
  const ticket = {
    id: ticketId,
    eventId,
    userId: req.user.id,
    qrCode,
    price: ev.price,
    status: 'valid',
    purchasedAt: new Date().toISOString(),
  };
  data.tickets.push(ticket);

  data.koinTransactions.push({
    id: crypto.randomUUID(),
    userId: req.user.id,
    type: 'debit',
    amount: ev.price,
    label: `🎟️ Billet — ${ev.title} · ${ev.venue}`,
    createdAt: new Date().toISOString(),
  });

  db.write();
  res.json({ ticket: { id: ticket.id, qrCode, status: 'valid', purchasedAt: ticket.purchasedAt }, balance: user.koins });
});

// Mes billets
app.get('/api/my-tickets', auth(), (req, res) => {
  const data = db.read();
  const myTickets = data.tickets
    .filter((t) => t.userId === req.user.id && t.status !== 'cancelled')
    .map((t) => {
      const ev = data.events.find((e) => e.id === t.eventId);
      return { ...t, event: ev ? publicEvent(ev, data, req.user.id) : null };
    })
    .sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt));
  res.json({ tickets: myTickets });
});

// Admin valide un billet au scanner
app.post('/api/admin/events/:id/scan', auth(), adminOnly, (req, res) => {
  const { qrCode } = req.body || {};
  const data = db.read();
  const ticket = data.tickets.find((t) => t.eventId === req.params.id && t.qrCode === qrCode);
  if (!ticket) return res.status(404).json({ error: 'Billet invalide ou introuvable' });
  if (ticket.status === 'used') return res.status(409).json({ error: 'Billet déjà scanné', ticket });
  ticket.status = 'used';
  db.write();
  res.json({ ok: true, ticket });
});

// ===========================================================================
// HUMEUR RADIO (INNOVATION_05) — playlist infinie par humeur
// ===========================================================================

const MOOD_GENRES = {
  joyeux:      ['Afrobeats', 'Coupé-décalé'],
  focus:       ['Mode Griot', 'Jazz'],
  melancolique: ['Reggae', 'Mandingue'],
  fete:        ['Afrobeats', 'Hip-hop', 'Coupé-décalé', 'Gospel'],
  reveil:      ['Afrobeats', 'Reggae', 'Gospel'],
  sport:       ['Hip-hop', 'Afrobeats'],
  nuit:        ['Jazz', 'Mode Griot', 'Reggae'],
};

app.get('/api/radio', auth(false), (req, res) => {
  const mood = (req.query.mood || '').toLowerCase();
  const data = db.read();
  const genres = MOOD_GENRES[mood];
  let tracks = data.tracks.filter((t) => isReleased(t));

  if (genres && genres.length) {
    const matched = tracks.filter((t) => genres.some((g) => (t.genre || '').toLowerCase() === g.toLowerCase()));
    // fallback si pas assez de titres pour cette humeur
    tracks = matched.length >= 2 ? matched : tracks;
  }

  // Shuffle Fisher-Yates
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  }

  const uid = req.user?.id || null;
  data._uid = uid;
  const list = tracks.map((t) => publicTrack(t, data, uid));
  data._uid = null;
  res.json({ tracks: list, mood, genres: genres || [] });
});

// ===========================================================================
// KORAWAVE BATTLE (INNOVATION_06)  — duels d'artistes
// ===========================================================================

function autoCloseBattles(data) {
  let changed = false;
  data.battles.forEach((b) => {
    if (b.status === 'active' && new Date(b.endsAt) <= new Date()) {
      const v1 = data.battleVotes.filter((v) => v.battleId === b.id && v.votedTrackId === b.track1Id).length;
      const v2 = data.battleVotes.filter((v) => v.battleId === b.id && v.votedTrackId === b.track2Id).length;
      b.status = 'ended';
      b.winnerId = v1 > v2 ? b.artist1Id : v2 > v1 ? b.artist2Id : null;
      if (b.winnerId) {
        const w = data.users.find((u) => u.id === b.winnerId);
        if (w) {
          w.battleWins = (w.battleWins || 0) + 1;
          data.notifications.push({
            id: crypto.randomUUID(),
            userId: w.id,
            type: 'battle_win',
            contentType: 'battle',
            contentId: b.id,
            contentTitle: b.theme,
            actorId: null,
            actorName: 'KORAWAVE',
            body: `\u{1F3C6} Tu as remporté le KORAWAVE Battle « ${b.theme} » !`,
            read: false,
            createdAt: new Date().toISOString(),
          });
        }
      }
      changed = true;
    }
  });
  return changed;
}

function publicBattle(b, data, userId) {
  const v1 = data.battleVotes.filter((v) => v.battleId === b.id && v.votedTrackId === b.track1Id).length;
  const v2 = data.battleVotes.filter((v) => v.battleId === b.id && v.votedTrackId === b.track2Id).length;
  const myVoteObj = userId ? data.battleVotes.find((v) => v.battleId === b.id && v.userId === userId) : null;
  const hasVoted = !!myVoteObj;
  const isEnded = b.status === 'ended' || new Date(b.endsAt) <= new Date();

  const t1 = data.tracks.find((t) => t.id === b.track1Id) || null;
  const t2 = data.tracks.find((t) => t.id === b.track2Id) || null;
  const a1 = data.users.find((u) => u.id === b.artist1Id) || null;
  const a2 = data.users.find((u) => u.id === b.artist2Id) || null;

  const trackInfo = (t, unlocked) => t ? {
    id: t.id, title: t.title, artist: t.artist,
    coverUrl: t.coverUrl, genre: t.genre,
    audioUrl: (hasVoted || isEnded) && unlocked ? t.audioUrl : null,
  } : null;

  return {
    id: b.id, theme: b.theme, endsAt: b.endsAt, createdAt: b.createdAt,
    status: isEnded ? 'ended' : 'active',
    winnerId: b.winnerId,
    track1Id: b.track1Id, track2Id: b.track2Id,
    artist1Id: b.artist1Id, artist2Id: b.artist2Id,
    votes1: v1, votes2: v2, totalVotes: v1 + v2,
    myVote: myVoteObj ? myVoteObj.votedTrackId : null,
    hasVoted,
    track1: trackInfo(t1, true),
    track2: trackInfo(t2, true),
    artist1Name: a1 ? (a1.artistName || a1.name) : (t1?.artist || 'Artiste 1'),
    artist2Name: a2 ? (a2.artistName || a2.name) : (t2?.artist || 'Artiste 2'),
    artist1Verified: a1 ? !!a1.verified : false,
    artist2Verified: a2 ? !!a2.verified : false,
    artist1Wins: a1 ? (a1.battleWins || 0) : 0,
    artist2Wins: a2 ? (a2.battleWins || 0) : 0,
  };
}

// Lister les battles (public)
app.get('/api/battles', auth(false), (req, res) => {
  const data = db.read();
  if (autoCloseBattles(data)) db.write();
  const uid = req.user?.id || null;
  const battles = [...data.battles]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((b) => publicBattle(b, data, uid));
  res.json({ battles });
});

// Détail d'un battle
app.get('/api/battles/:id', auth(false), (req, res) => {
  const data = db.read();
  const b = data.battles.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Battle introuvable' });
  res.json({ battle: publicBattle(b, data, req.user?.id || null) });
});

// Voter dans un battle (1 vote/compte — débloque l'écoute complète des 2 titres)
app.post('/api/battles/:id/vote', auth(), (req, res) => {
  const { trackId } = req.body || {};
  if (!trackId) return res.status(400).json({ error: 'trackId requis' });
  const data = db.read();
  const b = data.battles.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Battle introuvable' });
  if (b.status === 'ended' || new Date(b.endsAt) <= new Date()) {
    return res.status(400).json({ error: 'Ce battle est terminé' });
  }
  if (trackId !== b.track1Id && trackId !== b.track2Id) {
    return res.status(400).json({ error: 'Track invalide pour ce battle' });
  }
  if (data.battleVotes.find((v) => v.battleId === b.id && v.userId === req.user.id)) {
    return res.status(409).json({ error: 'Tu as déjà voté dans ce battle' });
  }

  data.battleVotes.push({
    id: crypto.randomUUID(),
    battleId: b.id,
    userId: req.user.id,
    votedTrackId: trackId,
    createdAt: new Date().toISOString(),
  });

  // Notifier l'artiste qui reçoit un vote
  const artistId = trackId === b.track1Id ? b.artist1Id : b.artist2Id;
  const chosenTrack = data.tracks.find((t) => t.id === trackId);
  if (artistId && artistId !== req.user.id) {
    data.notifications.push({
      id: crypto.randomUUID(),
      userId: artistId,
      type: 'battle_vote',
      contentType: 'battle',
      contentId: b.id,
      contentTitle: b.theme,
      actorId: req.user.id,
      actorName: req.user.name || req.user.phone || 'Un fan',
      body: `a voté pour « ${chosenTrack?.title || 'ton titre'} » dans le Battle`,
      read: false,
      createdAt: new Date().toISOString(),
    });
  }
  db.write();
  res.json({ ok: true, battle: publicBattle(b, data, req.user.id) });
});

// Admin : créer un battle
app.post('/api/admin/battles', auth(), adminOnly, (req, res) => {
  const { theme, track1Id, track2Id, durationHours } = req.body || {};
  if (!theme || !track1Id || !track2Id) {
    return res.status(400).json({ error: 'theme, track1Id et track2Id requis' });
  }
  if (track1Id === track2Id) return res.status(400).json({ error: 'Les deux tracks doivent être différentes' });
  const data = db.read();
  const t1 = data.tracks.find((t) => t.id === track1Id);
  const t2 = data.tracks.find((t) => t.id === track2Id);
  if (!t1 || !t2) return res.status(404).json({ error: 'Track(s) introuvable(s)' });

  const hours = Math.max(1, Math.min(168, parseInt(durationHours, 10) || 72));
  const b = {
    id: crypto.randomUUID(),
    theme: theme.trim(),
    track1Id, artist1Id: t1.ownerId || null,
    track2Id, artist2Id: t2.ownerId || null,
    endsAt: new Date(Date.now() + hours * 3600000).toISOString(),
    status: 'active', winnerId: null,
    createdAt: new Date().toISOString(),
  };
  data.battles.push(b);

  // Notifier les artistes participants
  [{ artistId: b.artist1Id, title: t1.title }, { artistId: b.artist2Id, title: t2.title }]
    .forEach(({ artistId, title }) => {
      if (!artistId) return;
      data.notifications.push({
        id: crypto.randomUUID(), userId: artistId,
        type: 'battle_invite', contentType: 'battle',
        contentId: b.id, contentTitle: b.theme, actorId: null, actorName: 'KORAWAVE',
        body: `Ton titre « ${title} » participe au KORAWAVE Battle « ${theme} » !`,
        read: false, createdAt: new Date().toISOString(),
      });
    });
  db.write();
  res.json({ battle: publicBattle(b, data, null) });
});

// Admin : clôturer un battle manuellement
app.post('/api/admin/battles/:id/close', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const b = data.battles.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Battle introuvable' });
  if (b.status === 'ended') return res.status(400).json({ error: 'Battle déjà terminé' });

  const v1 = data.battleVotes.filter((v) => v.battleId === b.id && v.votedTrackId === b.track1Id).length;
  const v2 = data.battleVotes.filter((v) => v.battleId === b.id && v.votedTrackId === b.track2Id).length;
  b.status = 'ended';
  b.endsAt = new Date().toISOString();
  b.winnerId = v1 > v2 ? b.artist1Id : v2 > v1 ? b.artist2Id : null;

  if (b.winnerId) {
    const winner = data.users.find((u) => u.id === b.winnerId);
    if (winner) {
      winner.battleWins = (winner.battleWins || 0) + 1;
      data.notifications.push({
        id: crypto.randomUUID(), userId: winner.id,
        type: 'battle_win', contentType: 'battle',
        contentId: b.id, contentTitle: b.theme, actorId: null, actorName: 'KORAWAVE',
        body: `\u{1F3C6} Tu as remporté le KORAWAVE Battle « ${b.theme} » !`,
        read: false, createdAt: new Date().toISOString(),
      });
    }
  }
  db.write();
  res.json({ battle: publicBattle(b, data, null) });
});

// ---------------------------------------------------------------------------
// ANALYTICS (INNOVATION_10)
// ---------------------------------------------------------------------------

function makeBuckets(days) {
  const now = new Date();
  const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(d.toISOString().slice(0, 10));
  }
  return labels;
}

// Admin analytics — revenus/écoutes/nouveaux utilisateurs sur 7j ou 30j
app.get('/api/admin/analytics', auth(), adminOnly, (req, res) => {
  const days = Math.min(parseInt(req.query.period) || 7, 90);
  const data = db.read();
  const now = new Date();
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - days);
  const labels = makeBuckets(days);
  const zeroMap = () => Object.fromEntries(labels.map((l) => [l, 0]));

  // Revenus (débits KOINS)
  const revMap = zeroMap();
  (data.koinTransactions || [])
    .filter((t) => t.type === 'debit' && new Date(t.createdAt) >= cutoff)
    .forEach((t) => { const k = t.createdAt.slice(0, 10); if (revMap[k] !== undefined) revMap[k] += t.amount; });

  // Nouveaux utilisateurs
  const usrMap = zeroMap();
  (data.users || []).forEach((u) => {
    const k = (u.createdAt || '').slice(0, 10);
    if (usrMap[k] !== undefined) usrMap[k]++;
  });

  // Écoutes — depuis playEvents si disponible, sinon distribution demo des plays totaux
  const playsMap = zeroMap();
  const pe = data.playEvents || [];
  if (pe.length) {
    pe.filter((e) => new Date(e.createdAt) >= cutoff)
      .forEach((e) => { const k = e.createdAt.slice(0, 10); if (playsMap[k] !== undefined) playsMap[k]++; });
  } else {
    const total = (data.tracks || []).reduce((s, t) => s + (t.plays || 0), 0);
    labels.forEach((l, i) => { playsMap[l] = Math.round(total / days * (0.4 + 0.6 * i / Math.max(days - 1, 1))); });
  }

  // Période précédente (trend)
  const prevCutoff = new Date(cutoff); prevCutoff.setDate(prevCutoff.getDate() - days);
  const periodRev = Object.values(revMap).reduce((a, b) => a + b, 0);
  const prevRev = (data.koinTransactions || [])
    .filter((t) => t.type === 'debit' && new Date(t.createdAt) >= prevCutoff && new Date(t.createdAt) < cutoff)
    .reduce((s, t) => s + t.amount, 0);
  const revTrend = prevRev > 0 ? Math.round((periodRev - prevRev) / prevRev * 100) : null;

  // Stats globales
  const totalRev = (data.koinTransactions || []).filter((t) => t.type === 'debit').reduce((s, t) => s + t.amount, 0);
  const totalPlays = (data.tracks || []).reduce((s, t) => s + (t.plays || 0), 0);
  const buyerIds = new Set((data.purchases || []).map((p) => p.userId));
  const conversionRate = data.users.length > 0 ? Math.round(buyerIds.size / data.users.length * 100) : 0;
  const dailyAvg = periodRev / days;
  const revenueProjection30 = Math.round(dailyAvg * 30);

  const topTracks = [...(data.tracks || [])]
    .sort((a, b) => (b.plays || 0) - (a.plays || 0))
    .slice(0, 5)
    .map((t) => ({ title: t.title, artist: t.artist, plays: t.plays || 0 }));

  res.json({
    labels, days,
    revenue: labels.map((l) => revMap[l]),
    plays: labels.map((l) => playsMap[l]),
    newUsers: labels.map((l) => usrMap[l]),
    totalRevenue: totalRev,
    periodRevenue: periodRev,
    revenueTrend: revTrend,
    totalPlays,
    totalUsers: data.users.length,
    conversionRate,
    revenueProjection30,
    topTracks,
  });
});

// Artist analytics — écoutes et revenus de ses titres sur 7j ou 30j
app.get('/api/artist/analytics', auth(), artistOnly, (req, res) => {
  const days = Math.min(parseInt(req.query.period) || 7, 90);
  const data = db.read();
  const now = new Date();
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - days);
  const labels = makeBuckets(days);
  const zeroMap = () => Object.fromEntries(labels.map((l) => [l, 0]));

  const myTracks = (data.tracks || []).filter((t) => t.ownerId === req.user.id);
  const myIds = new Set(myTracks.map((t) => t.id));

  // Écoutes
  const playsMap = zeroMap();
  const pe = data.playEvents || [];
  if (pe.length) {
    pe.filter((e) => myIds.has(e.trackId) && new Date(e.createdAt) >= cutoff)
      .forEach((e) => { const k = e.createdAt.slice(0, 10); if (playsMap[k] !== undefined) playsMap[k]++; });
  } else {
    const total = myTracks.reduce((s, t) => s + (t.plays || 0), 0);
    labels.forEach((l, i) => { playsMap[l] = Math.round(total / days * (0.4 + 0.6 * i / Math.max(days - 1, 1))); });
  }

  // Revenus (50% des achats de ses titres)
  const revMap = zeroMap();
  (data.purchases || [])
    .filter((p) => myIds.has(p.contentId) && new Date(p.createdAt) >= cutoff)
    .forEach((p) => { const k = p.createdAt.slice(0, 10); if (revMap[k] !== undefined) revMap[k] += Math.round(p.price * 0.5); });

  const prevCutoff = new Date(cutoff); prevCutoff.setDate(prevCutoff.getDate() - days);
  const periodPlays = Object.values(playsMap).reduce((a, b) => a + b, 0);
  const prevPlays = pe.length
    ? pe.filter((e) => myIds.has(e.trackId) && new Date(e.createdAt) >= prevCutoff && new Date(e.createdAt) < cutoff).length
    : periodPlays * 0.85;
  const playsTrend = prevPlays > 0 ? Math.round((periodPlays - prevPlays) / prevPlays * 100) : null;

  const totalPlays = myTracks.reduce((s, t) => s + (t.plays || 0), 0);
  const totalRevenue = (data.purchases || [])
    .filter((p) => myIds.has(p.contentId))
    .reduce((s, p) => s + Math.round(p.price * 0.5), 0);
  const fans = new Set((data.likes || []).filter((l) => myIds.has(l.contentId)).map((l) => l.userId)).size;

  const topTracks = [...myTracks]
    .sort((a, b) => (b.plays || 0) - (a.plays || 0))
    .slice(0, 5)
    .map((t) => ({ title: t.title, plays: t.plays || 0 }));

  res.json({
    labels, days,
    plays: labels.map((l) => playsMap[l]),
    revenue: labels.map((l) => revMap[l]),
    periodPlays,
    playsTrend,
    totalPlays,
    totalRevenue,
    fans,
    topTracks,
  });
});

// Top Guinée — artistes ayant remporté des battles, triés par victoires
app.get('/api/top-guinee', (req, res) => {
  const data = db.read();
  const champions = data.users
    .filter((u) => (u.battleWins || 0) > 0 && u.role === 'artist')
    .sort((a, b) => (b.battleWins || 0) - (a.battleWins || 0))
    .slice(0, 10)
    .map((u) => {
      const myTracks = data.tracks.filter((t) => t.ownerId === u.id && isReleased(t));
      const top = myTracks.sort((a, b) => (b.plays || 0) - (a.plays || 0))[0] || null;
      const allWins = (data.battles || []).filter((b) => b.status === 'ended' && b.winnerId === u.id);
      const lastWin = allWins.sort((a, b) => new Date(b.updatedAt || b.endsAt) - new Date(a.updatedAt || a.endsAt))[0];
      return {
        id: u.id,
        artistName: u.artistName || u.name,
        verified: u.verified || false,
        battleWins: u.battleWins || 0,
        lastBattleTheme: lastWin?.theme || null,
        topTrack: top ? { id: top.id, title: top.title, coverUrl: top.coverUrl || null, plays: top.plays || 0, audioUrl: top.audioUrl || null, price: top.price || 0 } : null,
      };
    });
  res.json({ champions });
});

// ===========================================================================
// NOTIFICATIONS PUSH (Web Push API)
// ===========================================================================

app.get('/api/push/vapid-key', (req, res) => {
  const data = db.read();
  res.json({ publicKey: data.vapid.publicKey });
});

app.post('/api/push/subscribe', auth(), (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Abonnement invalide' });
  const data = db.read();
  if (!data.pushSubscriptions) data.pushSubscriptions = [];
  // Remplacer si même endpoint existe déjà
  const idx = data.pushSubscriptions.findIndex((s) => s.subscription.endpoint === subscription.endpoint);
  const entry = { userId: req.user.id, subscription, updatedAt: new Date().toISOString() };
  if (idx !== -1) data.pushSubscriptions[idx] = entry;
  else data.pushSubscriptions.push(entry);
  db.write(data);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', auth(), (req, res) => {
  const data = db.read();
  data.pushSubscriptions = (data.pushSubscriptions || []).filter((s) => s.userId !== req.user.id);
  db.write(data);
  res.json({ ok: true });
});

// Test push pour l'utilisateur connecté
app.post('/api/push/test', auth(), (req, res) => {
  const data = db.read();
  const subs = (data.pushSubscriptions || []).filter((s) => s.userId === req.user.id);
  if (!subs.length) return res.status(404).json({ error: 'Pas d\'abonnement actif' });
  subs.forEach((s) => sendPush(s.subscription, { title: 'KORAWAVE', body: '🎵 Les notifications sont activées !', url: '/' }));
  res.json({ ok: true, sent: subs.length });
});

// ===========================================================================
// EXPORT CSV ADMIN
// ===========================================================================

function csvEsc(v) {
  const s = String(v == null ? '' : v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(...vals) { return vals.map(csvEsc).join(','); }
function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + rows.join('\r\n')); // BOM UTF-8 pour Excel
}

// Export transactions financières
app.get('/api/admin/export/finance.csv', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const period = parseInt(req.query.period, 10) || 30;
  const since = new Date(Date.now() - period * 86400000);
  const txs = (data.koinTransactions || [])
    .filter((t) => new Date(t.createdAt) >= since)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const rows = [csvRow('Date', 'Type', 'Montant (KOINS)', 'Utilisateur', 'Artiste', 'Titre', 'Référence')];
  txs.forEach((t) => {
    const user = data.users.find((u) => u.id === t.userId);
    const track = t.trackId ? data.tracks.find((x) => x.id === t.trackId) || data.videos.find((x) => x.id === t.trackId) : null;
    const artist = track?.ownerId ? data.users.find((u) => u.id === track.ownerId) : null;
    rows.push(csvRow(
      t.createdAt, t.type, t.amount,
      user?.name || user?.artistName || t.userId,
      artist?.artistName || artist?.name || '',
      track?.title || '',
      t.paymentRef || t.id,
    ));
  });
  sendCsv(res, `korawave-finance-${period}j.csv`, rows);
});

// Export liste des utilisateurs
app.get('/api/admin/export/users.csv', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const rows = [csvRow('ID', 'Nom', 'Artiste', 'Téléphone', 'Email', 'Rôle', 'KOINS', 'Vérifié', 'Banni', 'Inscrit le', 'Titres', 'Achats', 'Dépenses (KOINS)')];
  data.users.forEach((u) => {
    const tracks = (data.tracks || []).filter((t) => t.ownerId === u.id).length;
    const purchases = (data.purchases || []).filter((p) => p.userId === u.id);
    const spent = purchases.reduce((s, p) => s + (p.price || 0), 0);
    rows.push(csvRow(
      u.id, u.name || '', u.artistName || '', u.phone || '', u.email || '',
      u.role, u.koins || 0, u.verified ? 'Oui' : 'Non', u.banned ? 'Oui' : 'Non',
      u.createdAt, tracks, purchases.length, spent,
    ));
  });
  sendCsv(res, 'korawave-utilisateurs.csv', rows);
});

// Export catalogue (titres + clips)
app.get('/api/admin/export/catalogue.csv', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const rows = [csvRow('ID', 'Type', 'Titre', 'Artiste', 'Genre', 'Prix (GNF)', 'Écoutes', 'Commentaires', 'Likes', 'Statut', 'Créé le')];
  [...(data.tracks || []), ...(data.videos || [])].forEach((item) => {
    const isVideo = !!item.videoUrl;
    const comments = (data.comments || []).filter((c) => c.contentId === item.id && !c.deleted).length;
    const likes = (data.likes || []).filter((l) => l.contentId === item.id).length;
    const status = item.releaseAt && new Date(item.releaseAt) > new Date() ? 'Programmé' : 'Publié';
    rows.push(csvRow(
      item.id, isVideo ? 'Clip' : 'Audio', item.title, item.artist || '',
      item.genre || '', item.price || 0, item.plays || 0, comments, likes, status, item.createdAt,
    ));
  });
  sendCsv(res, 'korawave-catalogue.csv', rows);
});

// ===========================================================================
// MESSAGERIE DM
// ===========================================================================

// Liste des conversations (dernier message + nb non-lus par thread)
app.get('/api/messages', auth(), (req, res) => {
  const data = db.read();
  const msgs = (data.messages || []).filter((m) => m.fromId === req.user.id || m.toId === req.user.id);
  const threadMap = {};
  msgs.forEach((m) => {
    const partnerId = m.fromId === req.user.id ? m.toId : m.fromId;
    if (!threadMap[partnerId]) threadMap[partnerId] = { messages: [], unread: 0 };
    threadMap[partnerId].messages.push(m);
    if (m.toId === req.user.id && !m.read) threadMap[partnerId].unread++;
  });
  const threads = Object.entries(threadMap).map(([partnerId, t]) => {
    const partner = data.users.find((u) => u.id === partnerId);
    const last = t.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    return {
      partnerId, unread: t.unread,
      partnerName: partner?.artistName || partner?.name || 'Inconnu',
      partnerRole: partner?.role || 'user',
      lastMessage: last?.body?.slice(0, 80) || '',
      lastAt: last?.createdAt || '',
    };
  }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  const totalUnread = threads.reduce((s, t) => s + t.unread, 0);
  res.json({ threads, totalUnread });
});

// Thread complet avec un partenaire
app.get('/api/messages/:partnerId', auth(), (req, res) => {
  const data = db.read();
  const partner = data.users.find((u) => u.id === req.params.partnerId);
  if (!partner) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const msgs = (data.messages || [])
    .filter((m) => (m.fromId === req.user.id && m.toId === partner.id) || (m.fromId === partner.id && m.toId === req.user.id))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  // Marquer comme lus
  let changed = false;
  msgs.forEach((m) => { if (m.toId === req.user.id && !m.read) { m.read = true; changed = true; } });
  if (changed) db.write(data);
  res.json({
    partner: { id: partner.id, name: partner.artistName || partner.name, role: partner.role, verified: !!partner.verified },
    messages: msgs,
  });
});

// Envoyer un message
app.post('/api/messages/:partnerId', auth(), (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message vide' });
  if (body.trim().length > 500) return res.status(400).json({ error: 'Message trop long (500 car. max)' });
  const data = db.read();
  const partner = data.users.find((u) => u.id === req.params.partnerId);
  if (!partner) return res.status(404).json({ error: 'Destinataire introuvable' });
  if (partner.id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas t\'écrire à toi-même' });
  if (!data.messages) data.messages = [];
  const msg = { id: crypto.randomUUID(), fromId: req.user.id, toId: partner.id, body: body.trim(), read: false, createdAt: new Date().toISOString() };
  data.messages.push(msg);
  // Notif bell pour le destinataire
  if (!data.notifications) data.notifications = [];
  const sender = data.users.find((u) => u.id === req.user.id);
  data.notifications.push({ id: crypto.randomUUID(), userId: partner.id, type: 'message', icon: '💬', text: (sender?.artistName || sender?.name || 'Quelqu\'un') + ' t\'a envoyé un message', link: req.user.id, read: false, createdAt: new Date().toISOString() });
  db.write(data);
  res.json({ message: msg });
});

// Nb de messages non lus (pour le badge nav)
app.get('/api/messages/unread-count', auth(), (req, res) => {
  const data = db.read();
  const count = (data.messages || []).filter((m) => m.toId === req.user.id && !m.read).length;
  res.json({ count });
});

// ===========================================================================
// PLAYLISTS
// ===========================================================================

app.get('/api/playlists', auth(), (req, res) => {
  const data = db.read();
  const pls = (data.playlists || []).filter((p) => p.userId === req.user.id);
  res.json({ playlists: pls.map((p) => ({ ...p, trackCount: (p.trackIds || []).length })) });
});

app.post('/api/playlists', auth(), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const data = db.read();
  if (!data.playlists) data.playlists = [];
  const pl = { id: crypto.randomUUID(), userId: req.user.id, name: name.trim(), trackIds: [], createdAt: new Date().toISOString() };
  data.playlists.push(pl);
  db.write(data);
  res.json({ playlist: pl });
});

app.get('/api/playlists/:id', auth(), (req, res) => {
  const data = db.read();
  const pl = (data.playlists || []).find((p) => p.id === req.params.id && p.userId === req.user.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  const tracks = (pl.trackIds || []).map((tid) => {
    const t = (data.tracks || []).find((x) => x.id === tid);
    return t ? publicTrack(t, data, req.user.id) : null;
  }).filter(Boolean);
  res.json({ playlist: { ...pl, tracks } });
});

app.delete('/api/playlists/:id', auth(), (req, res) => {
  const data = db.read();
  const idx = (data.playlists || []).findIndex((p) => p.id === req.params.id && p.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist introuvable' });
  data.playlists.splice(idx, 1);
  db.write(data);
  res.json({ ok: true });
});

app.patch('/api/playlists/:id', auth(), (req, res) => {
  const data = db.read();
  const pl = (data.playlists || []).find((p) => p.id === req.params.id && p.userId === req.user.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  if (req.body.name) pl.name = req.body.name.trim();
  db.write(data);
  res.json({ playlist: pl });
});

app.post('/api/playlists/:id/tracks', auth(), (req, res) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId requis' });
  const data = db.read();
  const pl = (data.playlists || []).find((p) => p.id === req.params.id && p.userId === req.user.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  if (!data.tracks.find((t) => t.id === trackId)) return res.status(404).json({ error: 'Titre introuvable' });
  if (!pl.trackIds) pl.trackIds = [];
  if (pl.trackIds.includes(trackId)) return res.status(409).json({ error: 'Déjà dans la playlist' });
  pl.trackIds.push(trackId);
  db.write(data);
  res.json({ ok: true, trackCount: pl.trackIds.length });
});

app.delete('/api/playlists/:id/tracks/:trackId', auth(), (req, res) => {
  const data = db.read();
  const pl = (data.playlists || []).find((p) => p.id === req.params.id && p.userId === req.user.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  pl.trackIds = (pl.trackIds || []).filter((tid) => tid !== req.params.trackId);
  db.write(data);
  res.json({ ok: true, trackCount: pl.trackIds.length });
});

// ===========================================================================
// PAGE PUBLIQUE ARTISTE
// ===========================================================================

app.get('/api/artists/:id/profile', auth(false), (req, res) => {
  const data = db.read();
  const u = data.users.find((x) => x.id === req.params.id && x.role === 'artist');
  if (!u) return res.status(404).json({ error: 'Artiste introuvable' });
  const uid = req.user?.id || null;

  const tracks = (data.tracks || [])
    .filter((t) => t.ownerId === u.id && isReleased(t))
    .map((t) => publicTrack(t, data, uid))
    .sort((a, b) => (b.plays || 0) - (a.plays || 0));
  const videos = (data.videos || [])
    .filter((v) => v.ownerId === u.id && isReleased(v))
    .map((v) => publicVideo(v, data, uid))
    .sort((a, b) => (b.plays || 0) - (a.plays || 0));

  const follows = data.follows || [];
  const followersCount = follows.filter((f) => f.artistId === u.id).length;
  const isFollowing = uid ? follows.some((f) => f.userId === uid && f.artistId === u.id) : false;
  const totalPlays = [...tracks, ...videos].reduce((s, t) => s + (t.plays || 0), 0);

  res.json({
    id: u.id, name: u.artistName || u.name, bio: u.bio || null,
    verified: !!u.verified, battleWins: u.battleWins || 0,
    followers: followersCount, isFollowing, totalPlays,
    tracks, videos,
  });
});

app.post('/api/artists/:id/follow', auth(), (req, res) => {
  const data = db.read();
  const artist = data.users.find((u) => u.id === req.params.id && u.role === 'artist');
  if (!artist) return res.status(404).json({ error: 'Artiste introuvable' });
  if (artist.id === req.user.id) return res.status(400).json({ error: 'Impossible de te suivre toi-même' });

  if (!data.follows) data.follows = [];
  const idx = data.follows.findIndex((f) => f.userId === req.user.id && f.artistId === artist.id);
  let following;
  if (idx !== -1) {
    data.follows.splice(idx, 1);
    following = false;
  } else {
    data.follows.push({ id: crypto.randomUUID(), userId: req.user.id, artistId: artist.id, createdAt: new Date().toISOString() });
    following = true;
  }
  db.write(data);
  const followers = data.follows.filter((f) => f.artistId === artist.id).length;
  res.json({ following, followers });
});

// ===========================================================================
// RECHERCHE GLOBALE
// ===========================================================================

app.get('/api/search', auth(false), (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) return res.json({ q, artists: [], tracks: [], videos: [] });

  const data = db.read();
  const uid = req.user?.id || null;

  const score = (text) => {
    if (!text) return 0;
    const t = String(text).toLowerCase();
    if (t === q) return 3;
    if (t.startsWith(q)) return 2;
    if (t.includes(q)) return 1;
    return 0;
  };

  // Artistes
  const artists = data.users
    .filter((u) => u.role === 'artist' && !u.banned)
    .map((u) => {
      const s = Math.max(score(u.artistName), score(u.name), score(u.bio));
      if (!s) return null;
      return {
        id: u.id, name: u.artistName || u.name, bio: u.bio || null,
        verified: !!u.verified, battleWins: u.battleWins || 0,
        tracks: data.tracks.filter((t) => t.ownerId === u.id).length,
        videos: data.videos.filter((v) => v.ownerId === u.id).length,
        score: s,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.tracks - a.tracks)
    .slice(0, 6);

  // Titres audio
  const tracks = data.tracks
    .filter((t) => isReleased(t))
    .map((t) => {
      const s = Math.max(score(t.title), score(t.artist), score(t.genre));
      if (!s) return null;
      return { ...publicTrack(t, data, uid), score: s };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || (b.plays || 0) - (a.plays || 0))
    .slice(0, 12);

  // Clips vidéo
  const videos = data.videos
    .filter((v) => isReleased(v))
    .map((v) => {
      const s = Math.max(score(v.title), score(v.artist), score(v.genre));
      if (!s) return null;
      return { ...publicVideo(v, data, uid), score: s };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || (b.plays || 0) - (a.plays || 0))
    .slice(0, 8);

  res.json({ q, artists, tracks, videos });
});

// ===========================================================================
// GESTION DES UTILISATEURS (admin)
// ===========================================================================

app.get('/api/admin/users', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const users = data.users.map((u) => {
    const tracks = (data.tracks || []).filter((t) => t.ownerId === u.id).length;
    const purchases = (data.purchases || []).filter((p) => p.userId === u.id).length;
    const spent = (data.purchases || []).filter((p) => p.userId === u.id)
      .reduce((s, p) => s + (p.price || 0), 0);
    return {
      id: u.id, name: u.name, artistName: u.artistName || null,
      phone: u.phone || null, email: u.email || null,
      role: u.role, koins: u.koins || 0,
      verified: !!u.verified, banned: !!u.banned,
      createdAt: u.createdAt || null,
      tracks, purchases, spent,
      battleWins: u.battleWins || 0,
    };
  });
  res.json({ users });
});

app.patch('/api/admin/users/:id', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const u = data.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Impossible de modifier un admin' });
  const { role, banned } = req.body;
  if (role !== undefined) {
    if (!['user', 'artist'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
    u.role = role;
  }
  if (banned !== undefined) u.banned = !!banned;
  db.write(data);
  res.json({ ok: true });
});

// ===========================================================================
// STATISTIQUES FINANCIÈRES DÉTAILLÉES (admin)
// ===========================================================================

app.get('/api/admin/finance', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const days = Math.min(parseInt(req.query.period) || 30, 365);
  const cutoff = new Date(Date.now() - days * 86400000);

  const purchases = (data.purchases || []);
  const tips = (data.tips || []);
  const txns = (data.koinTransactions || []);

  const purchasesInPeriod = purchases.filter((p) => new Date(p.createdAt) >= cutoff);
  const tipsInPeriod = tips.filter((t) => new Date(t.createdAt) >= cutoff);

  const purchaseRevenue = purchasesInPeriod.reduce((s, p) => s + (p.price || 0), 0);
  const tipRevenue = tipsInPeriod.reduce((s, t) => s + (t.amount || 0), 0);
  const totalRevenue = purchaseRevenue + tipRevenue;
  const koinsRecharged = txns.filter((t) => t.type === 'credit' && new Date(t.createdAt) >= cutoff)
    .reduce((s, t) => s + (t.amount || 0), 0);

  // Revenus par artiste
  const artistMap = {};
  purchasesInPeriod.forEach((p) => {
    const cid = p.contentId || p.trackId;
    const item = [...(data.tracks || []), ...(data.videos || [])].find((x) => x.id === cid);
    if (item?.ownerId) {
      artistMap[item.ownerId] = (artistMap[item.ownerId] || 0) + Math.round((p.price || 0) * 0.5);
    }
  });
  tipsInPeriod.forEach((t) => {
    if (t.artistId) artistMap[t.artistId] = (artistMap[t.artistId] || 0) + Math.round((t.amount || 0) * 0.5);
  });
  const topArtists = Object.entries(artistMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([id, earned]) => {
      const u = data.users.find((x) => x.id === id);
      return { id, name: u?.artistName || u?.name || '?', earned };
    });

  // Revenus par genre
  const genreMap = {};
  purchasesInPeriod.forEach((p) => {
    const cid = p.contentId || p.trackId;
    const item = (data.tracks || []).find((x) => x.id === cid);
    if (item?.genre) genreMap[item.genre] = (genreMap[item.genre] || 0) + (p.price || 0);
  });
  const topGenres = Object.entries(genreMap).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([genre, revenue]) => ({ genre, revenue }));

  // Historique des 50 dernières transactions
  const allTxns = [
    ...purchasesInPeriod.map((p) => {
      const u = data.users.find((x) => x.id === p.userId);
      const cid = p.contentId || p.trackId;
      const item = [...(data.tracks || []), ...(data.videos || [])].find((x) => x.id === cid);
      return { id: p.id, type: 'achat', user: u?.name || '?', item: item?.title || '?', amount: p.price || 0, createdAt: p.createdAt };
    }),
    ...tipsInPeriod.map((t) => {
      const u = data.users.find((x) => x.id === t.fromId || x.id === t.userId);
      const a = data.users.find((x) => x.id === t.artistId);
      return { id: t.id, type: 'pourboire', user: u?.name || '?', item: a?.artistName || a?.name || '?', amount: t.amount || 0, createdAt: t.createdAt };
    }),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);

  res.json({
    period: days, totalRevenue, purchaseRevenue, tipRevenue, koinsRecharged,
    artistShare: Math.round(totalRevenue * 0.5),
    korawaveShare: Math.round(totalRevenue * 0.4),
    ministryShare: Math.round(totalRevenue * 0.1),
    totalPurchases: purchasesInPeriod.length,
    topArtists, topGenres, transactions: allTxns,
  });
});

// Modifier métadonnées d'un titre (admin)
app.patch('/api/admin/tracks/:id', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const t = data.tracks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Titre introuvable' });
  const { title, genre, price, releaseAt } = req.body;
  if (title !== undefined) t.title = title.trim();
  if (genre !== undefined) t.genre = genre;
  if (price !== undefined) t.price = Math.max(0, parseInt(price) || 0);
  if (releaseAt !== undefined) t.releaseAt = releaseAt || null;
  db.write(data);
  res.json({ ok: true });
});

// Modifier métadonnées d'une vidéo (admin)
app.patch('/api/admin/videos/:id', auth(), adminOnly, (req, res) => {
  const data = db.read();
  const v = data.videos.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Vidéo introuvable' });
  const { title, genre, price, releaseAt } = req.body;
  if (title !== undefined) v.title = title.trim();
  if (genre !== undefined) v.genre = genre;
  if (price !== undefined) v.price = Math.max(0, parseInt(price) || 0);
  if (releaseAt !== undefined) v.releaseAt = releaseAt || null;
  db.write(data);
  res.json({ ok: true });
});

// SPA fallback (toute autre route -> index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
seedAdmin();
app.listen(PORT, () => {
  console.log(`\n  KORAWAVE en ligne  ->  http://localhost:${PORT}\n`);
});
