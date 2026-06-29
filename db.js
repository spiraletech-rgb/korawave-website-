/**
 * KORAWAVE — Mini base de données JSON (zéro dépendance native).
 * Stocke utilisateurs, titres audio, vidéos, likes, commentaires, transactions.
 * Pour un vrai déploiement, migrer vers PostgreSQL (voir CLAUDE.md / SKILL_01).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  users: [],
  tracks: [],
  videos: [],
  likes: [],
  comments: [],
  transactions: [],
  koinTransactions: [], // crédits (recharge) / débits (achat, pourboire)
  purchases: [],        // achats permanents liés au compte
  tips: [],             // pourboires aux artistes (Tip Jar)
  notifications: [],    // notifications (like, commentaire) — destinataire = artiste
  battles: [],          // KORAWAVE Battle : duels d'artistes (INNOVATION_06)
  battleVotes: [],      // votes (1 par compte par battle)
  fanPacks: [],         // Fan Pack (INNOVATION_03) : bundles artiste avec réduction
  fanPackPurchases: [], // achats de fan packs (badge "Fan Officiel")
  events: [],           // KORAWAVE Events (INNOVATION_09) : billetterie concerts
  tickets: [],          // billets achetés (QR code unique par billet)
  playEvents: [],       // log d'écoutes horodatées (analytics)
  otpCodes: [],         // codes OTP temporaires (auth sans mot de passe)
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

let cache = null;

function read() {
  ensure();
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    cache = JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  // garantit la présence de toutes les collections
  for (const k of Object.keys(DEFAULT_DB)) {
    if (!cache[k]) cache[k] = [];
  }
  return cache;
}

function write() {
  ensure();
  fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2));
}

module.exports = { read, write, DB_FILE, DATA_DIR };
