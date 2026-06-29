# KORAWAVE — Site web de streaming

Plateforme de streaming musical de Guinée. UX inspirée de Spotify, identité visuelle
KORAWAVE (or / noir, couleurs du drapeau guinéen). Par **SPIRALETECH**.

## Démarrer

```bash
cd C:\korawave\website
npm install      # une seule fois
npm start        # -> http://localhost:4000
```

Ouvre ensuite **http://localhost:4000** dans ton navigateur.

## Comptes de démo

| Rôle | Identifiant | Mot de passe |
|------|-------------|--------------|
| **Admin** | `admin@korawave.gn` (ou `+224600000000`) | `Korawave2025` |
| **Membre** (test streaming complet) | `+224699112233` | `test` |

> Change ces identifiants et la variable `JWT_SECRET` avant toute mise en production.

## Contenu de démo

Deux titres audio **réels et jouables** sont préchargés pour tester l'aperçu 10 s :
- **Conakry Sunrise** (~50 s) — l'aperçu démarre vers la 30ᵉ seconde (refrain)
- **Kora Interlude (court)** (~8 s) — l'aperçu démarre à 0

Pour régénérer/ajouter ce contenu de démo : `node seed-demo.js` (le serveur doit tourner).
Teste l'aperçu : clique « ◷ 10s » sur une carte (invité = aperçu ; connecte-toi en membre pour le streaming complet).

## Fonctionnalités

**Public / utilisateurs**
- Inscription & connexion (téléphone ou email + mot de passe), 1 000 KOINS offerts
- Accueil façon Spotify : à la une, tendances, genres, clips
- Lecteur audio en bas de page (lecture, pause, suivant/précédent, barre de progression, volume)
- Lecteur vidéo en modale
- **Preview 10 s** : bouton « ◷ 10s » sur chaque carte (audio + vidéo) → aperçu gratuit de 10 secondes exactes pour tout le monde, avec badge APERÇU + décompte. Les invités basculent automatiquement en aperçu et sont invités à se connecter ; les membres ont le streaming complet (gratuit, sans téléchargement)
- Likes (utilisateur connecté), recherche, filtres par genre, Mode Griot
- **Fonctions sociales** (CLAUDE.md v1.1) : fiche détaillée par titre/clip (bouton « 💬 N ») avec **commentaires** publics (max 500 car., anti-abus 10/h), like depuis la fiche, **signalement** d'un commentaire, **notifications** (cloche 🔔) pour l'artiste à chaque like/commentaire, et **modération** des commentaires signalés dans le dashboard admin

**Espace Artiste (rôle `artist`)**
- Inscription en tant qu'artiste (case « Je suis un artiste ») ou bouton « Devenir artiste » pour un compte existant
- Dashboard personnel : écoutes, fans, revenus (50%), top titres, partages
- Publication de ses **propres** audios (+ pochette) et vidéos (+ miniature), rattachés à son compte
- Gestion de son seul catalogue
- Badge « vérifié » ✔ accordé par l'admin
- **Release Scheduler** : programmer une date/heure de sortie → le titre apparaît en « Bientôt disponible » avec compte à rebours, média verrouillé (non lisible) jusqu'à la date
- **Partage d'extrait 30 s** (artistes vérifiés uniquement) : choix du passage, aperçu watermarqué KORAWAVE, génération d'un **lien universel** `…/titre/{id}` partageable (Facebook / WhatsApp / X), page publique d'écoute de l'extrait avec CTA vers KORAWAVE

**Portefeuille KOINS & paiement (INNOVATION_01 / 02)**
- **Portefeuille** : solde KOINS, historique des transactions, contenus achetés
- **Recharge Mobile Money simulée** : packs avec bonus fidélité (1 000 GNF = 1 000 K ; 2 000 → 2 100 ; 5 000 → 5 500 ; 10 000 → 11 500), choix Orange Money / MTN MoMo / Soutra Money, écran « paiement en cours » + référence
- **Achat permanent** de titres/vidéos en KOINS (anti-double-achat, badge « Acheté », répartition 50/40/10)
- **Tip Jar** : pourboire en KOINS à un artiste depuis le lecteur (montants 100/500/1000/5000 ou libre), 50 % reversés
- Stats artiste (ventes + pourboires réels) et admin (KOINS vendus, ventes, pourboires) alimentées

> ⚠️ Le paiement est **simulé** (sandbox). En production : Orange Money API v2, MTN MoMo API, Soutra API (webhooks HMAC + idempotence — SKILL_04). Les KOINS ne sont jamais convertis en GNF.

**Admin (Dashboard)**
- Statistiques : utilisateurs, titres, vidéos, écoutes, revenu estimé, répartition 50/40/10
- **Ajouter un audio** : fichier audio + image de couverture + titre / artiste / genre / prix
- **Ajouter une vidéo** : fichier vidéo + miniature optionnelle + métadonnées
- Gestion du catalogue (suppression)
- **Vérification des artistes** : accorder/retirer le badge ✔ (propagé sur leurs contenus)

## Technique

- **Backend** : Node.js + Express, JWT (jsonwebtoken), bcryptjs, uploads via multer
- **Stockage** : `data/db.json` (mini base JSON) + fichiers dans `uploads/`
- **Frontend** : HTML/CSS/JS vanilla (`public/`)

Pour la production, migrer le stockage vers PostgreSQL et les médias vers un CDN
(Cloudflare R2), comme décrit dans le `CLAUDE.md` du projet (SKILL_01, SKILL_06).

## Modèle économique (rappel CLAUDE.md)
- Audio : 500 GNF · Vidéo : 1 000 GNF · Preview gratuite 10 s
- Répartition : 50% artiste / 40% KORAWAVE / 10% Ministère de la Culture
