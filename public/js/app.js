/* ============================================================
   KORAWAVE — Logique front (vanilla JS)
   Streaming audio/vidéo, auth, likes, dashboard admin.
   ============================================================ */
(() => {
  'use strict';

  // ---------- État global ----------
  const State = {
    token: localStorage.getItem('kw_token') || null,
    user: null,
    tracks: [],
    videos: [],
    battles: [],
    fanPacks: [],
    topGuinee: [],          // champions battle — Hall of Fame
    radioMood: null,        // humeur radio active (null = pas de radio)
    likedIds: new Set(),
    view: 'home',
    genreFilter: null,
    _artistFilter: null,
    _artistPageId: null,
    _playlistId: null,
    _threadPartnerId: null,
    search: '',
    queue: [],
    queueIndex: -1,
    current: null,
    previewMode: false,   // true = lecture limitée à 10s
    previewStart: 0,      // seconde de départ de l'aperçu
    previewItem: null,    // {type:'audio'|'video', id}
    walletData: null,     // { balance, transactions, owned }
    notif: { notifications: [], unread: 0 },
  };

  const PREVIEW_SECS = 10; // 10 secondes EXACTES (CLAUDE.md — non modifiable)
  const GENRES = ['Mandingue', 'Afrobeats', 'Hip-hop', 'Reggae', 'Jazz', 'Mode Griot', 'Coupé-décalé', 'Gospel'];

  // ---------- Helpers DOM ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMoney = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)) + ' GNF';
  const fmtNum = (n) => new Intl.NumberFormat('fr-FR').format(n || 0);
  const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();
  const fmtDateTime = (iso) => {
    try { return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  };
  function countdownText(iso) {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'Disponible';
    const d = Math.floor(diff / 86400000), h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
    if (d > 0) return `${d}j ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  }
  // Met à jour tous les comptes à rebours chaque seconde
  setInterval(() => {
    $$('[data-countdown]').forEach((elt) => {
      const txt = countdownText(elt.dataset.countdown);
      elt.textContent = txt;
      if (txt === 'Disponible' && !elt.dataset.done) { elt.dataset.done = '1'; loadData().then(render); }
    });
  }, 1000);
  const fmtSec = (s) => { const m = Math.floor(s / 60), x = Math.floor(s % 60); return m + ':' + String(x).padStart(2, '0'); };

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- API NestJS ----------
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : (window.KW_API_URL || 'https://korawave-api.railway.app');

  const KW_KOIN_PACKS = [
    { id: 'p1', koins: 100, price: 10000, label: '100 KOINS' },
    { id: 'p2', koins: 500, price: 45000, label: '500 KOINS' },
    { id: 'p3', koins: 1000, price: 80000, label: '1000 KOINS' },
  ];

  function adaptTrack(t) {
    if (!t) return null;
    return {
      id: t.id, title: t.title || '',
      artist: t.artist_name || t.artist || '—',
      ownerId: t.artist_id || t.ownerId || '',
      artistId: t.artist_id || t.artistId || '',
      audioUrl: t.audio_url || t.audioUrl || '',
      videoUrl: t.video_url || t.videoUrl || '',
      coverUrl: t.cover_url || t.coverUrl || '',
      thumbUrl: t.thumbnail_url || t.thumbUrl || '',
      genre: t.genre || '',
      price: Number(t.price_gnf != null ? t.price_gnf : (t.price || 0)),
      plays: Number(t.plays_count != null ? t.plays_count : (t.plays || 0)),
      type: t.content_type || t.type || 'audio',
      verified: !!(t.artist_verified || t.verified),
      duration: t.duration_sec || t.duration || 0,
      releaseAt: t.release_date || t.releaseAt || null,
      likes: Number(t.likes_count != null ? t.likes_count : (t.likes || 0)),
      shareEnabled: !!(t.shareEnabled),
      fingerprint: t.fingerprint ? (typeof t.fingerprint === 'string' ? JSON.parse(t.fingerprint) : t.fingerprint) : null,
    };
  }

  function adaptArtist(a) {
    if (!a) return null;
    return {
      id: a.id,
      name: a.name || a.display_name || '—',
      bio: a.bio || '',
      avatarUrl: a.avatar_url || a.avatarUrl || '',
      country: a.country || 'GN',
      verified: !!(a.verified),
      userId: a.user_id || a.userId || '',
      plays: Number(a.total_plays || a.plays || 0),
      followers: Number(a.followers_count || a.followers || 0),
      tracks: (a.tracks || []).map(adaptTrack),
      videos: (a.videos || []).map(adaptTrack),
    };
  }

  function adaptPlaylist(p) {
    if (!p) return null;
    return {
      id: p.id, name: p.name,
      userId: p.user_id || p.userId,
      tracks: (p.tracks || []).map((pt) => ({ trackId: pt.track_id || pt.trackId, position: pt.position || 0 })),
      createdAt: p.created_at || p.createdAt,
    };
  }

  function adaptThread(t) {
    if (!t) return null;
    const partnerId = t.partner_id || t.partnerId;
    const artistEntry = (State.tracks || []).find((tr) => tr.artistId === partnerId);
    return {
      partnerId,
      partnerName: t.partner_name || (artistEntry && artistEntry.artist) || ('Utilisateur ' + (partnerId || '').slice(0, 6)),
      lastMsg: t.last_message || t.lastMsg || '',
      lastAt: t.last_at || t.lastAt || '',
      unread: Number(t.unread || 0),
    };
  }

  function adaptMessage(m) {
    if (!m) return null;
    return {
      id: m.id,
      from: m.sender_id || m.from,
      fromId: m.sender_id || m.from,
      to: m.receiver_id || m.to,
      body: m.content || m.body || '',
      read: !!(m.read),
      at: m.created_at || m.at,
      createdAt: m.created_at || m.at,
    };
  }

  function adaptUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      name: u.display_name || u.name || u.phone_number || u.email || 'Utilisateur',
      artistName: u.display_name || u.name || '',
      phone: u.phone_number || u.phone || '',
      email: u.email || '',
      role: u.role || 'user',
      verified: !!(u.is_verified || u.verified),
      koins: Number(u.koins || 0),
      artistId: u.artistId || null,
    };
  }

  function decodeToken(token) {
    if (!token) return null;
    try {
      const raw = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = raw + '=='.slice((raw.length % 4) || 4);
      const p = JSON.parse(atob(pad));
      if (p.exp && p.exp * 1000 < Date.now()) return null;
      return adaptUser({ id: p.sub, display_name: p.name || p.display_name, phone_number: p.phone, email: p.email, role: p.role || 'user' });
    } catch { return null; }
  }

  // Traduit les anciens chemins Express vers les routes NestJS /api/v1
  function kwRoute(rawPath, method, reqBody) {
    const qi = rawPath.indexOf('?');
    const path = qi >= 0 ? rawPath.slice(0, qi) : rawPath;
    const qs = qi >= 0 ? rawPath.slice(qi) : '';
    const v1 = (p, q) => API_BASE + '/api/v1' + p + (q !== undefined ? q : qs);
    const local = (val) => ({ local: val });

    // ── AUTH ──────────────────────────────────────────────────────────────────
    if (path === '/auth/request-otp' || path === '/auth/send-otp') {
      return { url: v1('/auth/send-otp', ''), body: { phone_number: reqBody && (reqBody.phone || reqBody.phone_number) },
        adapt: (d) => ({ ...d, _demo_code: d._demo_code || null }) };
    }
    if (path === '/auth/verify-otp') {
      const fp = 'web-' + (navigator.userAgent || '').slice(0, 20).replace(/\s/g, '_');
      return {
        url: v1('/auth/verify-otp', ''),
        body: { phone_number: reqBody && (reqBody.phone || reqBody.phone_number), otp_code: reqBody && (reqBody.code || reqBody.otp_code), device_fingerprint: (reqBody && reqBody.device_fingerprint) || fp },
        adapt: (d) => ({ token: d.access_token || d.token, user: adaptUser(d.user) }),
      };
    }
    if (path === '/auth/admin/login') {
      return { url: v1('/auth/admin/login', ''), body: reqBody, adapt: (d) => ({ token: d.access_token || d.token, user: adaptUser(d.user) }) };
    }
    if (path === '/auth/me') {
      const user = decodeToken(State.token);
      if (!user) throw new Error('Session expirée');
      return local({ user });
    }

    // ── ARTISTE INSCRIPTION ────────────────────────────────────────────────────
    if (path === '/artist/apply') {
      return {
        url: v1('/artists', ''),
        body: { name: reqBody && (reqBody.artistName || reqBody.name), bio: reqBody && reqBody.bio, user_id: State.user && State.user.id },
        adapt: (d) => ({ token: State.token, user: Object.assign({}, State.user, { role: 'artist', artistName: d.name, artistId: d.id }) }),
      };
    }

    // ── CATALOGUE ─────────────────────────────────────────────────────────────
    if (path === '/tracks') return { url: v1('/tracks?limit=100', ''), adapt: (d) => ({ tracks: (d.data || d.tracks || []).map(adaptTrack) }) };
    if (path === '/videos') return { url: v1('/tracks?content_type=video&limit=50', ''), adapt: (d) => ({ videos: (d.data || []).map(adaptTrack) }) };
    if (path === '/top-guinee') return local({ champions: [] });
    if (path === '/search') return { url: v1('/tracks/search', qs), adapt: (d) => ({ tracks: (Array.isArray(d) ? d : (d.data || [])).map(adaptTrack), artists: [] }) };

    // ── PLAYLISTS ─────────────────────────────────────────────────────────────
    if (path === '/playlists') {
      if (method === 'GET') return { url: v1('/playlists', ''), adapt: (d) => ({ playlists: (Array.isArray(d) ? d : []).map(adaptPlaylist) }) };
      if (method === 'POST') return { url: v1('/playlists', ''), body: { name: reqBody && reqBody.name }, adapt: (d) => ({ ok: true, playlist: adaptPlaylist(d) }) };
    }
    const plM = path.match(/^\/playlists\/([^/]+)(\/tracks)?(\/([^/]+))?$/);
    if (plM) {
      const plId = plM[1], hasTracks = plM[2], trackId = plM[4];
      if (hasTracks && trackId && method === 'DELETE') return { url: v1('/playlists/' + plId + '/tracks/' + trackId, '') };
      if (hasTracks && method === 'POST') return { url: v1('/playlists/' + plId + '/tracks', ''), body: { track_id: reqBody && (reqBody.trackId || reqBody.track_id) } };
      if (!hasTracks && method === 'GET') return { url: v1('/playlists/' + plId, ''), adapt: (d) => ({ playlist: adaptPlaylist(d) }) };
      if (!hasTracks && method === 'PATCH') return { url: v1('/playlists/' + plId, ''), body: { name: reqBody && reqBody.name } };
      if (!hasTracks && method === 'DELETE') return { url: v1('/playlists/' + plId, '') };
    }

    // ── MESSAGES ──────────────────────────────────────────────────────────────
    if (path === '/messages') {
      if (method === 'GET') return { url: v1('/messages/threads', ''), adapt: (d) => ({ threads: (Array.isArray(d) ? d : []).map(adaptThread) }) };
    }
    if (path === '/messages/unread-count') {
      return { url: v1('/messages/unread-count', ''), adapt: (d) => ({ count: typeof d === 'number' ? d : (d.count != null ? d.count : 0) }) };
    }
    const msgM = path.match(/^\/messages\/([^/]+)(\/read)?$/);
    if (msgM) {
      const pid = msgM[1];
      if (msgM[2] && method === 'POST') return { url: v1('/messages/thread/' + pid + '/read', ''), body: {} };
      if (method === 'GET') {
        return { url: v1('/messages/thread/' + pid, ''), adapt: (d) => {
          const msgs = Array.isArray(d) ? d : [];
          const artistEntry = (State.tracks || []).find((tr) => tr.artistId === pid);
          return { messages: msgs.map(adaptMessage), partner: { id: pid, name: (artistEntry && artistEntry.artist) || 'Artiste', verified: (artistEntry && artistEntry.verified) || false } };
        }};
      }
      if (method === 'POST') {
        return { url: v1('/messages', ''), body: { receiver_id: pid, content: reqBody && (reqBody.body || reqBody.content) },
          adapt: (d) => ({ message: adaptMessage(d), ok: true }) };
      }
    }

    // ── SOCIAL ────────────────────────────────────────────────────────────────
    if (path === '/like') return { url: v1('/social/like', '') };
    if (path === '/comments' && method === 'POST') return { url: v1('/social/comment', '') };
    if (path.startsWith('/comments')) return { url: v1('/social/comments', qs) };

    // ── BATTLES ───────────────────────────────────────────────────────────────
    if (path === '/battles' && method === 'GET') return { url: v1('/battle/active', ''), adapt: (d) => ({ battles: d.battles || d.data || [] }) };
    const btM = path.match(/^\/battles\/([^/]+)(\/vote)?$/);
    if (btM) {
      const bid = btM[1];
      if (btM[2] && method === 'POST') return { url: v1('/battle/vote', ''), body: { battleId: bid, trackId: reqBody && reqBody.trackId } };
      return { url: v1('/battle/' + bid, '') };
    }

    // ── EVENTS ────────────────────────────────────────────────────────────────
    if (path === '/events') return { url: v1('/events', qs), adapt: (d) => ({ events: d.events || d.data || [] }) };
    if (path === '/my-tickets') return { url: v1('/events/my-tickets', ''), adapt: (d) => ({ tickets: d.tickets || d.data || [] }) };
    if (path === '/purchase-ticket') return { url: v1('/events/purchase/' + (reqBody && reqBody.eventId || ''), ''), body: {} };

    // ── WALLET / KOINS ────────────────────────────────────────────────────────
    if (path === '/wallet') return { url: v1('/koins/balance', ''), adapt: (d) => ({ balance: d.balance || d.koins || 0, transactions: d.transactions || [], owned: d.owned || [] }) };
    if (path === '/koin-packs') return local({ packs: KW_KOIN_PACKS });
    if (path === '/wallet/recharge') return { url: v1('/koins/recharge', '') };
    if (path === '/purchase') return { url: v1('/purchases/initiate', ''), body: { content_type: reqBody && reqBody.contentType, content_id: reqBody && reqBody.contentId } };
    if (path === '/purchase-pack') return { url: v1('/fanpack/purchase/' + (reqBody && reqBody.packId || ''), ''), body: {} };
    if (path === '/tip') return { url: v1('/tipjar/send', '') };

    // ── FAN PACKS ─────────────────────────────────────────────────────────────
    if (path === '/fan-packs') return local({ packs: [] });
    if (path === '/artist/fan-packs' && method === 'POST') return { url: v1('/fanpack/create', '') };

    // ── ARTISTE (tableau de bord artiste) ─────────────────────────────────────
    if (path === '/artist/stats') return { url: v1('/artists/me/dashboard', ''), adapt: (d) => ({ stats: d.stats || d, tracks: [], videos: [] }) };
    if (path === '/artist/content') {
      return { url: v1('/artists/me/tracks', ''), adapt: (d) => {
        const all = (d.data || d.tracks || []).map(adaptTrack);
        return { tracks: all.filter((t) => t.type === 'audio'), videos: all.filter((t) => t.type === 'video') };
      }};
    }
    const apM = path.match(/^\/artists\/([^/]+)\/profile$/);
    if (apM) return { url: v1('/artists/' + apM[1], ''), adapt: (d) => ({ profile: adaptArtist(d) }) };
    const afM = path.match(/^\/artists\/([^/]+)\/follow$/);
    if (afM) return { url: v1('/artists/' + afM[1] + '/follow', '') };

    // ── FINGERPRINT ───────────────────────────────────────────────────────────
    if (path === '/identify') return { url: v1('/tracks/identify', '') };
    const fpM = path.match(/^\/tracks\/([^/]+)\/fingerprint$/);
    if (fpM) return { url: v1('/tracks/' + fpM[1] + '/fingerprint', '') };

    // ── NOTIFICATIONS (stub) ──────────────────────────────────────────────────
    if (path === '/notifications') return local({ notifications: [], unread: 0 });
    if (path === '/notifications/read') return local({ ok: true });

    // ── PUSH (stub) ───────────────────────────────────────────────────────────
    if (path === '/push/vapid-key') return local({ publicKey: null });
    if (path === '/push/subscribe') return local({ ok: true });
    if (path === '/push/test') return local({ ok: true });

    // ── ADMIN ─────────────────────────────────────────────────────────────────
    if (path === '/admin/stats') {
      return { url: v1('/admin/dashboard', ''), adapt: (d) => ({ users: d.totalUsers || d.users || 0, artists: d.totalArtists || d.artists || 0, tracks: d.totalTracks || d.tracks || 0, videos: d.totalVideos || d.videos || 0, revenue: d.totalRevenue || d.revenue || 0, plays: d.totalPlays || d.plays || 0 }) };
    }
    if (path === '/admin/artists') return { url: v1('/admin/artists', ''), adapt: (d) => ({ artists: d.artists || d.data || d || [] }) };
    if (path === '/admin/comments') return local({ comments: [] });
    if (path === '/admin/users') return local({ users: [] });
    if (path.match(/^\/admin\/users\/[^/]+$/)) return local({ ok: true });
    if (path === '/admin/finance' || path.startsWith('/admin/finance?')) {
      return { url: v1('/admin/revenue', qs || (reqBody && reqBody.period ? '?period=' + reqBody.period : '')) };
    }
    if (path === '/admin/battles' && method === 'POST') return { url: v1('/battle/create', '') };
    if (path.match(/^\/admin\/battles\/[^/]+\/close$/)) return local({ ok: true });
    if (path === '/admin/events' && method === 'POST') return { url: v1('/events/create', '') };

    // ── SHARE ─────────────────────────────────────────────────────────────────
    const shM = path.match(/^\/share\/([^/]+)$/);
    if (shM) return { url: v1('/tracks/' + shM[1] + '/share', '') };

    // Fallback : préfixe /api/v1 direct
    return { url: v1(path, qs) };
  }

  async function api(path, { method = 'GET', body, form } = {}) {
    const route = kwRoute(path, method, body);
    if ('local' in route) return route.local;

    const opts = { method, headers: {} };
    if (State.token) opts.headers.Authorization = 'Bearer ' + State.token;
    const reqBody = 'body' in route ? route.body : body;
    if (form) { opts.body = form; }
    else if (reqBody) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(reqBody); }

    const res = await fetch(route.url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = Array.isArray(data.message) ? data.message[0] : (data.message || data.error || 'Erreur ' + res.status);
      throw new Error(msg);
    }
    return route.adapt ? route.adapt(data) : data;
  }

  // ============================================================
  //  AUTH
  // ============================================================
  function setSession(token, user) {
    State.token = token; State.user = user;
    if (token) { localStorage.setItem('kw_token', token); startMsgBadge(); }
    renderAuthUI();
    loadNotifications();
  }
  function logout() {
    State.token = null; State.user = null;
    localStorage.removeItem('kw_token');
    State.view = 'home'; State.genreFilter = null;
    State.notif = { notifications: [], unread: 0 }; renderBell();
    renderAuthUI(); setActiveNav(); render();
    toast('Déconnecté');
  }

  function renderAuthUI() {
    const authButtons = $('#authButtons');
    const userZone = $('#userZone');
    const adminNav = $('#adminNav');
    const artistNav = $('#artistNav');
    const becomeArtistNav = $('#becomeArtistNav');
    const walletNav = $('#walletNav');
    if (State.user) {
      const u = State.user;
      authButtons.classList.add('hidden');
      userZone.classList.remove('hidden');
      const display = u.role === 'artist' ? (u.artistName || u.name) : u.name;
      $('#userName').innerHTML = esc(display) + (u.role === 'artist' && u.verified ? ' <span style="color:var(--gold)">✔</span>' : '');
      $('#userAvatar').textContent = initial(display);
      $('#userKoins').textContent =
        u.role === 'admin' ? 'ADMIN' : u.role === 'artist' ? '🎤 ARTISTE' : fmtNum(u.koins) + ' KOINS';
      adminNav.style.display = u.role === 'admin' ? 'block' : 'none';
      artistNav.style.display = u.role === 'artist' ? 'block' : 'none';
      becomeArtistNav.style.display = u.role === 'user' ? 'block' : 'none';
      walletNav.style.display = u.role === 'admin' ? 'none' : 'block';
    } else {
      authButtons.classList.remove('hidden');
      userZone.classList.add('hidden');
      adminNav.style.display = 'none';
      artistNav.style.display = 'none';
      becomeArtistNav.style.display = 'none';
      walletNav.style.display = 'none';
    }
  }

  function becomeArtistModal() {
    const m = el(`
      <div class="overlay">
        <div class="modal">
          <button class="modal-close" data-close>&times;</button>
          <div class="modal-logo">KORAWAVE</div>
          <div class="modal-tag" style="margin-top:8px">Espace Artiste</div>
          <h3>Devenir artiste 🎤</h3>
          <p class="sub">Publie ta musique, suis tes écoutes et tes revenus (50% reversés).</p>
          <form id="becomeForm">
            <div class="field">
              <label>Nom de scène</label>
              <input class="input" name="artistName" placeholder="Ton nom d'artiste" value="${esc(State.user?.name || '')}" />
            </div>
            <div class="field">
              <label>Bio <span style="color:var(--muted2)">(optionnel)</span></label>
              <input class="input" name="bio" placeholder="Quelques mots sur toi" />
            </div>
            <button class="btn btn-gold btn-block" type="submit">Activer mon espace artiste</button>
            <div class="form-error" id="becomeErr"></div>
          </form>
          <p class="sub" style="margin:16px 0 0;font-size:12px">La vérification (badge ✔) est validée par l'équipe KORAWAVE.</p>
        </div>
      </div>`);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) closeModal(); });
    m.querySelector('#becomeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const { token, user } = await api('/artist/apply', {
          method: 'POST', body: { artistName: f.artistName.value, bio: f.bio.value },
        });
        setSession(token, user);
        closeModal();
        toast('🎤 Espace artiste activé !');
        go('artist');
      } catch (err) { $('#becomeErr').textContent = err.message; }
    });
    $('#modalRoot').appendChild(m);
  }

  // ----- Modales auth -----
  let _sharePreview = null;
  function closeModal() {
    if (_sharePreview) { try { _sharePreview.pause(); } catch (e) {} _sharePreview = null; }
    $('#modalRoot').innerHTML = '';
  }

  // Helper : header commun des modales auth
  function authModalHeader(tag, title, sub) {
    return `
      <button class="modal-close" data-close>&times;</button>
      <div class="modal-logo">KORAWAVE</div>
      <div class="modal-dots">
        <span class="brand-dot" style="width:6px;height:6px;border-radius:50%;background:var(--red)"></span>
        <span class="brand-dot" style="width:6px;height:6px;border-radius:50%;background:var(--yellow)"></span>
        <span class="brand-dot" style="width:6px;height:6px;border-radius:50%;background:var(--green)"></span>
      </div>
      <div class="modal-tag">${tag}</div>
      <h3>${title}</h3>
      ${sub ? `<p class="sub">${sub}</p>` : ''}`;
  }

  // Helper : 6 cases OTP + logique auto-focus / paste
  function mountOtpInputs(container, onComplete) {
    const inputs = Array.from(container.querySelectorAll('.otp-digit'));
    inputs.forEach((inp, i) => {
      inp.addEventListener('input', (e) => {
        inp.value = inp.value.replace(/\D/g, '').slice(-1);
        if (inp.value && i < 5) inputs[i + 1].focus();
        const code = inputs.map((x) => x.value).join('');
        if (code.length === 6) onComplete(code);
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1].focus();
      });
      inp.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        if (text.length === 6) {
          text.split('').forEach((d, j) => { if (inputs[j]) inputs[j].value = d; });
          inputs[5].focus();
          onComplete(text);
        }
        e.preventDefault();
      });
    });
    return inputs;
  }

  const OTP_BOXES = '<div class="otp-row">' + Array(6).fill('<input class="otp-digit" type="tel" maxlength="1" inputmode="numeric" />').join('') + '</div>';

  // ─── SE CONNECTER (OTP) ──────────────────────────────────────
  function loginModal() {
    const m = el(`
      <div class="overlay">
        <div class="modal">
          ${authModalHeader('Ton son · Ton droit · Ta Guinée', 'Bon retour', '')}

          <div class="login-tabs" style="display:flex;gap:8px;margin-bottom:18px">
            <button class="btn btn-sm login-tab active" data-tab="otp" style="flex:1">Utilisateur</button>
            <button class="btn btn-sm login-tab" data-tab="admin" style="flex:1">Admin</button>
          </div>

          <!-- OTP tab -->
          <div id="loginOtpTab">
            <p style="color:var(--muted);font-size:.85rem;margin-bottom:14px">Entre ton numéro pour recevoir un code de connexion.</p>
            <div class="otp-steps"><div class="otp-step active" id="ls1"></div><div class="otp-step" id="ls2"></div></div>
            <div id="loginStep1">
              <div class="field">
                <label>Numéro de téléphone</label>
                <input class="input" id="loginPhone" type="tel" placeholder="+224 6XX XX XX XX" autocomplete="tel" inputmode="tel" />
              </div>
              <button class="btn btn-gold btn-block" id="loginSendBtn">Recevoir le code →</button>
              <div class="form-error" id="loginErr"></div>
            </div>
            <div id="loginStep2" class="hidden">
              <div class="otp-phone-display">Code envoyé au <strong id="loginPhoneDisplay"></strong></div>
              <div class="otp-demo-box" id="loginDemoBox">Code de démo :<strong id="loginDemoCode"></strong></div>
              ${OTP_BOXES}
              <div class="form-error" id="loginOtpErr"></div>
              <button class="otp-resend" id="loginResend">Renvoyer le code</button>
            </div>
          </div>

          <!-- Admin tab -->
          <div id="loginAdminTab" class="hidden">
            <p style="color:var(--muted);font-size:.85rem;margin-bottom:14px">Accès réservé aux administrateurs KORAWAVE.</p>
            <div class="field">
              <label>Email</label>
              <input class="input" id="adminEmail" type="email" placeholder="admin@korawave.gn" autocomplete="email" />
            </div>
            <div class="field">
              <label>Mot de passe</label>
              <input class="input" id="adminPassword" type="password" placeholder="••••••••" autocomplete="current-password" />
            </div>
            <button class="btn btn-gold btn-block" id="adminLoginBtn">Se connecter →</button>
            <div class="form-error" id="adminErr"></div>
          </div>

          <div class="modal-switch">Pas encore de compte ? <a data-switch="register">S'inscrire</a></div>
        </div>
      </div>`);

    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) closeModal(); });
    m.querySelector('[data-switch]').onclick = () => { closeModal(); registerModal(); };

    // Tab switching
    m.querySelectorAll('.login-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        m.querySelectorAll('.login-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const isAdmin = tab.dataset.tab === 'admin';
        m.querySelector('#loginOtpTab').classList.toggle('hidden', isAdmin);
        m.querySelector('#loginAdminTab').classList.toggle('hidden', !isAdmin);
        if (isAdmin) m.querySelector('#adminEmail').focus();
        else m.querySelector('#loginPhone').focus();
      });
    });

    // OTP flow
    let currentPhone = '';
    const step1 = m.querySelector('#loginStep1');
    const step2 = m.querySelector('#loginStep2');
    const errEl = m.querySelector('#loginErr');
    const otpErrEl = m.querySelector('#loginOtpErr');

    async function sendCode(phone) {
      errEl.textContent = '';
      const btn = m.querySelector('#loginSendBtn');
      btn.disabled = true; btn.textContent = 'Envoi…';
      try {
        const res = await api('/auth/request-otp', { method: 'POST', body: { phone } });
        currentPhone = phone;
        m.querySelector('#loginPhoneDisplay').textContent = phone;
        m.querySelector('#loginDemoCode').textContent = res._demo_code || '------';
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
        m.querySelector('#ls2').classList.add('active');
        m.querySelectorAll('.otp-digit')[0]?.focus();
      } catch (e) {
        errEl.textContent = e.message;
        btn.disabled = false; btn.textContent = 'Recevoir le code →';
      }
    }

    m.querySelector('#loginSendBtn').onclick = () => sendCode(m.querySelector('#loginPhone').value.trim());
    m.querySelector('#loginPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(m.querySelector('#loginPhone').value.trim()); });
    m.querySelector('#loginResend').onclick = () => sendCode(currentPhone);

    mountOtpInputs(m, async (code) => {
      otpErrEl.textContent = '';
      try {
        const { token, user } = await api('/auth/verify-otp', { method: 'POST', body: { phone: currentPhone, code } });
        setSession(token, user);
        closeModal();
        toast('Bienvenue, ' + (user.artistName || user.name) + ' !');
        if (user.role === 'admin') { State.view = 'dashboard'; setActiveNav(); }
        else if (user.role === 'artist') { State.view = 'artist'; setActiveNav(); }
        await loadData(); render();
      } catch (e) {
        otpErrEl.textContent = e.message;
        m.querySelectorAll('.otp-digit').forEach((x) => { x.value = ''; });
        m.querySelectorAll('.otp-digit')[0]?.focus();
      }
    });

    // Admin flow
    async function adminLogin() {
      const email = m.querySelector('#adminEmail').value.trim();
      const password = m.querySelector('#adminPassword').value;
      const errAdm = m.querySelector('#adminErr');
      errAdm.textContent = '';
      if (!email || !password) { errAdm.textContent = 'Email et mot de passe requis.'; return; }
      const btn = m.querySelector('#adminLoginBtn');
      btn.disabled = true; btn.textContent = 'Connexion…';
      try {
        const { token, user } = await api('/auth/admin/login', { method: 'POST', body: { email, password } });
        setSession(token, user);
        closeModal();
        toast('Bienvenue, ' + (user.name || 'Admin') + ' !');
        State.view = 'dashboard'; setActiveNav();
        await loadData(); render();
      } catch (e) {
        errAdm.textContent = e.message;
        btn.disabled = false; btn.textContent = 'Se connecter →';
      }
    }

    m.querySelector('#adminLoginBtn').onclick = adminLogin;
    m.querySelector('#adminPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(); });

    $('#modalRoot').appendChild(m);
    m.querySelector('#loginPhone').focus();
  }

  // ─── S'INSCRIRE (OTP) ────────────────────────────────────────
  function registerModal() {
    const m = el(`
      <div class="overlay">
        <div class="modal">
          ${authModalHeader('Rejoins la communauté', 'Créer un compte', 'Inscription en 2 étapes — aucun mot de passe requis.')}
          <div class="otp-steps"><div class="otp-step active" id="rs1"></div><div class="otp-step" id="rs2"></div></div>

          <div id="regStep1">
            <div class="field">
              <label>Prénom / Pseudo</label>
              <input class="input" id="regName" placeholder="Ton prénom" autocomplete="given-name" />
            </div>
            <div class="field">
              <label>Numéro de téléphone</label>
              <input class="input" id="regPhone" type="tel" placeholder="+224 6XX XX XX XX" autocomplete="tel" inputmode="tel" />
            </div>
            <button class="btn btn-gold btn-block" id="regSendBtn">Envoyer le code →</button>
            <div class="form-error" id="regErr"></div>
          </div>

          <div id="regStep2" class="hidden">
            <div class="otp-phone-display">Code envoyé au <strong id="regPhoneDisplay"></strong></div>
            <div class="otp-demo-box" id="regDemoBox">Code de démo :<strong id="regDemoCode"></strong></div>
            ${OTP_BOXES}
            <div class="form-error" id="regOtpErr"></div>
            <button class="otp-resend" id="regResend">Renvoyer le code</button>
          </div>

          <div class="modal-switch">Déjà inscrit ? <a data-switch="login">Se connecter</a></div>
        </div>
      </div>`);

    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) closeModal(); });
    m.querySelector('[data-switch]').onclick = () => { closeModal(); loginModal(); };

    let currentPhone = '';
    let currentName = '';

    const step1 = m.querySelector('#regStep1');
    const step2 = m.querySelector('#regStep2');
    const errEl = m.querySelector('#regErr');
    const otpErrEl = m.querySelector('#regOtpErr');

    async function sendCode() {
      const name = m.querySelector('#regName').value.trim();
      const phone = m.querySelector('#regPhone').value.trim();
      errEl.textContent = '';
      if (!name) { errEl.textContent = 'Entre ton prénom.'; return; }
      const btn = m.querySelector('#regSendBtn');
      btn.disabled = true; btn.textContent = 'Envoi…';
      try {
        const res = await api('/auth/request-otp', { method: 'POST', body: { phone, name, isRegister: true } });
        currentPhone = phone; currentName = name;
        m.querySelector('#regPhoneDisplay').textContent = phone;
        m.querySelector('#regDemoCode').textContent = res._demo_code || '------';
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
        m.querySelector('#rs2').classList.add('active');
        m.querySelectorAll('.otp-digit')[0]?.focus();
      } catch (e) {
        errEl.textContent = e.message;
        btn.disabled = false; btn.textContent = 'Envoyer le code →';
      }
    }

    m.querySelector('#regSendBtn').onclick = sendCode;
    m.querySelector('#regPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(); });
    m.querySelector('#regResend').onclick = async () => {
      try {
        const res = await api('/auth/request-otp', { method: 'POST', body: { phone: currentPhone, name: currentName, isRegister: true } });
        m.querySelector('#regDemoCode').textContent = res._demo_code || '------';
        toast('Nouveau code envoyé !');
      } catch (e) { otpErrEl.textContent = e.message; }
    };

    mountOtpInputs(m, async (code) => {
      otpErrEl.textContent = '';
      try {
        const { token, user } = await api('/auth/verify-otp', { method: 'POST', body: { phone: currentPhone, code } });
        setSession(token, user);
        closeModal();
        toast('Bienvenue ' + (user.name) + ' — ton compte KORAWAVE est actif !');
        await loadData(); render();
      } catch (e) {
        otpErrEl.textContent = e.message;
        m.querySelectorAll('.otp-digit').forEach((x) => { x.value = ''; });
        m.querySelectorAll('.otp-digit')[0]?.focus();
      }
    });

    $('#modalRoot').appendChild(m);
    m.querySelector('#regName').focus();
  }

  // ============================================================
  //  DONNÉES
  // ============================================================
  async function loadData() {
    try {
      const [t, v, b, fp, tg] = await Promise.all([
        api('/tracks'),
        api('/videos'),
        api('/battles').catch(() => ({ battles: [] })),
        api('/fan-packs').catch(() => ({ packs: [] })),
        api('/top-guinee').catch(() => ({ champions: [] })),
      ]);
      State.tracks = t.tracks || [];
      State.videos = v.videos || [];
      State.battles = b.battles || [];
      State.fanPacks = fp.packs || [];
      State.topGuinee = tg.champions || [];
    } catch (e) { console.error(e); }
  }

  async function loadWallet() {
    if (!State.user) { State.walletData = null; return; }
    try { State.walletData = await api('/wallet'); }
    catch (e) { State.walletData = null; }
  }

  // Synchronise le solde affiché dans le chip après une opération KOINS
  function syncBalance(balance) {
    if (State.user) State.user.koins = balance;
    if (State.walletData) State.walletData.balance = balance;
    if (State.user && State.user.role === 'user') $('#userKoins').textContent = fmtNum(balance) + ' KOINS';
  }

  function filteredTracks() {
    let list = State.tracks;
    if (State.genreFilter) list = list.filter((t) => (t.genre || '').toLowerCase() === State.genreFilter.toLowerCase());
    if (State._artistFilter) list = list.filter((t) => t.ownerId === State._artistFilter);
    if (State.search) list = list.filter((t) => (t.title + ' ' + t.artist + ' ' + (t.genre||'')).toLowerCase().includes(State.search));
    return list;
  }
  function filteredVideos() {
    let list = State.videos;
    if (State._artistFilter) list = list.filter((v) => v.ownerId === State._artistFilter);
    if (State.search) list = list.filter((v) => (v.title + ' ' + v.artist + ' ' + (v.genre||'')).toLowerCase().includes(State.search));
    return list;
  }

  // ============================================================
  //  RENDU DES VUES
  // ============================================================
  function trackCard(t) {
    const cover = t.coverUrl
      ? `<img src="${esc(t.coverUrl)}" alt="" />`
      : `<div class="ph">♪</div>`;
    const scheduled = t.released === false;
    return `
      <div class="card audio ${scheduled ? 'scheduled' : ''}" data-track="${t.id}">
        ${scheduled ? '<span class="tag tag-soon">Bientôt</span>' : ''}
        <div class="card-art">
          ${cover}
          ${scheduled ? '<div class="lock">🔒</div>' : `<button class="play-fab" data-play="${t.id}">▶</button>`}
        </div>
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-sub"><button class="artist-link" data-artist-page="${esc(t.ownerId || '')}">${esc(t.artist)}${t.verified ? ' <span class="verified-badge">✔</span>' : ''}${t.artistBattleWins > 0 ? ' <span class="battle-badge" title="Battle Winner">🏆</span>' : ''}</button></div>
        <div class="card-meta">
          ${scheduled
            ? `<span class="card-soon">⏳ <span data-countdown="${t.releaseAt}">${countdownText(t.releaseAt)}</span></span>`
            : `<span class="card-price">${fmtMoney(t.price)}</span><button class="cmt-pill" data-detail="audio:${t.id}" title="Commentaires & détails">💬 ${fmtNum(t.comments || 0)}</button><button class="prev-pill" data-preview="${t.id}" title="Aperçu gratuit 10 secondes">◷ 10s</button>${t.owned ? '<span class="owned-pill">✓ Acheté</span>' : `<button class="buy-pill" data-buy="audio:${t.id}" title="Acheter avec des KOINS">${fmtNum(t.price)} K</button>`}${State.user ? `<button class="pl-pill" data-addtopl="${t.id}" title="Ajouter à une playlist">+📋</button>` : ''}`}
        </div>
      </div>`;
  }

  function videoCard(v) {
    const thumb = v.thumbUrl
      ? `<img src="${esc(v.thumbUrl)}" alt="" />`
      : `<div class="ph">🎬</div>`;
    const scheduled = v.released === false;
    return `
      <div class="card video ${scheduled ? 'scheduled' : ''}" data-video="${v.id}">
        <span class="tag ${scheduled ? 'tag-soon' : ''}">${scheduled ? 'Bientôt' : 'Clip'}</span>
        <div class="card-art">
          ${thumb}
          ${scheduled ? '<div class="lock">🔒</div>' : `<button class="play-fab" data-playvideo="${v.id}">▶</button>`}
        </div>
        <div class="card-title">${esc(v.title)}</div>
        <div class="card-sub"><button class="artist-link" data-artist-page="${esc(v.ownerId || '')}">${esc(v.artist)}${v.verified ? ' <span class="verified-badge">✔</span>' : ''}${v.artistBattleWins > 0 ? ' <span class="battle-badge" title="Battle Winner">🏆</span>' : ''}</button></div>
        <div class="card-meta">
          ${scheduled
            ? `<span class="card-soon">⏳ <span data-countdown="${v.releaseAt}">${countdownText(v.releaseAt)}</span></span>`
            : `<span class="card-price">${fmtMoney(v.price)}</span><button class="cmt-pill" data-detail="video:${v.id}" title="Commentaires & détails">💬 ${fmtNum(v.comments || 0)}</button><button class="prev-pill" data-previewvideo="${v.id}" title="Aperçu gratuit 10 secondes">◷ 10s</button>${v.owned ? '<span class="owned-pill">✓ Acheté</span>' : `<button class="buy-pill" data-buy="video:${v.id}" title="Acheter avec des KOINS">${fmtNum(v.price)} K</button>`}`}
        </div>
      </div>`;
  }

  function emptyBlock(icon, text) {
    return `<div class="empty"><div class="big">${icon}</div>${text}</div>`;
  }

  function topGuineeCard(c, rank) {
    const isChamp = rank === 0;
    const trackHTML = c.topTrack ? `
      <div class="tg-track" data-play-tg="${esc(c.topTrack.id)}">
        <div class="tg-track-art">
          ${c.topTrack.coverUrl ? `<img src="${esc(c.topTrack.coverUrl)}" />` : '♪'}
        </div>
        <div class="tg-track-info">
          <div class="tg-track-title">${esc(c.topTrack.title)}</div>
          <div class="tg-track-plays">${fmtNum(c.topTrack.plays)} écoute(s)</div>
        </div>
        <button class="tg-play-btn">▶</button>
      </div>` : `<div style="font-size:12px;color:var(--muted);text-align:center;padding:8px 0">Pas encore de titre publié</div>`;
    return `
      <div class="tg-card ${isChamp ? 'champion' : ''}">
        ${isChamp ? '<div class="tg-crown">👑</div>' : ''}
        <div class="tg-avatar">${esc(initial(c.artistName))}</div>
        <div class="tg-name">${esc(c.artistName)}${c.verified ? ' <span class="verified-badge">✔</span>' : ''}</div>
        <div class="tg-badges">
          <span class="tg-wins">🏆 ${fmtNum(c.battleWins)} victoire${c.battleWins > 1 ? 's' : ''}</span>
        </div>
        ${c.lastBattleTheme ? `<div class="tg-battle-theme">⚔️ ${esc(c.lastBattleTheme)}</div>` : ''}
        ${trackHTML}
      </div>`;
  }

  function viewHome() {
    const tracks = [...State.tracks].filter((t) => t.released !== false);
    const upcoming = [...State.tracks, ...State.videos]
      .filter((x) => x.released === false)
      .sort((a, b) => new Date(a.releaseAt) - new Date(b.releaseAt));
    const videos = filteredVideos().filter((v) => v.released !== false);
    const trending = [...State.tracks].filter((t) => t.released !== false)
      .sort((a, b) => b.plays - a.plays).slice(0, 12);
    const activePacks = State.fanPacks.filter((fp) => fp.status === 'active');

    const TICKER_GENRES = ['Afrobeats', 'Reggae', 'Jazz', 'Hip-hop', 'Mandingue', 'Mamaya', 'Faré-Gnakhi', 'Soussou', 'Pular', 'Mode Griot', 'Coupé-décalé', 'Gospel', 'Rap', 'Blues', 'Soul'];
    const tickerHtml = [...TICKER_GENRES, ...TICKER_GENRES].map(g =>
      `<span class="ticker-item" data-ticker-genre="${g}"><span class="ticker-dot"></span>${g}</span>`
    ).join('');

    function mkSlider(id, title, goldPart, cards, moreText) {
      return `
        <div class="slider-section">
          <div class="slider-head">
            <h2>${title} <span>${goldPart}</span></h2>
            <div class="slider-head-right">
              ${moreText ? `<span class="more">${moreText}</span>` : ''}
              <div class="sl-btns">
                <button class="sl-btn" data-sl-prev="${id}">‹</button>
                <button class="sl-btn" data-sl-next="${id}">›</button>
              </div>
            </div>
          </div>
          <div class="sl-track" id="${id}">${cards}</div>
        </div>`;
    }

    return `
      <section class="hero">
        <div class="hero-text">
          <div class="eyebrow">— La Voix de la Guinée</div>
          <h1>La musique guinéenne, <em>enfin chez elle</em>.</h1>
          <p>KORAWAVE est la première plateforme de streaming pensée pour la Guinée : paiement par Orange Money et MTN MoMo, écoute protégée par DRM, et une rémunération directe pour chaque artiste, à chaque écoute.</p>
          <div class="hero-cta">
            ${State.user ? '' : '<button class="btn btn-gold" id="heroRegister">Créer un compte gratuit</button>'}
            <button class="btn btn-outline" data-view-btn="music">Découvrir les artistes</button>
          </div>
          <button class="radio-btn-hero" id="radioBtn"><span class="dot"></span> Radio KORAWAVE — Lance une playlist selon ton humeur</button>
          <div class="hero-stats">
            <div class="hs"><span class="hs-val gold">50%</span><span class="hs-lab">reversés à l'artiste</span></div>
            <div class="hs"><span class="hs-val gold">500 GNF</span><span class="hs-lab">par titre audio</span></div>
            <div class="hs"><span class="hs-val">8 couches</span><span class="hs-lab">de protection DRM</span></div>
          </div>
        </div>
        <div class="hero-disc">
          <div class="disc-vinyl">
            <div class="disc-label"></div>
            <div class="disc-hole"></div>
          </div>
          <div class="float-tag ft-1"><span class="ft-dot"></span>Djama Foula — en cours</div>
          <div class="float-tag ft-2">+2,5M téléchargements</div>
          <div class="float-tag ft-3">500 GNF · <span style="color:var(--gold)">débloqué</span></div>
        </div>
      </section>

      <div class="genre-ticker"><div class="ticker-inner">${tickerHtml}</div></div>

      ${State.topGuinee.length ? `
      <div class="slider-section">
        <div class="slider-head"><h2>Top <span>Guinée</span> 🏆</h2><span class="more">Champions des battles KORAWAVE</span></div>
        <div class="tg-scroll">${State.topGuinee.map((c, i) => topGuineeCard(c, i)).join('')}</div>
      </div>` : ''}

      ${upcoming.length ? mkSlider('slUpcoming', 'Bientôt', 'disponible',
        upcoming.map(x => x.audioUrl !== undefined ? trackCard(x) : videoCard(x)).join(''),
        'Sorties programmées') : ''}

      ${mkSlider('slNew', 'À la', 'une',
        tracks.length ? tracks.slice(0, 12).map(trackCard).join('') : emptyBlock('🎵', "Aucun titre pour l'instant."),
        'Nouveautés'
      )}

      ${trending.some(t => t.plays > 0) ? mkSlider('slTrend', 'Tendances', 'Guinée',
        trending.map(trackCard).join(''), trending.length + ' titres') : ''}

      ${activePacks.length ? `
      <div class="slider-section">
        <div class="slider-head">
          <h2>Fan <span>Packs</span></h2>
          <div class="slider-head-right">
            <span class="more">Bundles artiste avec réduction</span>
            <div class="sl-btns">
              <button class="sl-btn" data-sl-prev="slPacks">‹</button>
              <button class="sl-btn" data-sl-next="slPacks">›</button>
            </div>
          </div>
        </div>
        <div class="sl-track" id="slPacks">${activePacks.map(fanPackCard).join('')}</div>
      </div>` : ''}

      ${mkSlider('slVideos', 'Clips', 'vidéo',
        videos.length ? videos.slice(0, 8).map(videoCard).join('') : emptyBlock('🎬', 'Aucun clip vidéo pour le moment.'),
        videos.length + ' clips'
      )}`;
  }

  function mountSliders() {
    document.querySelectorAll('[data-sl-prev],[data-sl-next]').forEach(btn => {
      const isPrev = btn.hasAttribute('data-sl-prev');
      const id = isPrev ? btn.dataset.slPrev : btn.dataset.slNext;
      const track = document.getElementById(id);
      if (!track) return;
      btn.addEventListener('click', () => {
        track.scrollBy({ left: isPrev ? -(track.offsetWidth * .75) : track.offsetWidth * .75, behavior: 'smooth' });
      });
    });
  }

  // ============================================================
  //  PLAYLISTS
  // ============================================================

  async function viewPlaylists() {
    if (!State.user) { loginModal(); return '<div class="empty">Connecte-toi pour voir tes playlists.</div>'; }
    const data = await api('/playlists');
    const pls = data.playlists || [];
    return `
      <div class="dash-head">
        <h1>📋 Mes Playlists</h1>
        <button class="btn btn-gold" id="createPlBtn">+ Nouvelle playlist</button>
      </div>
      ${pls.length === 0
        ? emptyBlock('📋', 'Aucune playlist. Crée-en une !')
        : `<div class="pl-grid">${pls.map((p) => `
          <div class="pl-card" data-open-pl="${esc(p.id)}">
            <div class="pl-icon">♪</div>
            <div class="pl-info">
              <div class="pl-name">${esc(p.name)}</div>
              <div class="pl-meta">${fmtNum(p.trackCount)} titre${p.trackCount !== 1 ? 's' : ''}</div>
            </div>
            <div class="pl-actions">
              <button class="btn btn-outline btn-sm" data-open-pl="${esc(p.id)}">▶ Ouvrir</button>
              <button class="btn btn-ghost btn-sm pl-del" data-del-pl="${esc(p.id)}" title="Supprimer">🗑</button>
            </div>
          </div>`).join('')}
        </div>`}
    `;
  }

  async function viewPlaylistDetail() {
    const id = State._playlistId;
    if (!id) { State.view = 'playlists'; render(); return ''; }
    let pl;
    try { pl = (await api('/playlists/' + id)).playlist; }
    catch (e) { return `<div class="empty">${esc(e.message)}</div>`; }
    return `
      <div class="dash-head">
        <button class="btn btn-ghost btn-sm" id="backToPlaylists">← Playlists</button>
        <h1>📋 ${esc(pl.name)}</h1>
        <div style="display:flex;gap:8px">
          ${pl.tracks.length ? `<button class="btn btn-gold" id="plPlayAll">▶ Tout écouter</button>` : ''}
          <button class="btn btn-ghost btn-sm" id="renamePlBtn" data-pl-id="${esc(pl.id)}">✏️ Renommer</button>
        </div>
      </div>
      <p class="pl-detail-meta">${fmtNum(pl.tracks.length)} titre${pl.tracks.length !== 1 ? 's' : ''}</p>
      ${pl.tracks.length === 0
        ? emptyBlock('🎵', 'Playlist vide. Ajoute des titres via le bouton +📋 sur les cartes.')
        : `<div class="pl-track-list">${pl.tracks.map((t, i) => `
          <div class="pl-track-row" data-play="${t.id}">
            <span class="ptr-num">${i + 1}</span>
            <div class="ptr-art">${t.coverUrl ? `<img src="${esc(t.coverUrl)}" />` : '♪'}</div>
            <div class="ptr-info">
              <div class="ptr-title">${esc(t.title)}</div>
              <div class="ptr-artist">${esc(t.artist)}</div>
            </div>
            <div class="ptr-right">
              <span class="ptr-price">${fmtMoney(t.price)}</span>
              <button class="btn btn-ghost btn-sm pl-remove-track" data-pl-id="${esc(pl.id)}" data-track-id="${esc(t.id)}" title="Retirer de la playlist">✕</button>
            </div>
          </div>`).join('')}
        </div>`}
    `;
  }

  function mountPlaylistDetail() {
    const pl = { id: State._playlistId };
    document.getElementById('backToPlaylists')?.addEventListener('click', () => { State.view = 'playlists'; State._playlistId = null; render(); });
    document.getElementById('plPlayAll')?.addEventListener('click', async () => {
      try {
        const data = await api('/playlists/' + pl.id);
        State.queue = data.playlist.tracks;
        State.queueIndex = 0;
        loadCurrent(!canPlayFull());
        toast('▶ Lecture de la playlist');
      } catch (e) { toast(e.message); }
    });
    document.getElementById('renamePlBtn')?.addEventListener('click', () => renamePlModal(pl.id));
  }

  function mountPlaylistsView() {
    document.getElementById('createPlBtn')?.addEventListener('click', () => createPlModal());

    document.querySelectorAll('[data-open-pl]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.openPl;
        State._playlistId = id;
        State.view = 'playlistDetail';
        render();
      });
    });

    document.querySelectorAll('[data-del-pl]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Supprimer cette playlist ?')) return;
        try {
          await api('/playlists/' + btn.dataset.delPl, { method: 'DELETE' });
          toast('Playlist supprimée');
          render();
        } catch (err) { toast(err.message); }
      });
    });
  }

  function createPlModal(trackId) {
    if (!State.user) { loginModal(); return; }
    const m = el(`<div class="overlay">
      <div class="modal">
        <button class="modal-close" data-close>&times;</button>
        <div class="modal-tag">📋 Nouvelle playlist</div>
        <form id="createPlForm" style="margin-top:16px">
          <input class="form-input" id="plNameInput" placeholder="Nom de la playlist" maxlength="60" required autofocus />
          <button class="btn btn-gold btn-block" style="margin-top:12px" type="submit">Créer</button>
          <div class="form-error" id="createPlErr"></div>
        </form>
      </div>
    </div>`);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close) { m.remove(); } });
    m.querySelector('#createPlForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = m.querySelector('#plNameInput').value.trim();
      if (!name) return;
      try {
        const r = await api('/playlists', { method: 'POST', body: { name } });
        if (trackId) {
          await api('/playlists/' + r.playlist.id + '/tracks', { method: 'POST', body: { trackId } });
          toast('✓ Ajouté à "' + r.playlist.name + '"');
        } else {
          toast('✓ Playlist "' + r.playlist.name + '" créée');
        }
        m.remove();
        if (State.view === 'playlists') render();
      } catch (err) { m.querySelector('#createPlErr').textContent = err.message; }
    });
    $('#modalRoot').appendChild(m);
    setTimeout(() => m.querySelector('#plNameInput').focus(), 50);
  }

  function renamePlModal(plId) {
    const m = el(`<div class="overlay">
      <div class="modal">
        <button class="modal-close" data-close>&times;</button>
        <div class="modal-tag">✏️ Renommer la playlist</div>
        <form id="renamePlForm" style="margin-top:16px">
          <input class="form-input" id="renamePlInput" placeholder="Nouveau nom" maxlength="60" required autofocus />
          <button class="btn btn-gold btn-block" style="margin-top:12px" type="submit">Enregistrer</button>
          <div class="form-error" id="renamePlErr"></div>
        </form>
      </div>
    </div>`);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close) m.remove(); });
    m.querySelector('#renamePlForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = m.querySelector('#renamePlInput').value.trim();
      if (!name) return;
      try {
        await api('/playlists/' + plId, { method: 'PATCH', body: { name } });
        toast('✓ Playlist renommée');
        m.remove();
        render();
      } catch (err) { m.querySelector('#renamePlErr').textContent = err.message; }
    });
    $('#modalRoot').appendChild(m);
    setTimeout(() => m.querySelector('#renamePlInput').focus(), 50);
  }

  function addToPlaylistModal(trackId) {
    if (!State.user) { loginModal(); return; }
    api('/playlists').then((data) => {
      const pls = data.playlists || [];
      const m = el(`<div class="overlay">
        <div class="modal">
          <button class="modal-close" data-close>&times;</button>
          <div class="modal-tag">📋 Ajouter à une playlist</div>
          ${pls.length === 0
            ? '<p style="color:var(--muted);margin:16px 0">Tu n\'as pas encore de playlist.</p>'
            : `<div class="atpl-list">${pls.map((p) => `
              <button class="atpl-item" data-atpl-id="${esc(p.id)}" data-atpl-name="${esc(p.name)}">
                <span class="atpl-icon">♪</span>
                <span class="atpl-name">${esc(p.name)}</span>
                <span class="atpl-count">${fmtNum(p.trackCount)} titre${p.trackCount !== 1 ? 's' : ''}</span>
              </button>`).join('')}
            </div>`}
          <button class="btn btn-outline btn-block" id="newPlFromAdd" style="margin-top:12px">+ Créer une nouvelle playlist</button>
        </div>
      </div>`);
      m.addEventListener('click', async (e) => {
        if (e.target === m || e.target.dataset.close) { m.remove(); return; }
        const item = e.target.closest('[data-atpl-id]');
        if (item) {
          try {
            await api('/playlists/' + item.dataset.atplId + '/tracks', { method: 'POST', body: { trackId } });
            toast('✓ Ajouté à "' + item.dataset.atplName + '"');
            m.remove();
          } catch (err) {
            if (err.message.includes('Déjà')) toast('Déjà dans cette playlist');
            else toast(err.message);
            m.remove();
          }
          return;
        }
        if (e.target.id === 'newPlFromAdd') { m.remove(); createPlModal(trackId); }
      });
      $('#modalRoot').appendChild(m);
    }).catch(() => toast('Erreur lors du chargement des playlists'));
  }

  // ============================================================
  //  MESSAGERIE DM
  // ============================================================

  function fmtMsgTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'À l\'instant';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min';
    if (diff < 86400000) return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    return d.getDate() + '/' + (d.getMonth() + 1);
  }

  async function viewMessages() {
    if (!State.user) { loginModal(); return '<div class="empty">Connecte-toi pour accéder à ta messagerie.</div>'; }
    const data = await api('/messages');
    const threads = data.threads || [];
    return `
      <div class="dash-head">
        <h1>💬 Messages</h1>
        ${data.totalUnread > 0 ? `<span class="dm-unread-total">${data.totalUnread} non lu${data.totalUnread > 1 ? 's' : ''}</span>` : ''}
      </div>
      ${threads.length === 0
        ? emptyBlock('💬', 'Aucune conversation. Envoie un message à un artiste depuis son profil.')
        : `<div class="dm-thread-list">${threads.map((t) => `
          <div class="dm-thread" data-open-thread="${esc(t.partnerId)}">
            <div class="dm-avatar">${esc(initial(t.partnerName))}</div>
            <div class="dm-info">
              <div class="dm-name">
                ${esc(t.partnerName)}
                ${t.partnerRole === 'artist' ? '<span class="role-badge rb-artist">Artiste</span>' : ''}
              </div>
              <div class="dm-preview">${esc(t.lastMessage)}</div>
            </div>
            <div class="dm-meta">
              <span class="dm-time">${fmtMsgTime(t.lastAt)}</span>
              ${t.unread > 0 ? `<span class="dm-badge">${t.unread}</span>` : ''}
            </div>
          </div>`).join('')}
        </div>`}
    `;
  }

  async function viewThread() {
    const partnerId = State._threadPartnerId;
    if (!partnerId) { State.view = 'messages'; render(); return ''; }
    let thread;
    try { thread = await api('/messages/' + partnerId); }
    catch (e) { return `<div class="empty">${esc(e.message)}</div>`; }
    const me = State.user.id;
    return `
      <div class="dash-head">
        <button class="btn btn-ghost btn-sm" id="backToMessages">← Messages</button>
        <h1>💬 ${esc(thread.partner.name)}${thread.partner.verified ? ' <span class="verified-badge">✔</span>' : ''}</h1>
      </div>
      <div class="dm-bubble-list" id="dmBubbleList">
        ${thread.messages.length === 0
          ? `<div style="text-align:center;color:var(--muted);padding:40px 0">Aucun message. Dis bonjour !</div>`
          : thread.messages.map((m) => {
              const mine = m.fromId === me;
              return `<div class="dm-bubble ${mine ? 'dm-mine' : 'dm-theirs'}">
                <div class="dm-bubble-body">${esc(m.body)}</div>
                <div class="dm-bubble-time">${fmtMsgTime(m.createdAt)}</div>
              </div>`;
            }).join('')}
      </div>
      <form class="dm-compose" id="dmComposeForm">
        <input class="dm-input" id="dmInput" placeholder="Écris ton message…" maxlength="500" autocomplete="off" />
        <button class="btn btn-gold dm-send" type="submit">Envoyer</button>
      </form>
    `;
  }

  function mountThread() {
    document.getElementById('backToMessages')?.addEventListener('click', () => {
      State.view = 'messages'; State._threadPartnerId = null; render();
    });
    const form = document.getElementById('dmComposeForm');
    const input = document.getElementById('dmInput');
    const list = document.getElementById('dmBubbleList');
    // Scroll to bottom
    if (list) list.scrollTop = list.scrollHeight;
    if (input) setTimeout(() => input.focus(), 100);
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      try {
        const r = await api('/messages/' + State._threadPartnerId, { method: 'POST', body: { body } });
        input.value = '';
        // Append bubble without full re-render
        const bubble = el(`<div class="dm-bubble dm-mine">
          <div class="dm-bubble-body">${esc(r.message.body)}</div>
          <div class="dm-bubble-time">À l'instant</div>
        </div>`);
        list.appendChild(bubble);
        list.scrollTop = list.scrollHeight;
      } catch (err) { toast(err.message); }
    });
  }

  function mountMessagesView() {
    document.querySelectorAll('[data-open-thread]').forEach((row) => {
      row.addEventListener('click', () => {
        State._threadPartnerId = row.dataset.openThread;
        State.view = 'thread';
        render();
      });
    });
  }

  // ============================================================
  //  NOTIFICATIONS PUSH (Web Push API)
  // ============================================================

  let _swReg = null;

  async function initPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      _swReg = await navigator.serviceWorker.register('/sw.js');
    } catch (e) { console.warn('SW non enregistré', e); }
  }

  async function subscribePush() {
    if (!State.user) { loginModal(); return; }
    if (!_swReg) { toast('Notifications non supportées par ce navigateur'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Permission refusée'); return; }
    try {
      const { publicKey } = await api('/push/vapid-key');
      const sub = await _swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api('/push/subscribe', { method: 'POST', body: { subscription: sub } });
      toast('🔔 Notifications activées !');
      updatePushBtn(true);
    } catch (e) { toast('Erreur : ' + e.message); }
  }

  async function unsubscribePush() {
    try {
      if (_swReg) {
        const sub = await _swReg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      }
      await api('/push/subscribe', { method: 'DELETE' });
      toast('Notifications désactivées');
      updatePushBtn(false);
    } catch (e) { toast(e.message); }
  }

  async function isPushSubscribed() {
    if (!_swReg) return false;
    try { return !!(await _swReg.pushManager.getSubscription()); }
    catch { return false; }
  }

  function updatePushBtn(active) {
    const btn = document.getElementById('pushToggleBtn');
    if (!btn) return;
    btn.textContent = active ? '🔔 Notifications activées' : '🔕 Activer les notifications';
    btn.className = 'btn ' + (active ? 'btn-gold' : 'btn-outline') + ' btn-sm';
    btn.dataset.pushActive = active ? '1' : '0';
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }

  // Badge non-lus messagerie — polling 45s (réutilise le même intervalle que les notifs)
  let _msgBadgeTimer = null;
  function startMsgBadge() {
    if (_msgBadgeTimer) return;
    async function refresh() {
      if (!State.user) return;
      try {
        const r = await api('/messages/unread-count');
        const badge = document.getElementById('msgBadge');
        if (!badge) return;
        if (r.count > 0) { badge.textContent = r.count; badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
      } catch (_) {}
    }
    refresh();
    _msgBadgeTimer = setInterval(refresh, 45000);
  }

  // ============================================================
  //  RECONNAISSANCE AUDIO (style Shazam)
  // ============================================================

  function identifyModal() {
    const m = el(`<div class="overlay id-overlay">
      <div class="modal id-modal">
        <button class="modal-close" data-close>&times;</button>
        <div class="id-logo">🎤</div>
        <div class="id-title">Identifier un morceau</div>
        <div class="id-sub" id="idSub">Appuie sur Écouter et joue ta musique</div>
        <div class="id-wave" id="idWave">
          <span></span><span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span><span></span>
        </div>
        <div class="id-countdown" id="idCountdown"></div>
        <button class="btn btn-gold id-start-btn" id="idStartBtn">🎤 Écouter (10 sec)</button>
        <div class="id-result hidden" id="idResult"></div>
      </div>
    </div>`);

    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close) { stopIdentify(); m.remove(); } });
    $('#modalRoot').appendChild(m);

    let mediaStream = null, recorder = null, timer = null;

    function stopIdentify() {
      clearInterval(timer);
      if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      m.querySelector('#idWave').classList.remove('id-listening');
    }

    async function showResult(found, track, score) {
      const resultEl = m.querySelector('#idResult');
      resultEl.classList.remove('hidden');
      m.querySelector('#idStartBtn').textContent = '🔄 Réessayer';
      m.querySelector('#idStartBtn').disabled = false;
      m.querySelector('#idSub').textContent = found ? `Trouvé avec ${score}% de confiance` : 'Morceau non reconnu dans le catalogue KORAWAVE';

      if (!found) {
        resultEl.innerHTML = `<div class="id-no-match">😕 Morceau non trouvé<br><small>Le titre n'est peut-être pas encore dans le catalogue.</small></div>`;
        return;
      }
      resultEl.innerHTML = `
        <div class="id-match-card">
          <div class="id-match-art">${track.coverUrl ? `<img src="${esc(track.coverUrl)}" />` : '♪'}</div>
          <div class="id-match-info">
            <div class="id-match-title">${esc(track.title)}</div>
            <div class="id-match-artist">${esc(track.artist)}${track.verified ? ' <span class="verified-badge">✔</span>' : ''}</div>
            <div class="id-match-genre">${esc(track.genre || '')}</div>
          </div>
        </div>
        <button class="btn btn-gold btn-block" id="idPlayBtn" style="margin-top:12px">▶ Écouter maintenant</button>
      `;
      m.querySelector('#idPlayBtn')?.addEventListener('click', () => {
        m.remove();
        playTrack(track.id);
      });
    }

    m.querySelector('#idStartBtn').addEventListener('click', async function () {
      this.disabled = true;
      m.querySelector('#idResult').classList.add('hidden');
      m.querySelector('#idSub').textContent = 'Écoute en cours…';
      m.querySelector('#idWave').classList.add('id-listening');
      m.querySelector('#idCountdown').textContent = '10';

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        m.querySelector('#idSub').textContent = 'Accès micro refusé';
        this.disabled = false;
        return;
      }

      const chunks = [];
      recorder = new MediaRecorder(mediaStream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

      recorder.onstop = async () => {
        m.querySelector('#idWave').classList.remove('id-listening');
        m.querySelector('#idSub').textContent = 'Analyse en cours…';
        m.querySelector('#idCountdown').textContent = '';

        try {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          const arrayBuffer = await blob.arrayBuffer();
          const audioCtx = new AudioContext();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const samples = audioBuffer.getChannelData(0);
          const fingerprint = KWFingerprint.computeFingerprint(samples, audioBuffer.sampleRate);

          if (fingerprint.length < 30) throw new Error('Enregistrement trop court');

          const r = await api('/identify', { method: 'POST', body: { fingerprint } });
          await showResult(r.found, r.track, r.score);
        } catch (err) {
          m.querySelector('#idSub').textContent = 'Erreur : ' + err.message;
          m.querySelector('#idStartBtn').disabled = false;
        }
      };

      recorder.start();
      let secs = 10;
      timer = setInterval(() => {
        secs--;
        m.querySelector('#idCountdown').textContent = secs > 0 ? secs : '';
        if (secs <= 0) { clearInterval(timer); recorder.stop(); stopIdentify(); }
      }, 1000);
    });
  }

  // Calculer et envoyer l'empreinte d'un titre (admin, depuis l'URL du fichier)
  async function computeAndSendFingerprint(trackId, audioUrl) {
    const r = await fetch(audioUrl);
    const buf = await r.arrayBuffer();
    const ctx = new AudioContext();
    const ab = await ctx.decodeAudioData(buf);
    const samples = ab.getChannelData(0);
    const fp = KWFingerprint.computeFingerprint(samples, ab.sampleRate);
    await api('/tracks/' + trackId + '/fingerprint', { method: 'POST', body: { fingerprint: fp } });
    return fp.length;
  }

  let _artistProfile = null;

  async function viewArtistPublic() {
    const id = State._artistPageId;
    if (!id) { go('home'); return ''; }
    let p;
    try {
      p = await api('/artists/' + id + '/profile');
      _artistProfile = p;
    } catch (e) {
      return `<div class="empty">${esc(e.message)}</div>`;
    }

    return `
      <div class="ap-hero">
        <div class="ap-avatar">${esc(initial(p.name))}</div>
        <div class="ap-info">
          <div class="ap-name">
            ${esc(p.name)}
            ${p.verified ? '<span class="verified-badge ap-badge">✔ Vérifié</span>' : ''}
            ${p.battleWins > 0 ? `<span class="ap-wins">🏆 ×${p.battleWins}</span>` : ''}
          </div>
          ${p.bio ? `<p class="ap-bio">${esc(p.bio)}</p>` : '<p class="ap-bio" style="color:var(--muted2)">Aucune bio pour le moment.</p>'}
          <div class="ap-stats">
            <div class="ap-stat"><span class="ap-stat-val">${fmtNum(p.tracks.length + p.videos.length)}</span><span class="ap-stat-lab">Titres</span></div>
            <div class="ap-stat"><span class="ap-stat-val" id="apFollowers">${fmtNum(p.followers)}</span><span class="ap-stat-lab">Abonnés</span></div>
            <div class="ap-stat"><span class="ap-stat-val">${fmtNum(p.totalPlays)}</span><span class="ap-stat-lab">Écoutes</span></div>
          </div>
          <div class="ap-actions">
            <button class="btn ${p.isFollowing ? 'btn-outline ap-following' : 'btn-gold'}" id="followBtn">
              ${p.isFollowing ? '✓ Suivi' : '+ Suivre'}
            </button>
            ${State.user && State.user.id !== p.id ? `<button class="btn btn-outline" id="msgArtistBtn" data-msg-partner="${p.id}">💬 Message</button>` : ''}
            ${p.tracks.length ? `<button class="btn btn-outline" id="playAllBtn">▶ Tout écouter</button>` : ''}
          </div>
        </div>
      </div>

      <div class="admin-tabs ap-tabs">
        <button class="atab active" data-aptab="tracks">🎵 Titres (${p.tracks.length})</button>
        ${p.videos.length ? `<button class="atab" data-aptab="videos">🎬 Clips (${p.videos.length})</button>` : ''}
      </div>

      <div id="apContent">
        ${p.tracks.length
          ? `<div class="card-grid">${p.tracks.map(trackCard).join('')}</div>`
          : emptyBlock('🎵', 'Pas encore de titre.')}
      </div>
    `;
  }

  function mountArtistPage() {
    const p = _artistProfile;
    if (!p) return;

    // Tabs
    document.querySelectorAll('[data-aptab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-aptab]').forEach((b) => b.classList.toggle('active', b === btn));
        const content = document.getElementById('apContent');
        if (btn.dataset.aptab === 'videos') {
          content.innerHTML = p.videos.length
            ? `<div class="card-grid">${p.videos.map(videoCard).join('')}</div>`
            : emptyBlock('🎬', 'Pas encore de clip.');
        } else {
          content.innerHTML = p.tracks.length
            ? `<div class="card-grid">${p.tracks.map(trackCard).join('')}</div>`
            : emptyBlock('🎵', 'Pas encore de titre.');
        }
      });
    });

    // Follow
    const followBtn = document.getElementById('followBtn');
    if (followBtn) {
      followBtn.addEventListener('click', async () => {
        if (!State.user) { loginModal(); return; }
        try {
          const r = await api('/artists/' + p.id + '/follow', { method: 'POST' });
          p.isFollowing = r.following;
          p.followers = r.followers;
          followBtn.textContent = r.following ? '✓ Suivi' : '+ Suivre';
          followBtn.className = 'btn ' + (r.following ? 'btn-outline ap-following' : 'btn-gold');
          const el = document.getElementById('apFollowers');
          if (el) el.textContent = fmtNum(r.followers);
          toast(r.following ? '✓ Tu suis ' + p.name : 'Tu ne suis plus ' + p.name);
        } catch (err) { toast(err.message); }
      });
    }

    // Play all
    const playAllBtn = document.getElementById('playAllBtn');
    if (playAllBtn) {
      playAllBtn.addEventListener('click', () => {
        if (!p.tracks.length) return;
        State.queue = [...p.tracks];
        State.queueIndex = 0;
        loadCurrent(!canPlayFull());
        toast('▶ Lecture : ' + p.name);
      });
    }
  }

  async function viewSearch() {
    const q = State.search;
    if (!q || q.length < 2) {
      return `<div class="dash-head"><h1>Recherche</h1><p>Tape au moins 2 caractères.</p></div>`;
    }
    let data;
    try {
      data = await api('/search?q=' + encodeURIComponent(q));
    } catch (e) {
      return `<div class="empty">${esc(e.message)}</div>`;
    }
    const total = data.artists.length + data.tracks.length + data.videos.length;
    if (!total) return `
      <div class="dash-head"><h1>Recherche <span>"${esc(q)}"</span></h1><p>Aucun résultat.</p></div>
      ${emptyBlock('🔎', 'Essaie un autre mot-clé ou vérifie l\'orthographe.')}`;

    return `
      <div class="dash-head">
        <h1>Résultats <span>"${esc(q)}"</span></h1>
        <p>${total} résultat(s) — artistes · titres · clips</p>
      </div>

      ${data.artists.length ? `
        <div class="search-section">
          <h2 class="section-title">Artistes</h2>
          <div class="search-artists">
            ${data.artists.map((a) => `
              <button class="sac" data-search-artist="${esc(a.id)}">
                <div class="sac-av">${esc(initial(a.name))}</div>
                <div class="sac-name">${esc(a.name)}${a.verified ? ' <span class="verified-badge">✔</span>' : ''}${a.battleWins ? ` <span class="battle-badge">🏆</span>` : ''}</div>
                <div class="sac-meta">${a.tracks} titre(s) · ${a.videos} clip(s)</div>
              </button>`).join('')}
          </div>
        </div>` : ''}

      ${data.tracks.length ? `
        <div class="search-section">
          <h2 class="section-title">Titres audio</h2>
          <div class="card-grid">${data.tracks.map(trackCard).join('')}</div>
        </div>` : ''}

      ${data.videos.length ? `
        <div class="search-section">
          <h2 class="section-title">Clips vidéo</h2>
          <div class="card-grid">${data.videos.map(videoCard).join('')}</div>
        </div>` : ''}
    `;
  }

  function viewMusic() {
    const tracks = filteredTracks();
    const chips = ['Tous', ...GENRES].map((g) =>
      `<button class="chip ${(!State.genreFilter && g === 'Tous') || State.genreFilter === g ? 'active' : ''}" data-chip="${g}">${g}</button>`
    ).join('');
    return `
      <div class="dash-head"><h1>Toute la <span>musique</span></h1><p>${tracks.length} titre(s) disponible(s)</p></div>
      <div class="chips">${chips}</div>
      <div class="card-grid" style="margin-top:18px">
        ${tracks.length ? tracks.map(trackCard).join('') : emptyBlock('🎵', 'Aucun titre trouvé.')}
      </div>`;
  }

  function viewVideos() {
    const videos = filteredVideos();
    return `
      <div class="dash-head"><h1>Clips <span>vidéo</span></h1><p>${videos.length} clip(s) disponible(s)</p></div>
      <div class="card-grid" style="margin-top:8px">
        ${videos.length ? videos.map(videoCard).join('') : emptyBlock('🎬', 'Aucun clip vidéo pour le moment.')}
      </div>`;
  }

  function viewGriot() {
    const tracks = State.tracks.filter((t) => (t.genre || '').toLowerCase().includes('griot'));
    return `
      <div class="dash-head"><h1>Mode <span>Griot</span> 🪕</h1><p>Le patrimoine musical guinéen — kora, balafon, djembé, chants de griots.</p></div>
      <div class="card-grid" style="margin-top:8px">
        ${tracks.length ? tracks.map(trackCard).join('') : emptyBlock('🪕', 'Aucun enregistrement Mode Griot pour le moment. Ajoute des titres avec le genre « Mode Griot ».')}
      </div>`;
  }

  // ============================================================
  //  PORTEFEUILLE KOINS
  // ============================================================
  const PACK_DEFAULT = [
    { id: 'p1', gnf: 1000, koins: 1000, bonus: 0 },
    { id: 'p2', gnf: 2000, koins: 2100, bonus: 5 },
    { id: 'p3', gnf: 5000, koins: 5500, bonus: 10 },
    { id: 'p4', gnf: 10000, koins: 11500, bonus: 15 },
  ];
  const PAY_LABELS = {
    orange_money: { name: 'Orange Money', sub: 'Guinée', cls: 'pm-orange', tag: 'OM' },
    mtn_momo: { name: 'MTN MoMo', sub: 'Mobile Money', cls: 'pm-mtn', tag: 'MTN' },
    soutra_money: { name: 'Soutra Money', sub: 'Guinée', cls: 'pm-soutra', tag: 'SM' },
  };

  async function viewWallet() {
    let w, packsData, ticketsData;
    try {
      [w, packsData, ticketsData] = await Promise.all([
        api('/wallet'),
        api('/koin-packs'),
        State.user ? api('/my-tickets').catch(() => ({ tickets: [] })) : Promise.resolve({ tickets: [] }),
      ]);
    } catch (e) { return `<div class="empty">${esc(e.message)}</div>`; }
    State.walletData = w;
    const packs = packsData.packs || PACK_DEFAULT;
    const myTickets = ticketsData.tickets || [];

    const txRows = w.transactions.length ? w.transactions.map((t) => `
      <div class="tx-item">
        <div class="tx-ic ${t.type}">${t.type === 'credit' ? '↓' : '↑'}</div>
        <div class="tx-info"><div class="t">${esc(t.label)}</div><div class="d">${fmtDateTime(t.createdAt)}${t.paymentRef ? ' · ' + esc(t.paymentRef) : ''}</div></div>
        <div class="tx-amount ${t.type}">${t.type === 'credit' ? '+' : '−'}${fmtNum(t.amount)} K</div>
      </div>`).join('') : '<div class="empty" style="padding:24px">Aucune transaction pour le moment.</div>';

    const ownedCount = (w.owned.audio.length + w.owned.video.length);

    const pushActive = await isPushSubscribed();
    return `
      <div class="wallet-hero">
        <div class="wallet-balance">
          <div class="lab">Solde de mon portefeuille</div>
          <div class="val">${fmtNum(w.balance)} <small>KOINS</small></div>
          <div class="sub">${fmtNum(ownedCount)} contenu(s) acheté(s) · ${fmtNum(w.totalPurchased)} KOINS rechargés au total</div>
        </div>
        <div class="wallet-note">1 000 GNF = 1 000 KOINS. Les KOINS n'expirent jamais et ne sont pas convertibles en argent (politique affichée à l'achat).</div>
        <div class="wallet-push-row">
          <button class="btn ${pushActive ? 'btn-gold' : 'btn-outline'} btn-sm" id="pushToggleBtn" data-push-active="${pushActive ? '1' : '0'}">
            ${pushActive ? '🔔 Notifications activées' : '🔕 Activer les notifications'}
          </button>
          ${pushActive ? `<button class="btn btn-ghost btn-sm" id="pushTestBtn">Tester</button>` : ''}
        </div>
      </div>

      <div class="sec-head"><h2>Recharger mes <span>KOINS</span></h2><span class="more">Bonus fidélité</span></div>
      <div class="pack-grid">
        ${packs.map((p) => `
          <div class="pack">
            ${p.bonus ? `<div class="pk-bonus">+${p.bonus}%</div>` : ''}
            <div class="pk-koins">${fmtNum(p.koins)} <small>K</small></div>
            <div class="pk-gnf">${fmtMoney(p.gnf)}</div>
            <button class="btn btn-gold btn-block" data-pack="${p.id}">Recharger</button>
          </div>`).join('')}
      </div>

      ${myTickets.length ? `
      <div class="sec-head"><h2>Mes <span>billets</span> 🎟️</h2></div>
      <div style="display:flex;flex-direction:column;gap:12px">
        ${myTickets.map((t) => `
          <div class="ticket-card">
            <div class="tc-icon">🎟️</div>
            <div class="tc-info">
              <div class="tc-title">${esc(t.event?.title || 'Événement')}</div>
              <div class="tc-sub">📅 ${fmtEventDate(t.event?.date)} · 📍 ${esc(t.event?.venue || '')}</div>
              <div class="tc-sub" style="margin-top:4px">Acheté le ${fmtDateTime(t.purchasedAt)}</div>
            </div>
            <div class="tc-actions">
              <span class="ticket-status-badge ${t.status}" style="font-size:11px">${t.status === 'used' ? '✓ Utilisé' : '✓ Valide'}</span>
              <button class="tc-qr-btn" data-event="${esc(t.eventId)}">Voir QR</button>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div class="sec-head"><h2>Mes <span>transactions</span></h2></div>
      <div class="card" style="padding:8px 22px"><div class="tx-list">${txRows}</div></div>`;
  }

  function rechargeModal(packId) {
    const pack = PACK_DEFAULT.find((p) => p.id === packId) || PACK_DEFAULT[0];
    let method = 'orange_money';
    const m = el(`
      <div class="overlay">
        <div class="modal">
          <button class="modal-close" data-close>&times;</button>
          <h3>Recharger <span style="color:var(--gold)">${fmtNum(pack.koins)} KOINS</span></h3>
          <p class="sub">${fmtMoney(pack.gnf)}${pack.bonus ? ` · +${pack.bonus}% de bonus inclus 🎁` : ''}</p>
          <div id="rechargeStep1">
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:8px">Choisis ton moyen de paiement</label>
            <div class="pay-methods">
              ${Object.entries(PAY_LABELS).map(([k, v], i) => `
                <div class="pay-method ${i === 0 ? 'sel' : ''}" data-method="${k}">
                  <div class="pm-logo ${v.cls}">${v.tag}</div>
                  <div><div class="pm-name">${v.name}</div><div class="pm-sub">${v.sub}</div></div>
                </div>`).join('')}
            </div>
            <div class="field" style="margin-top:14px">
              <label>Numéro ${''}Mobile Money</label>
              <input class="input" id="rechargePhone" value="${esc(State.user?.phone || '')}" placeholder="+224 6XX XX XX XX" />
            </div>
            <button class="btn btn-gold btn-block" id="payBtn">Payer ${fmtMoney(pack.gnf)}</button>
            <p class="sub" style="font-size:11px;margin-top:12px">🔒 Paiement simulé (sandbox de démonstration). En production : Orange Money API / MTN MoMo / Soutra.</p>
          </div>
          <div id="rechargeStep2" class="hidden"></div>
          <div class="form-error" id="rechargeErr"></div>
        </div>
      </div>`);
    m.querySelectorAll('.pay-method').forEach((pm) => {
      pm.onclick = () => {
        method = pm.dataset.method;
        m.querySelectorAll('.pay-method').forEach((x) => x.classList.toggle('sel', x === pm));
      };
    });
    m.querySelector('#payBtn').onclick = async () => {
      const phone = m.querySelector('#rechargePhone').value.trim();
      if (!/^\+?\d[\d\s]{7,}$/.test(phone)) { m.querySelector('#rechargeErr').textContent = 'Numéro invalide'; return; }
      // Étape simulée : on affiche un écran "paiement en cours"
      m.querySelector('#rechargeStep1').classList.add('hidden');
      const s2 = m.querySelector('#rechargeStep2');
      s2.classList.remove('hidden');
      s2.innerHTML = `<div class="pay-sim"><div class="pay-spinner"></div>Demande envoyée au ${PAY_LABELS[method].name}…<br>Confirme sur ton téléphone (simulation).</div>`;
      try {
        await new Promise((r) => setTimeout(r, 1400)); // simulation du délai USSD
        const res = await api('/wallet/recharge', { method: 'POST', body: { packId: pack.id, method, phone } });
        syncBalance(res.balance);
        s2.innerHTML = `<div class="pay-sim" style="color:var(--green)"><div style="font-size:40px;margin-bottom:10px">✓</div>Paiement confirmé — <b style="color:var(--gold)">+${fmtNum(res.credited)} KOINS</b><br><span style="font-size:11px">Réf : ${esc(res.paymentRef)}</span></div><button class="btn btn-gold btn-block" id="payDone">Terminé</button>`;
        s2.querySelector('#payDone').onclick = () => { closeModal(); if (State.view === 'wallet') render(); };
        toast('💰 +' + fmtNum(res.credited) + ' KOINS');
      } catch (e) {
        s2.innerHTML = `<div class="pay-sim" style="color:var(--red)">Échec : ${esc(e.message)}</div><button class="btn btn-outline btn-block" id="payRetry">Réessayer</button>`;
        s2.querySelector('#payRetry').onclick = () => rechargeModal(packId) || closeModal();
      }
    };
    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) closeModal(); });
    $('#modalRoot').appendChild(m);
  }

  async function buyContent(type, id) {
    if (!State.user) { toast('Connecte-toi pour acheter'); loginModal(); return; }
    const item = (type === 'audio' ? State.tracks : State.videos).find((x) => x.id === id);
    if (!item) return;
    if (!confirm(`Acheter « ${item.title} » pour ${fmtNum(item.price)} KOINS ?\n(Achat permanent lié à ton compte)`)) return;
    try {
      const res = await api('/purchase', { method: 'POST', body: { contentType: type, contentId: id } });
      syncBalance(res.balance);
      toast('✓ Acheté ! Il est à toi pour toujours.');
      await loadData(); render();
    } catch (e) {
      if (/insuffisant/i.test(e.message)) {
        toast('Solde insuffisant — recharge tes KOINS');
        go('wallet');
      } else { toast(e.message); }
    }
  }

  function tipModal(artistId, artistName) {
    if (!State.user) { loginModal(); return; }
    let amount = 500;
    const amounts = [100, 500, 1000, 5000];
    const m = el(`
      <div class="overlay">
        <div class="modal">
          <button class="modal-close" data-close>&times;</button>
          <h3>Soutenir <span style="color:var(--gold)">${esc(artistName)}</span> 💝</h3>
          <p class="sub">Envoie un pourboire en KOINS (50% reversés à l'artiste). Solde : ${fmtNum(State.user.koins)} K</p>
          <div class="tip-amounts">
            ${amounts.map((a, i) => `<button class="tip-amt ${i === 1 ? 'sel' : ''}" data-amt="${a}">${fmtNum(a)}</button>`).join('')}
          </div>
          <div class="field"><label>Ou montant libre (KOINS)</label><input class="input" id="tipCustom" type="number" min="1" placeholder="ex. 250" /></div>
          <button class="btn btn-gold btn-block" id="tipSend">Envoyer le pourboire</button>
          <div class="form-error" id="tipErr"></div>
        </div>
      </div>`);
    m.querySelectorAll('.tip-amt').forEach((b) => {
      b.onclick = () => { amount = parseInt(b.dataset.amt, 10); m.querySelector('#tipCustom').value = ''; m.querySelectorAll('.tip-amt').forEach((x) => x.classList.toggle('sel', x === b)); };
    });
    m.querySelector('#tipCustom').oninput = (e) => { const v = parseInt(e.target.value, 10); if (v > 0) { amount = v; m.querySelectorAll('.tip-amt').forEach((x) => x.classList.remove('sel')); } };
    m.querySelector('#tipSend').onclick = async () => {
      try {
        const res = await api('/tip', { method: 'POST', body: { artistId, amount } });
        syncBalance(res.balance);
        closeModal();
        toast('💝 Merci ! ' + fmtNum(amount) + ' KOINS envoyés à ' + artistName);
      } catch (e) { m.querySelector('#tipErr').textContent = e.message; }
    };
    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) closeModal(); });
    $('#modalRoot').appendChild(m);
  }

  // ============================================================
  //  SOCIAL — fiche détail + commentaires
  // ============================================================
  function commentHTML(c, canModerate) {
    return `
      <div class="comment ${c.status === 'flagged' ? 'flagged' : ''}" data-cid="${c.id}">
        <div class="c-av">${esc(initial(c.author))}</div>
        <div class="c-body">
          <div class="c-author">${esc(c.author)}${c.authorRole === 'artist' ? ' <span class="badge-art">✔ artiste</span>' : ''} ${c.status === 'flagged' ? '<span class="flag-tag">signalé</span>' : ''}</div>
          <div class="c-text">${esc(c.body)}</div>
          <div class="c-meta">
            <span>${fmtDateTime(c.createdAt)}</span>
            ${State.user && !c.mine ? `<button class="c-report" data-creport="${c.id}">${c.reportedByMe ? 'Signalé ✓' : 'Signaler'}</button>` : ''}
            ${(c.mine || canModerate) ? `<button class="c-del" data-cdel="${c.id}">Supprimer</button>` : ''}
          </div>
        </div>
      </div>`;
  }

  async function detailModal(type, id) {
    const item = (type === 'audio' ? State.tracks : State.videos).find((x) => x.id === id);
    if (!item) return;
    const m = el(`
      <div class="overlay">
        <div class="modal detail-modal">
          <button class="modal-close" data-close>&times;</button>
          <div class="detail-head">
            ${item.coverUrl || item.thumbUrl ? `<img class="detail-art" src="${esc(item.coverUrl || item.thumbUrl)}" />` : `<div class="detail-art">${type === 'audio' ? '♪' : '🎬'}</div>`}
            <div class="detail-info">
              <h3>${esc(item.title)}</h3>
              <div class="d-artist">${esc(item.artist)}${item.verified ? ' <span class="verified-badge">✔</span>' : ''} · ${esc(item.genre)} · ${fmtMoney(item.price)}</div>
              <div class="detail-actions">
                <button class="d-act ${item.likedByMe ? 'liked' : ''}" id="dLike">♥ <span id="dLikeCount">${fmtNum(item.likes)}</span></button>
                <button class="d-act" id="dPlay">▶ ${type === 'audio' ? 'Écouter' : 'Regarder'}</button>
                ${item.owned ? '<span class="owned-pill">✓ Acheté</span>' : `<button class="d-act" id="dBuy">Acheter ${fmtNum(item.price)} K</button>`}
              </div>
            </div>
          </div>
          <div class="comments-head">💬 Commentaires (<span id="dCmtCount">${fmtNum(item.comments)}</span>)</div>
          ${State.user ? `
            <div class="comment-form">
              <textarea id="cmtInput" maxlength="500" placeholder="Laisse un commentaire…"></textarea>
              <div class="cf-row"><span class="cf-count" id="cmtCount">0 / 500</span><button class="btn btn-gold" id="cmtSend" style="padding:8px 18px">Publier</button></div>
            </div>` : `<p class="sub" style="text-align:left;margin-bottom:14px"><a style="color:var(--gold);cursor:pointer" id="cmtLogin">Connecte-toi</a> pour commenter.</p>`}
          <div class="comment-list" id="cmtList"><div class="empty" style="padding:20px">Chargement…</div></div>
        </div>
      </div>`);

    const canModerate = State.user?.role === 'admin';

    async function refreshComments() {
      try {
        const r = await api(`/comments?contentType=${type}&contentId=${id}`);
        const list = r.comments;
        m.querySelector('#dCmtCount').textContent = fmtNum(list.length);
        m.querySelector('#cmtList').innerHTML = list.length
          ? list.map((c) => commentHTML(c, canModerate)).join('')
          : '<div class="empty" style="padding:20px">Sois le premier à commenter 🎶</div>';
      } catch (e) { m.querySelector('#cmtList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }

    // Like
    m.querySelector('#dLike').onclick = async () => {
      if (!State.user) { closeModal(); loginModal(); return; }
      try {
        const r = await api('/like', { method: 'POST', body: { contentType: type, contentId: id } });
        item.likes = r.likes; item.likedByMe = r.liked;
        m.querySelector('#dLikeCount').textContent = fmtNum(r.likes);
        m.querySelector('#dLike').classList.toggle('liked', r.liked);
      } catch (e) { toast(e.message); }
    };
    // Play
    m.querySelector('#dPlay').onclick = () => { closeModal(); type === 'audio' ? playTrack(id) : playVideo(id); };
    // Buy
    const dBuy = m.querySelector('#dBuy');
    if (dBuy) dBuy.onclick = () => { closeModal(); buyContent(type, id); };
    // Login link
    const cmtLogin = m.querySelector('#cmtLogin');
    if (cmtLogin) cmtLogin.onclick = () => { closeModal(); loginModal(); };

    // Comment form
    const input = m.querySelector('#cmtInput');
    if (input) {
      input.oninput = () => { m.querySelector('#cmtCount').textContent = `${input.value.length} / 500`; };
      m.querySelector('#cmtSend').onclick = async () => {
        const body = input.value.trim();
        if (!body) return;
        try {
          await api('/comments', { method: 'POST', body: { contentType: type, contentId: id, body } });
          input.value = ''; m.querySelector('#cmtCount').textContent = '0 / 500';
          item.comments = (item.comments || 0) + 1;
          await refreshComments();
          toast('💬 Commentaire publié');
          // rafraîchit le compteur sur les cartes en arrière-plan
          loadData();
        } catch (e) { toast(e.message); }
      };
    }

    // Délégation report/delete dans la liste
    m.querySelector('#cmtList').addEventListener('click', async (e) => {
      const rep = e.target.closest('[data-creport]');
      const del = e.target.closest('[data-cdel]');
      if (rep) {
        try { await api(`/comments/${rep.dataset.creport}/report`, { method: 'POST' }); toast('Signalé — merci'); refreshComments(); }
        catch (er) { toast(er.message); }
      } else if (del) {
        if (!confirm('Supprimer ce commentaire ?')) return;
        try { await api(`/comments/${del.dataset.cdel}`, { method: 'DELETE' }); item.comments = Math.max(0, (item.comments || 1) - 1); refreshComments(); loadData(); }
        catch (er) { toast(er.message); }
      }
    });

    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) closeModal(); });
    $('#modalRoot').appendChild(m);
    refreshComments();
  }

  // ============================================================
  //  KORAWAVE BATTLE (INNOVATION_06)
  // ============================================================
  function battleCard(b) {
    const isEnded = b.status === 'ended';
    const pct1 = b.totalVotes ? Math.round(b.votes1 / b.totalVotes * 100) : 50;
    const pct2 = 100 - pct1;
    const win1 = isEnded && b.winnerId === b.artist1Id;
    const win2 = isEnded && b.winnerId === b.artist2Id;
    return `
      <div class="battle-card ${isEnded ? 'ended' : 'active'}" data-battle="${b.id}">
        <div class="bc-top">
          <span class="bc-tag ${isEnded ? '' : 'live'}">⚔️ ${isEnded ? 'TERMINÉ' : 'EN COURS'}</span>
          <span class="bc-theme">${esc(b.theme)}</span>
        </div>
        <div class="bc-arena">
          <div class="bc-fighter ${win1 ? 'winner' : ''}">
            <div class="bc-cover">${b.track1?.coverUrl ? `<img src="${esc(b.track1.coverUrl)}" />` : '<span class="ph">♪</span>'}</div>
            <div class="bc-name">${esc(b.artist1Name)}${b.artist1Verified ? ' <span class="verified-badge">✔</span>' : ''}${b.artist1Wins > 0 ? ' 🏆' : ''}</div>
            <div class="bc-track">${esc(b.track1?.title || '—')}</div>
            ${win1 ? '<div class="bc-winner-badge">🏆 Gagnant</div>' : ''}
            ${b.myVote === b.track1Id ? '<div class="bc-my-vote">✓ Mon vote</div>' : ''}
          </div>
          <div class="bc-vs">VS</div>
          <div class="bc-fighter ${win2 ? 'winner' : ''}">
            <div class="bc-cover">${b.track2?.coverUrl ? `<img src="${esc(b.track2.coverUrl)}" />` : '<span class="ph">♪</span>'}</div>
            <div class="bc-name">${esc(b.artist2Name)}${b.artist2Verified ? ' <span class="verified-badge">✔</span>' : ''}${b.artist2Wins > 0 ? ' 🏆' : ''}</div>
            <div class="bc-track">${esc(b.track2?.title || '—')}</div>
            ${win2 ? '<div class="bc-winner-badge">🏆 Gagnant</div>' : ''}
            ${b.myVote === b.track2Id ? '<div class="bc-my-vote">✓ Mon vote</div>' : ''}
          </div>
        </div>
        <div class="bc-bar">
          <div class="bc-bar-fill1" style="width:${pct1}%"></div>
          <div class="bc-bar-fill2" style="width:${pct2}%"></div>
        </div>
        <div class="bc-footer">
          <span class="bc-votes">${fmtNum(b.votes1)} vs ${fmtNum(b.votes2)} · ${fmtNum(b.totalVotes)} votes</span>
          ${isEnded ? `<span style="font-size:11px;color:var(--muted2)">Terminé</span>` : `<span class="bc-countdown" data-countdown="${b.endsAt}">${countdownText(b.endsAt)}</span>`}
        </div>
      </div>`;
  }

  // ============================================================
  //  FAN PACK (INNOVATION_03)
  // ============================================================
  const MOODS = [
    { id: 'joyeux',       label: 'Joyeux',       ic: '☀️',  genres: 'Afrobeats, Coupé-décalé' },
    { id: 'focus',        label: 'Focus',         ic: '🧘',  genres: 'Mode Griot, Jazz' },
    { id: 'melancolique', label: 'Mélancolique',  ic: '🌧️', genres: 'Reggae, Mandingue' },
    { id: 'fete',         label: 'Fête',          ic: '🎉',  genres: 'Afrobeats, Hip-hop' },
    { id: 'reveil',       label: 'Réveil',        ic: '🌅',  genres: 'Afrobeats, Reggae' },
    { id: 'sport',        label: 'Sport',         ic: '💪',  genres: 'Hip-hop, Afrobeats' },
    { id: 'nuit',         label: 'Nuit',          ic: '🌙',  genres: 'Jazz, Mode Griot' },
  ];

  function fanPackCard(fp) {
    const tracklist = fp.tracks.slice(0, 4).map((t) =>
      `<li>${esc(t.title)}</li>`
    ).join('');
    const more = fp.tracks.length > 4 ? `<li style="opacity:.5">+${fp.tracks.length - 4} titre(s)…</li>` : '';
    return `
      <div class="fp-card ${fp.isFan ? 'owned' : ''}" data-fanpack="${fp.id}">
        <div class="fp-head">
          <div class="fp-avatar">🎵</div>
          <div class="fp-meta">
            <div class="name">${esc(fp.artistName)}${fp.artistVerified ? ' <span class="verified-badge">✔</span>' : ''}</div>
            <div class="artist">${fp.trackCount} titre(s) inclus</div>
          </div>
        </div>
        <div class="fp-title">${esc(fp.title)}</div>
        ${fp.description ? `<div style="font-size:12.5px;color:var(--muted);line-height:1.5">${esc(fp.description)}</div>` : ''}
        <ul class="fp-tracks-list">${tracklist}${more}</ul>
        <div class="fp-price-row">
          <span class="fp-price-orig">${fmtNum(fp.originalPrice)} K</span>
          <span class="fp-price-new">${fmtNum(fp.price)} K</span>
          <span class="fp-discount">-${fp.discountPct}%</span>
        </div>
        ${fp.isFan
          ? `<div class="fp-badge">⭐ Fan Officiel de ${esc(fp.artistName)}</div>
             <button class="fp-btn owned-btn" disabled>✓ Déjà Fan Officiel</button>`
          : `<div class="fp-actions">
               <button class="fp-btn buy" data-buy-fp="${fp.id}">Devenir Fan Officiel · ${fmtNum(fp.price)} KOINS</button>
             </div>`}
      </div>`;
  }

  async function buyFanPack(packId) {
    if (!State.user) { toast('Connecte-toi pour acheter un Fan Pack'); return; }
    const fp = State.fanPacks.find((f) => f.id === packId);
    if (!fp) return;
    if (!confirm(`Acheter le Fan Pack « ${fp.title} » pour ${fmtNum(fp.price)} KOINS ?`)) return;
    try {
      const res = await api('/purchase-pack', { method: 'POST', body: JSON.stringify({ packId }) });
      syncBalance(res.balance);
      toast(`⭐ Tu es Fan Officiel de ${res.artistName} !`);
      await loadData();
      render();
    } catch (e) { toast(e.message); }
  }

  // ============================================================
  //  HUMEUR RADIO (INNOVATION_05)
  // ============================================================
  function moodModal() {
    const existing = document.getElementById('moodOverlay');
    if (existing) existing.remove();
    const overlay = el(`
      <div id="moodOverlay" class="mood-overlay">
        <div class="mood-box">
          <div class="mood-title">📻 Radio KORAWAVE</div>
          <div class="mood-sub">Choisis ton humeur — on lance une playlist qui te correspond.</div>
          <div class="mood-grid">
            ${MOODS.map((m) => `
              <div class="mood-card" data-mood="${m.id}">
                <div class="ic">${m.ic}</div>
                <div class="lbl">${m.label}</div>
                <div class="genres">${m.genres}</div>
              </div>`).join('')}
          </div>
          <button style="margin-top:18px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px" id="closeMood">✕ Annuler</button>
        </div>
      </div>`);
    overlay.addEventListener('click', (e) => {
      const card = e.target.closest('[data-mood]');
      if (card) { overlay.remove(); startRadio(card.dataset.mood); return; }
      if (e.target.id === 'closeMood' || e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  async function startRadio(moodId) {
    const mood = MOODS.find((m) => m.id === moodId) || MOODS[0];
    try {
      const res = await api(`/radio?mood=${encodeURIComponent(moodId)}`);
      const tracks = res.tracks || [];
      if (!tracks.length) { toast('Aucun titre pour cette humeur pour l\'instant.'); return; }
      State.radioMood = mood;
      State.queue = tracks;
      State.queueIndex = 0;
      loadCurrent(!canPlayFull());
      toast(`📻 Radio ${mood.label} lancée — ${tracks.length} titre(s)`);
      updateRadioBadge();
    } catch (e) { toast('Erreur radio : ' + e.message); }
  }

  function updateRadioBadge() {
    const playerLeft = document.querySelector('.player-left');
    if (!playerLeft) return;
    let badge = document.getElementById('radioBadge');
    if (State.radioMood) {
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'radioBadge';
        badge.className = 'radio-badge';
        playerLeft.appendChild(badge);
      }
      badge.innerHTML = `<span class="dot"></span> Radio ${State.radioMood.label}`;
    } else if (badge) {
      badge.remove();
    }
  }

  // ============================================================
  //  KORAWAVE EVENTS (INNOVATION_09)
  // ============================================================

  function fmtEventDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
      + ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function eventCard(ev) {
    const pct = ev.capacity > 0 ? Math.round((ev.ticketsSold / ev.capacity) * 100) : 0;
    const full = ev.spotsLeft === 0;
    return `
      <div class="ev-card" data-event="${ev.id}">
        ${ev.coverUrl
          ? `<img class="ev-cover" src="${esc(ev.coverUrl)}" alt="${esc(ev.title)}" />`
          : `<div class="ev-cover-ph">🎟️</div>`}
        <div class="ev-body">
          <div class="ev-date-badge">📅 ${fmtEventDate(ev.date)}</div>
          <div class="ev-title">${esc(ev.title)}</div>
          <div class="ev-artist">${esc(ev.artist)}</div>
          <div class="ev-venue">📍 ${esc(ev.venue)}</div>
          <div class="ev-footer">
            <span class="ev-price">${fmtNum(ev.price)} K</span>
            ${full
              ? `<span class="ev-tag full">Complet</span>`
              : ev.myTicket
                ? `<span class="ev-tag sold">✓ Mon billet</span>`
                : `<span class="ev-spots ${ev.spotsLeft < 10 ? 'low' : ''}">${fmtNum(ev.spotsLeft)} place(s)</span>`}
          </div>
        </div>
      </div>`;
  }

  async function viewEvents() {
    let data;
    try { data = await api('/events'); } catch (e) { return `<div class="empty">${esc(e.message)}</div>`; }
    const evs = data.events || [];
    const upcoming = evs.filter((e) => e.status === 'upcoming');
    const past = evs.filter((e) => e.status !== 'upcoming');
    return `
      <div class="dash-head">
        <h1>KORAWAVE <span>Events</span> 🎟️</h1>
        <p>Concerts, soirées et lives — réserve ta place en KOINS.</p>
      </div>
      ${upcoming.length
        ? `<div class="sec-head"><h2>À venir</h2><span class="more">${upcoming.length} événement(s)</span></div>
           <div class="events-grid">${upcoming.map(eventCard).join('')}</div>`
        : `<div style="margin:40px 0">${emptyBlock('🎟️', "Aucun événement programmé. L'admin peut en créer depuis le Dashboard.")}</div>`}
      ${past.length ? `
        <div class="sec-head" style="margin-top:32px"><h2>Passés</h2></div>
        <div class="events-grid">${past.map(eventCard).join('')}</div>` : ''}`;
  }

  async function eventDetailModal(id) {
    let ev;
    try { ev = (await api(`/events/${id}`)).event; } catch (e) { toast(e.message); return; }

    const pct = ev.capacity > 0 ? Math.round((ev.ticketsSold / ev.capacity) * 100) : 0;
    const full = ev.spotsLeft === 0;

    const m = el(`
      <div class="overlay">
        <div class="modal" style="max-width:540px">
          <button class="modal-close" data-close>&times;</button>
          ${ev.coverUrl
            ? `<img class="ev-modal-cover" src="${esc(ev.coverUrl)}" alt="${esc(ev.title)}" />`
            : `<div class="ev-modal-cover-ph">🎟️</div>`}
          <div class="ev-modal-title">${esc(ev.title)}</div>
          <div class="ev-modal-meta">
            <div class="row"><span>🎤</span><span><strong>${esc(ev.artist)}</strong></span></div>
            <div class="row"><span>📅</span><span>${fmtEventDate(ev.date)}</span></div>
            <div class="row"><span>📍</span><span>${esc(ev.venue)}</span></div>
          </div>
          ${ev.description ? `<div class="ev-desc">${esc(ev.description)}</div>` : ''}
          <div class="ev-progress">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted)">
              <span>${fmtNum(ev.ticketsSold)} billets vendus</span>
              <span>${fmtNum(ev.spotsLeft)} place(s) / ${fmtNum(ev.capacity)}</span>
            </div>
            <div class="ev-progress-bar"><div class="ev-progress-fill" style="width:${pct}%"></div></div>
          </div>
          ${ev.myTicket
            ? `<div style="margin-bottom:14px">
                 <div style="text-align:center;font-size:13.5px;color:var(--muted);margin-bottom:12px">Ton billet — présente ce QR code à l'entrée</div>
                 <div class="ticket-display">
                   <div class="ticket-qr-wrap" id="qrContainer"></div>
                   <div class="ticket-info-row">
                     <div class="ticket-status-badge ${ev.myTicket.status}">${ev.myTicket.status === 'used' ? '✓ Utilisé' : '✓ Valide'}</div>
                     <div class="tid" style="margin-top:6px">${esc(ev.myTicket.id.slice(0, 16))}…</div>
                   </div>
                 </div>
               </div>`
            : full
              ? `<button class="ev-buy-btn" disabled>Complet</button>`
              : State.user
                ? `<button class="ev-buy-btn" id="evBuyBtn">🎟️ Réserver — ${fmtNum(ev.price)} KOINS</button>`
                : `<button class="ev-buy-btn" id="evLoginFirst">Connecte-toi pour réserver</button>`}
        </div>
      </div>`);

    m.querySelector('[data-close]').addEventListener('click', closeModal);
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
    $('#modalRoot').appendChild(m);

    // QR code si ticket
    if (ev.myTicket) {
      await loadQRLib();
      const container = document.getElementById('qrContainer');
      if (container) new QRCode(container, { text: ev.myTicket.qrCode, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
    }

    // Bouton achat
    const buyBtn = document.getElementById('evBuyBtn');
    if (buyBtn) {
      buyBtn.addEventListener('click', async () => {
        if (!confirm(`Acheter 1 billet pour « ${ev.title} » — ${fmtNum(ev.price)} KOINS ?`)) return;
        buyBtn.disabled = true; buyBtn.textContent = 'Réservation…';
        try {
          const res = await api('/purchase-ticket', { method: 'POST', body: { eventId: ev.id } });
          syncBalance(res.balance);
          toast('🎟️ Billet réservé ! Présente le QR à l\'entrée.');
          closeModal();
          eventDetailModal(ev.id);
        } catch (e) { toast(e.message); buyBtn.disabled = false; buyBtn.textContent = `🎟️ Réserver — ${fmtNum(ev.price)} KOINS`; }
      });
    }

    const loginBtn = document.getElementById('evLoginFirst');
    if (loginBtn) loginBtn.addEventListener('click', () => { closeModal(); loginModal(); });
  }

  function loadQRLib() {
    return new Promise((resolve) => {
      if (window.QRCode) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = resolve;
      document.head.appendChild(s);
    });
  }

  function loadChartJS() {
    return new Promise((resolve) => {
      if (window.Chart) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
      s.onload = resolve;
      document.head.appendChild(s);
    });
  }

  // Stocke les instances Chart.js pour pouvoir les détruire avant recréation
  const _charts = {};

  function destroyChart(id) { if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; } }

  function mkChart(id, config) {
    destroyChart(id);
    const canvas = document.getElementById(id);
    if (!canvas) return;
    _charts[id] = new Chart(canvas, config);
  }

  function trendLabel(pct) {
    if (pct === null || pct === undefined) return '';
    const cls = pct >= 0 ? 'up' : 'down';
    const sym = pct >= 0 ? '▲' : '▼';
    return `<span class="an-stat-trend ${cls}">${sym} ${Math.abs(pct)}% vs période préc.</span>`;
  }

  async function mountAnalytics(type) {
    const panelId = type === 'admin' ? 'adminAnalyticsPanel' : 'artistAnalyticsPanel';
    const panel = document.getElementById(panelId);
    if (!panel) return;

    // Période active
    let period = 7;
    panel.querySelector('.ptab.active')?.dataset?.anperiod && (period = parseInt(panel.querySelector('.ptab.active').dataset.anperiod));

    const host = document.getElementById('analyticsContent');
    if (host) host.innerHTML = '<div class="empty" style="padding:40px 0">Chargement…</div>';

    // Toggle période
    panel.querySelectorAll('[data-anperiod]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        panel.querySelectorAll('[data-anperiod]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        mountAnalytics(type);
      };
    });

    let data;
    try {
      const endpoint = type === 'admin' ? `/admin/analytics?period=${period}` : `/artist/analytics?period=${period}`;
      data = await api(endpoint);
    } catch (e) {
      if (host) host.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }

    await loadChartJS();

    // Formatte les labels pour affichage court (ex: "15 juin")
    const shortLabels = data.labels.map((l) => {
      const d = new Date(l + 'T00:00:00');
      return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    });

    const GOLD = '#c9a84c';
    const GREEN = '#4ade80';
    const GRID = 'rgba(255,255,255,0.06)';
    const TICK = 'rgba(255,255,255,0.45)';

    const lineConfig = (labels, values, color, label) => ({
      type: 'line',
      data: {
        labels,
        datasets: [{
          label,
          data: values,
          borderColor: color,
          backgroundColor: color + '22',
          borderWidth: 2,
          pointRadius: values.length > 14 ? 0 : 3,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: TICK, maxTicksLimit: 7, font: { size: 11 } }, grid: { color: GRID } },
          y: { ticks: { color: TICK, font: { size: 11 } }, grid: { color: GRID }, beginAtZero: true },
        },
      },
    });

    const barConfig = (labels, values, color, label) => ({
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label,
          data: values,
          backgroundColor: color + 'bb',
          borderColor: color,
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: TICK, maxTicksLimit: 7, font: { size: 11 } }, grid: { color: GRID } },
          y: { ticks: { color: TICK, font: { size: 11 } }, grid: { color: GRID }, beginAtZero: true },
        },
      },
    });

    if (type === 'admin') {
      const maxPlays = Math.max(...data.plays, 1);
      const topHTML = data.topTracks.map((t, i) => `
        <div class="an-top-item">
          <div class="an-top-rank ${i === 0 ? 'gold' : ''}">${i + 1}</div>
          <div class="an-top-info">
            <div class="an-top-track">${esc(t.title)}</div>
            <div class="an-top-artist">${esc(t.artist)}</div>
          </div>
          <div class="an-bar-wrap"><div class="an-bar-fill" style="width:${Math.round(t.plays / maxPlays * 100)}%"></div></div>
          <div class="an-top-plays">${fmtNum(t.plays)} ▶</div>
        </div>`).join('');

      host.innerHTML = `
        <div class="an-stat-row">
          <div class="an-stat">
            <div class="an-stat-val">${fmtMoney(data.periodRevenue)}</div>
            <div class="an-stat-lab">Revenus ${data.days}j</div>
            ${trendLabel(data.revenueTrend)}
          </div>
          <div class="an-stat">
            <div class="an-stat-val">${fmtNum(data.totalPlays)}</div>
            <div class="an-stat-lab">Écoutes totales</div>
          </div>
          <div class="an-stat">
            <div class="an-stat-val">${data.conversionRate}%</div>
            <div class="an-stat-lab">Taux de conversion</div>
            <span class="an-stat-trend neutral">${fmtNum(data.totalUsers)} utilisateurs</span>
          </div>
          <div class="an-stat">
            <div class="an-stat-val">${fmtMoney(data.revenueProjection30)}</div>
            <div class="an-stat-lab">Projection 30j</div>
            <span class="an-stat-trend neutral">basée sur ${data.days}j</span>
          </div>
        </div>
        <div class="an-chart-grid">
          <div class="an-chart-box">
            <div class="an-chart-title">Revenus (KOINS)</div>
            <canvas id="chartRevenue"></canvas>
          </div>
          <div class="an-chart-box">
            <div class="an-chart-title">Écoutes par jour</div>
            <canvas id="chartPlays"></canvas>
          </div>
        </div>
        ${data.topTracks.length ? `
        <div class="an-top-list">
          <div class="an-top-title">Top titres — toutes périodes</div>
          ${topHTML}
        </div>` : ''}`;

      mkChart('chartRevenue', lineConfig(shortLabels, data.revenue, GOLD, 'Revenus'));
      mkChart('chartPlays', barConfig(shortLabels, data.plays, GREEN, 'Écoutes'));

    } else {
      // Artist analytics
      const maxPlays = Math.max(...(data.topTracks || []).map((t) => t.plays), 1);
      const topHTML = (data.topTracks || []).map((t, i) => `
        <div class="an-top-item">
          <div class="an-top-rank ${i === 0 ? 'gold' : ''}">${i + 1}</div>
          <div class="an-top-info"><div class="an-top-track">${esc(t.title)}</div></div>
          <div class="an-bar-wrap"><div class="an-bar-fill" style="width:${Math.round(t.plays / maxPlays * 100)}%"></div></div>
          <div class="an-top-plays">${fmtNum(t.plays)} ▶</div>
        </div>`).join('');

      host.innerHTML = `
        <div class="an-stat-row">
          <div class="an-stat">
            <div class="an-stat-val">${fmtNum(data.periodPlays)}</div>
            <div class="an-stat-lab">Écoutes ${data.days}j</div>
            ${trendLabel(data.playsTrend)}
          </div>
          <div class="an-stat">
            <div class="an-stat-val">${fmtNum(data.totalPlays)}</div>
            <div class="an-stat-lab">Écoutes totales</div>
          </div>
          <div class="an-stat">
            <div class="an-stat-val">${fmtMoney(data.totalRevenue)}</div>
            <div class="an-stat-lab">Revenus totaux (50%)</div>
          </div>
          <div class="an-stat">
            <div class="an-stat-val">${fmtNum(data.fans)}</div>
            <div class="an-stat-lab">Fans (likes)</div>
          </div>
        </div>
        <div class="an-chart-grid">
          <div class="an-chart-box">
            <div class="an-chart-title">Écoutes par jour</div>
            <canvas id="chartPlays"></canvas>
          </div>
          <div class="an-chart-box">
            <div class="an-chart-title">Revenus (KOINS)</div>
            <canvas id="chartRevenue"></canvas>
          </div>
        </div>
        ${topHTML ? `
        <div class="an-top-list">
          <div class="an-top-title">Mes titres — classement</div>
          ${topHTML}
        </div>` : ''}`;

      mkChart('chartPlays', barConfig(shortLabels, data.plays, GOLD, 'Écoutes'));
      mkChart('chartRevenue', lineConfig(shortLabels, data.revenue, GREEN, 'Revenus'));
    }
  }

  async function viewBattle() {
    let data;
    try { data = await api('/battles'); }
    catch (e) { return `<div class="empty">${esc(e.message)}</div>`; }
    const battles = data.battles || [];
    State.battles = battles;
    const active = battles.filter((b) => b.status === 'active');
    const ended = battles.filter((b) => b.status === 'ended');
    return `
      <div class="dash-head">
        <h1>KORAWAVE <span>Battle</span> ⚔️</h1>
        <p>Duels d'artistes guinéens — 72h de vote, 1 vote par compte. Vote pour débloquer l'écoute complète !</p>
      </div>
      ${active.length ? `
        <div class="sec-head"><h2>Battles <span>en cours</span></h2><span class="more">${active.length} duel(s) actif(s)</span></div>
        <div class="battle-grid">${active.map(battleCard).join('')}</div>` : ''}
      ${ended.length ? `
        <div class="sec-head" style="margin-top:28px"><h2>Battles <span>terminés</span></h2></div>
        <div class="battle-grid">${ended.slice(0, 6).map(battleCard).join('')}</div>` : ''}
      ${!battles.length ? emptyBlock('⚔️', "Aucun battle pour l'instant. Reviens bientôt !") : ''}`;
  }

  async function battleDetailModal(id) {
    let data;
    try { data = await api('/battles/' + id); }
    catch (e) { toast(e.message); return; }
    const b = data.battle;
    const isEnded = b.status === 'ended';
    const pct1 = b.totalVotes ? Math.round(b.votes1 / b.totalVotes * 100) : 50;
    const pct2 = 100 - pct1;
    const win1 = isEnded && b.winnerId === b.artist1Id;
    const win2 = isEnded && b.winnerId === b.artist2Id;

    const fighterHTML = (side, artistName, verified, wins, track, myVote, isWinner, trackId) => `
      <div class="bm-fighter ${isWinner ? 'winner' : ''}" id="bmF${side}">
        <div class="bm-cover">
          ${track?.coverUrl ? `<img src="${esc(track.coverUrl)}" />` : '<span class="ph">♪</span>'}
          ${!isEnded && !b.hasVoted ? '<div class="bm-lock">🔒</div>' : ''}
        </div>
        <div class="bm-artist">${esc(artistName)}${verified ? ' <span class="verified-badge">✔</span>' : ''}${wins > 0 ? ' 🏆' : ''}</div>
        <div class="bm-track">${esc(track?.title || '—')}</div>
        <div class="bm-votes-count">${fmtNum(side === 1 ? b.votes1 : b.votes2)} vote(s)</div>
        ${myVote === trackId ? '<div class="bm-voted-tag">✓ Mon vote</div>' : ''}
        ${isWinner ? '<div class="bm-win-badge">🏆 Gagnant du Battle</div>' : ''}
        ${(b.hasVoted || isEnded) && track?.audioUrl ? `<button class="btn btn-outline bm-play-btn" id="bmPlay${side}" data-url="${esc(track.audioUrl)}">▶ Écouter</button>` : ''}
        ${!isEnded && !b.hasVoted ? `<button class="btn btn-gold btn-block bm-vote-btn" id="bmVote${side}" data-trackid="${trackId}">
          ${State.user ? '🗳️ Voter pour ce titre' : '🔑 Connexion pour voter'}
        </button>` : ''}
      </div>`;

    const shareUrl = location.origin + '/#battle-' + b.id;
    const m = el(`
      <div class="overlay">
        <div class="modal battle-modal">
          <button class="modal-close" data-close>&times;</button>
          <div class="bm-header">
            <div class="bm-logo">⚔️ KORAWAVE Battle</div>
            <h2>${esc(b.theme)}</h2>
            ${!isEnded
              ? `<div class="bm-countdown">Vote en cours · <span data-countdown="${b.endsAt}">${countdownText(b.endsAt)}</span></div>`
              : '<div class="bm-countdown ended">Battle terminé</div>'}
          </div>
          <div class="bm-arena">
            ${fighterHTML(1, b.artist1Name, b.artist1Verified, b.artist1Wins, b.track1, b.myVote, win1, b.track1Id)}
            <div class="bm-vs">VS</div>
            ${fighterHTML(2, b.artist2Name, b.artist2Verified, b.artist2Wins, b.track2, b.myVote, win2, b.track2Id)}
          </div>
          <div class="bm-bar-wrap">
            <div class="bm-bar">
              <div class="bm-bar-f1" style="width:${pct1}%"></div>
              <div class="bm-bar-f2" style="width:${pct2}%"></div>
            </div>
            <div class="bm-bar-labels">
              <span style="color:var(--red)">${pct1}% — ${fmtNum(b.votes1)}</span>
              <span>${fmtNum(b.totalVotes)} votes au total</span>
              <span style="color:var(--gold)">${fmtNum(b.votes2)} — ${pct2}%</span>
            </div>
          </div>
          ${!b.hasVoted && !isEnded ? `<p class="bm-hint">${State.user
            ? '👆 Vote pour un titre pour débloquer l\'écoute complète des 2 titres en entier.'
            : '🎶 <a style="color:var(--gold);cursor:pointer" id="bmLoginLink">Connecte-toi</a> pour voter et écouter les deux titres.'
          }</p>` : ''}
          ${b.hasVoted && !isEnded ? '<p class="bm-hint" style="color:var(--green)">✓ Tu as voté — les deux titres sont déverrouillés pour toi !</p>' : ''}
          <div class="bm-share">
            <span class="sub">Partager :</span>
            ${socialButtons(shareUrl, `⚔️ Vote pour le KORAWAVE Battle « ${b.theme} » !`)}
          </div>
        </div>
      </div>`);

    let aud1 = null, aud2 = null;

    function stopAll() {
      if (aud1 && !aud1.paused) { aud1.pause(); m.querySelector('#bmPlay1') && (m.querySelector('#bmPlay1').textContent = '▶ Écouter'); }
      if (aud2 && !aud2.paused) { aud2.pause(); m.querySelector('#bmPlay2') && (m.querySelector('#bmPlay2').textContent = '▶ Écouter'); }
    }

    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.dataset.close !== undefined) { stopAll(); closeModal(); }
    });

    m.querySelector('#bmLoginLink')?.addEventListener('click', () => { stopAll(); closeModal(); loginModal(); });

    async function doVote(trackId) {
      if (!State.user) { stopAll(); closeModal(); loginModal(); return; }
      const btn = m.querySelector(`[data-trackid="${trackId}"]`);
      if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
      try {
        await api('/battles/' + id + '/vote', { method: 'POST', body: { trackId } });
        toast('🗳️ Vote enregistré — écoute déverrouillée !');
        stopAll(); closeModal();
        await loadData();
        battleDetailModal(id);
      } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = '🗳️ Voter pour ce titre'; }
        toast(err.message);
      }
    }

    m.querySelector('#bmVote1')?.addEventListener('click', () => doVote(b.track1Id));
    m.querySelector('#bmVote2')?.addEventListener('click', () => doVote(b.track2Id));

    function setupPlayer(btnId, getAud, setAud, url) {
      const btn = m.querySelector('#' + btnId);
      if (!btn) return;
      const a = new Audio(url);
      setAud(a);
      btn.addEventListener('click', () => {
        const other = btnId === 'bmPlay1' ? aud2 : aud1;
        const otherBtn = m.querySelector(btnId === 'bmPlay1' ? '#bmPlay2' : '#bmPlay1');
        if (other && !other.paused) { other.pause(); if (otherBtn) otherBtn.textContent = '▶ Écouter'; }
        if (a.paused) { a.play().catch(() => {}); btn.textContent = '⏸ En cours…'; }
        else { a.pause(); btn.textContent = '▶ Écouter'; }
        a.onended = () => { btn.textContent = '▶ Écouter'; };
      });
    }

    if (b.track1?.audioUrl) setupPlayer('bmPlay1', () => aud1, (a) => { aud1 = a; }, b.track1.audioUrl);
    if (b.track2?.audioUrl) setupPlayer('bmPlay2', () => aud2, (a) => { aud2 = a; }, b.track2.audioUrl);

    $('#modalRoot').appendChild(m);
  }

  // ============================================================
  //  NOTIFICATIONS (cloche)
  // ============================================================
  async function loadNotifications() {
    if (!State.user) { State.notif = { notifications: [], unread: 0 }; renderBell(); return; }
    try { State.notif = await api('/notifications'); } catch (e) { State.notif = { notifications: [], unread: 0 }; }
    renderBell();
  }
  function renderBell() {
    const badge = $('#bellBadge');
    if (!badge) return;
    const n = State.notif.unread || 0;
    badge.textContent = n > 9 ? '9+' : n;
    badge.classList.toggle('hidden', n === 0);
  }
  async function toggleBellPanel() {
    const panel = $('#bellPanel');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    const list = State.notif.notifications || [];
    const notifIcon = (type) => type === 'like' ? '❤️' : type === 'battle_vote' ? '⚔️' : type === 'battle_win' ? '🏆' : type === 'battle_invite' ? '⚔️' : type === 'fan_pack' ? '⭐' : '💬';
    const notifText = (n) => {
      if (n.type === 'like') return `<b>${esc(n.actorName)}</b> a aimé « ${esc(n.contentTitle)} »`;
      if (n.type === 'battle_vote') return `<b>${esc(n.actorName)}</b> ${esc(n.body)} « ${esc(n.contentTitle)} »`;
      if (n.type === 'battle_win') return `🏆 KORAWAVE Battle : ${esc(n.body)}`;
      if (n.type === 'battle_invite') return `⚔️ ${esc(n.body)}`;
      if (n.type === 'fan_pack') return `⭐ <b>${esc(n.actorName)}</b> ${esc(n.body)}`;
      return `<b>${esc(n.actorName)}</b> a commenté « ${esc(n.contentTitle)} »${n.body ? ` : « ${esc(n.body)} »` : ''}`;
    };
    panel.innerHTML = `<div class="bp-head">Notifications</div>` + (list.length
      ? list.map((n) => `
        <div class="notif ${n.read ? '' : 'unread'}" data-ntype="${n.contentType}" data-nid="${n.contentId}">
          <div class="n-ic">${notifIcon(n.type)}</div>
          <div><div class="n-txt">${notifText(n)}</div><div class="n-date">${fmtDateTime(n.createdAt)}</div></div>
        </div>`).join('')
      : '<div class="empty" style="padding:24px">Aucune notification.</div>');
    panel.classList.remove('hidden');
    // marque comme lues
    if (State.notif.unread > 0) {
      try { await api('/notifications/read', { method: 'POST' }); } catch (e) {}
      State.notif.notifications.forEach((n) => (n.read = true));
      State.notif.unread = 0; renderBell();
    }
  }

  async function adminCloseBattle(id) {
    if (!confirm('Clôturer ce battle et désigner le gagnant ?')) return;
    try {
      await api('/admin/battles/' + id + '/close', { method: 'POST' });
      toast('⚔️ Battle clôturé');
      await loadData(); render();
    } catch (e) { toast(e.message); }
  }

  // ---------- DASHBOARD ADMIN ----------
  let dashSubtab = 'audio';
  let adminTab = 'apercu'; // 'apercu' | 'finance' | 'contenu' | 'users' | 'artistes' | 'battle' | 'events'
  let uploadMode = 'admin'; // 'admin' | 'artist' — détermine les endpoints d'upload

  async function viewDashboard() {
    uploadMode = 'admin';
    let stats = null, artistsData = { artists: [] }, modData = { comments: [] }, battlesData = { battles: [] };
    try {
      [stats, artistsData, modData, battlesData] = await Promise.all([
        api('/admin/stats'), api('/admin/artists'), api('/admin/comments'),
        api('/battles').catch(() => ({ battles: [] })),
      ]);
    } catch (e) { return `<div class="empty">${esc(e.message)}</div>`; }

    const repart = (label, val, pct, color) => `
      <div class="repart-item">
        <div class="rr"><span class="rl">${label} (${pct}%)</span><span class="rv">${fmtMoney(val)}</span></div>
        <div class="bar"><div style="width:${pct}%;background:${color}"></div></div>
      </div>`;

    const TABS = [
      { id: 'apercu', label: '📊 Aperçu' },
      { id: 'finance', label: '💶 Finance' },
      { id: 'contenu', label: '🎵 Contenu' },
      { id: 'users', label: '👥 Utilisateurs' },
      { id: 'artistes', label: '🎤 Artistes' },
      { id: 'battle', label: '⚔️ Battle' },
      { id: 'events', label: '🎟️ Events' },
    ];

    const tabContent = () => {
      if (adminTab === 'apercu') return `
        <div class="an-panel" id="adminAnalyticsPanel">
          <div class="an-head">
            <h3>📊 Analytiques</h3>
            <div class="period-tabs">
              <button class="ptab active" data-anperiod="7">7 jours</button>
              <button class="ptab" data-anperiod="30">30 jours</button>
            </div>
          </div>
          <div id="analyticsContent"><div class="empty" style="padding:40px 0">Chargement…</div></div>
        </div>
        <div class="panel" style="margin-top:20px">
          <h3>💵 Répartition des revenus</h3>
          <div class="repart">
            ${repart('Artiste / Label', stats.artistShare, 50, 'var(--green)')}
            ${repart('KORAWAVE', stats.korawaveShare, 40, 'var(--gold)')}
            ${repart('Ministère de la Culture', stats.ministryShare, 10, 'var(--red)')}
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px">
            <div class="stat" style="padding:14px"><div class="lab" style="font-size:12px">💳 Achats</div><div class="val" style="font-size:20px">${fmtNum(stats.sales)}</div></div>
            <div class="stat" style="padding:14px"><div class="lab" style="font-size:12px">💰 Ventes</div><div class="val gold" style="font-size:20px">${fmtMoney(stats.salesRevenue)}</div></div>
            <div class="stat" style="padding:14px"><div class="lab" style="font-size:12px">💝 Tips</div><div class="val gold" style="font-size:20px">${fmtMoney(stats.tipsTotal)}</div></div>
          </div>
        </div>`;

      if (adminTab === 'finance') return `<div class="panel" id="financePanel"><div class="empty" style="padding:40px">Chargement des données financières…</div></div>`;

      if (adminTab === 'contenu') return `
        <div class="dash-grid">
          <div class="panel" id="uploadPanel">
            <div class="subtabs">
              <button class="subtab ${dashSubtab==='audio'?'active':''}" data-sub="audio">🎵 Ajouter un audio</button>
              <button class="subtab ${dashSubtab==='video'?'active':''}" data-sub="video">🎬 Ajouter une vidéo</button>
            </div>
            <div id="uploadForms"></div>
          </div>
          <div class="panel">
            <h3>📚 Gérer le catalogue</h3>
            <div class="subtabs">
              <button class="subtab manage-sub active" data-msub="audio">Audios (${stats.tracks})</button>
              <button class="subtab manage-sub" data-msub="video">Vidéos (${stats.videos})</button>
            </div>
            <div class="manage-list" id="manageList"></div>
          </div>
        </div>
        <div class="panel" style="margin-top:20px">
          <h3>🛡️ Modération — commentaires signalés ${modData.comments.length ? `<span class="badge badge-red">${modData.comments.length}</span>` : ''}</h3>
          <div class="manage-list" style="max-height:none">
            ${modData.comments.length ? modData.comments.map((c) => `
              <div class="manage-item" data-modcid="${c.id}">
                <div class="mi-ph">💬</div>
                <div class="mi-info">
                  <div class="t">${esc(c.author)} <span class="flag-tag">${fmtNum(c.reports)} signalement(s)</span></div>
                  <div class="s">« ${esc(c.body)} » · sur ${esc(c.contentTitle)}</div>
                </div>
                <button class="btn btn-outline" style="padding:7px 12px" data-mod="restore:${c.id}">Restaurer</button>
                <button class="btn btn-gold" style="padding:7px 12px" data-mod="delete:${c.id}">Supprimer</button>
              </div>`).join('') : '<div class="empty" style="padding:24px">Aucun commentaire signalé. 🎉</div>'}
          </div>
        </div>`;

      if (adminTab === 'users') return `<div class="panel" id="usersPanel"><div class="empty" style="padding:40px">Chargement des utilisateurs…</div></div>`;

      if (adminTab === 'artistes') return `
        <div class="panel">
          <h3>🎤 Artistes — vérification</h3>
          <div class="manage-list" style="max-height:none">
            ${artistsData.artists.length ? artistsData.artists.map((a) => `
              <div class="manage-item">
                <div class="mi-ph">${esc(initial(a.artistName || a.name))}</div>
                <div class="mi-info">
                  <div class="t">${esc(a.artistName || a.name)} ${a.verified ? '<span class="verified-badge">✔</span>' : ''}</div>
                  <div class="s">${fmtNum(a.tracks)} titre(s) · ${fmtNum(a.videos)} vidéo(s) · ${esc(a.phone || a.email || '')}</div>
                </div>
                <button class="btn ${a.verified ? 'btn-outline' : 'btn-gold'}" style="padding:7px 14px" data-verify="${a.id}">
                  ${a.verified ? 'Retirer ✔' : 'Vérifier ✔'}
                </button>
              </div>`).join('') : '<div class="empty" style="padding:24px">Aucun artiste inscrit pour le moment.</div>'}
          </div>
        </div>`;

      if (adminTab === 'battle') return `
        <div class="panel" id="battleAdminPanel">
          <h3>⚔️ KORAWAVE Battle — créer un duel</h3>
          <form id="battleCreateForm" style="margin-top:14px">
            <div class="field">
              <label>Thème du battle</label>
              <input class="input" name="theme" placeholder="Ex : Conakry Sound Battle — Sons de la rue" required />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div class="field">
                <label>Titre 1 — Artiste A</label>
                <select class="input" name="track1Id" required>
                  <option value="">— Choisir —</option>
                  ${State.tracks.map((t) => `<option value="${esc(t.id)}">${esc(t.title)} — ${esc(t.artist)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label>Titre 2 — Artiste B</label>
                <select class="input" name="track2Id" required>
                  <option value="">— Choisir —</option>
                  ${State.tracks.map((t) => `<option value="${esc(t.id)}">${esc(t.title)} — ${esc(t.artist)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="field">
              <label>Durée (heures — défaut 72h)</label>
              <input class="input" name="durationHours" type="number" min="1" max="168" value="72" />
            </div>
            <button class="btn btn-gold" type="submit">⚔️ Lancer le Battle</button>
            <div class="form-error" id="battleCreateErr"></div>
          </form>
          ${battlesData.battles.length ? `
          <div class="battle-list" style="margin-top:20px">
            <h3>Battles en cours / récents</h3>
            ${battlesData.battles.slice(0, 8).map((b) => `
              <div class="ba-item">
                <div class="ba-ic">⚔️</div>
                <div class="ba-info">
                  <div class="t">${esc(b.theme)}</div>
                  <div class="s">${fmtNum(b.totalVotes)} vote(s) · ${b.status === 'ended' ? '✓ Terminé — gagnant : ' + (b.winnerId === b.artist1Id ? esc(b.artist1Name) : b.winnerId === b.artist2Id ? esc(b.artist2Name) : 'Égalité') : `fin <span data-countdown="${b.endsAt}">${countdownText(b.endsAt)}</span>`}</div>
                </div>
                ${b.status === 'active' ? `<button class="btn btn-outline" style="padding:6px 12px;font-size:12px" data-close-battle="${b.id}">Clôturer</button>` : `<span class="pill ok" style="font-size:11px">Terminé</span>`}
              </div>`).join('')}
          </div>` : ''}
        </div>`;

      if (adminTab === 'events') return `
        <div class="panel" id="eventsAdminPanel">
          <h3>🎟️ KORAWAVE Events — créer un événement</h3>
          <form class="ev-admin-form" id="evCreateForm" style="margin-top:14px">
            <div class="field"><label>Titre de l'événement</label><input class="input" name="evTitle" placeholder="Soirée KORAWAVE — Conakry" required /></div>
            <div class="field"><label>Artiste / Organisateur</label><input class="input" name="evArtist" placeholder="DJ Sekou, KORAWAVE…" /></div>
            <div class="row2">
              <div class="field"><label>Lieu</label><input class="input" name="evVenue" placeholder="Palais du Peuple, Conakry" required /></div>
              <div class="field"><label>Date & heure</label><input class="input" type="datetime-local" name="evDate" required /></div>
            </div>
            <div class="row2">
              <div class="field"><label>Prix (KOINS)</label><input class="input" name="evPrice" type="number" value="2000" min="0" required /></div>
              <div class="field"><label>Capacité (places)</label><input class="input" name="evCapacity" type="number" value="200" min="1" required /></div>
            </div>
            <div class="field"><label>Description</label><textarea class="input" name="evDesc" rows="2" placeholder="Détails de l'événement…" style="resize:vertical"></textarea></div>
            <button class="btn btn-gold" type="submit">🎟️ Créer l'événement</button>
            <div class="form-error" id="evCreateErr"></div>
          </form>
          <div class="ev-admin-list" id="evAdminList"></div>
        </div>`;

      return '';
    };

    return `
      <div class="dash-head">
        <h1>Tableau de <span>bord</span></h1>
        <p>Gestion KORAWAVE · ${fmtNum(stats.users)} membres · ${fmtNum(stats.artists || 0)} artistes · ${fmtNum(stats.tracks)} titres</p>
      </div>

      <div class="stats-grid">
        <div class="stat"><div class="ic">👥</div><div class="lab">Membres</div><div class="val">${fmtNum(stats.users)}</div></div>
        <div class="stat"><div class="ic">🎤</div><div class="lab">Artistes</div><div class="val gold">${fmtNum(stats.artists || 0)}</div></div>
        <div class="stat"><div class="ic">🎵</div><div class="lab">Titres audio</div><div class="val gold">${fmtNum(stats.tracks)}</div></div>
        <div class="stat"><div class="ic">🎬</div><div class="lab">Vidéos</div><div class="val gold">${fmtNum(stats.videos)}</div></div>
        <div class="stat"><div class="ic">▶️</div><div class="lab">Écoutes</div><div class="val">${fmtNum(stats.totalPlays)}</div></div>
        <div class="stat"><div class="ic">💰</div><div class="lab">Revenu estimé</div><div class="val gold">${fmtMoney(stats.revenue)}</div></div>
      </div>

      <div class="admin-tabs">
        ${TABS.map((tab) => `<button class="atab ${adminTab === tab.id ? 'active' : ''}" data-admintab="${tab.id}">${tab.label}</button>`).join('')}
      </div>

      <div id="adminTabContent">
        ${tabContent()}
      </div>
    `;
  }

  function mountBattleAdmin() {
    const form = $('#battleCreateForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const errEl = $('#battleCreateErr');
      errEl.textContent = '';
      const theme = f.theme.value.trim();
      const track1Id = f.track1Id.value;
      const track2Id = f.track2Id.value;
      const durationHours = f.durationHours.value;
      if (!theme || !track1Id || !track2Id) { errEl.textContent = 'Tous les champs sont requis.'; return; }
      if (track1Id === track2Id) { errEl.textContent = 'Choisis deux titres différents.'; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; btn.textContent = 'Création…';
      try {
        await api('/admin/battles', { method: 'POST', body: { theme, track1Id, track2Id, durationHours } });
        toast('⚔️ Battle lancé !');
        await loadData(); render();
      } catch (err) { errEl.textContent = err.message; btn.disabled = false; btn.textContent = '⚔️ Lancer le Battle'; }
    });
  }

  function mountEventsAdmin() {
    const form = document.getElementById('evCreateForm');
    if (!form) return;

    async function refreshEvList() {
      const list = document.getElementById('evAdminList');
      if (!list) return;
      try {
        const data = await api('/events');
        const evs = data.events || [];
        list.innerHTML = evs.length
          ? evs.map((ev) => `
              <div class="ev-admin-item">
                <div class="ev-ai-info">
                  <div class="t">${esc(ev.title)}</div>
                  <div class="s">${fmtEventDate(ev.date)} · ${esc(ev.venue)} · ${fmtNum(ev.ticketsSold)}/${fmtNum(ev.capacity)} billets · ${fmtNum(ev.price)} K</div>
                </div>
                <button class="ev-del" data-del-ev="${ev.id}">Supprimer</button>
              </div>`).join('')
          : '<div style="font-size:12px;color:var(--muted);padding:10px 0">Aucun événement.</div>';
        list.querySelectorAll('[data-del-ev]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            if (!confirm('Supprimer cet événement ?')) return;
            try {
              await api(`/admin/events/${btn.dataset.delEv}`, { method: 'DELETE' });
              toast('Événement supprimé');
              refreshEvList();
            } catch (e) { toast(e.message); }
          });
        });
      } catch (e) { console.error(e); }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const errEl = document.getElementById('evCreateErr');
      errEl.textContent = '';
      const fd = new FormData();
      fd.append('title', f.evTitle.value.trim());
      fd.append('artist', f.evArtist.value.trim() || 'KORAWAVE');
      fd.append('venue', f.evVenue.value.trim());
      fd.append('date', f.evDate.value);
      fd.append('price', f.evPrice.value);
      fd.append('capacity', f.evCapacity.value);
      fd.append('description', f.evDesc.value.trim());
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true; btn.textContent = 'Création…';
      try {
        await api('/admin/events', { method: 'POST', form: fd });
        toast('🎟️ Événement créé !');
        f.reset(); btn.disabled = false; btn.textContent = '🎟️ Créer l\'événement';
        refreshEvList();
      } catch (err) { errEl.textContent = err.message; btn.disabled = false; btn.textContent = '🎟️ Créer l\'événement'; }
    });

    refreshEvList();
  }

  async function mountFinanceAdmin() {
    const panel = document.getElementById('financePanel');
    if (!panel) return;
    let period = 30;

    const load = async () => {
      panel.innerHTML = '<div class="empty" style="padding:40px">Chargement…</div>';
      try {
        const f = await api('/admin/finance?period=' + period);
        const pctBar = (pct, color) => `<div class="fin-pct-bar"><div style="width:${pct}%;background:${color}"></div></div>`;
        panel.innerHTML = `
          <div class="fin-head">
            <h3>💶 Statistiques financières</h3>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <div class="period-tabs">
                ${[7, 30, 90, 365].map((d) => `<button class="ptab ${period===d?'active':''}" data-finperiod="${d}">${d===365?'1 an':d+'j'}</button>`).join('')}
              </div>
              <a class="btn btn-outline btn-sm csv-dl" href="/api/admin/export/finance.csv?period=${period}" download>⬇ CSV Transactions</a>
            </div>
          </div>
          <div class="fin-stats">
            <div class="fin-card">
              <div class="fc-label">Revenu total</div>
              <div class="fc-val gold">${fmtMoney(f.totalRevenue)}</div>
              <div class="fc-sub">${fmtNum(f.totalPurchases)} transaction(s)</div>
            </div>
            <div class="fin-card">
              <div class="fc-label">Achats catalogue</div>
              <div class="fc-val">${fmtMoney(f.purchaseRevenue)}</div>
              <div class="fc-sub">Titres & Vidéos</div>
            </div>
            <div class="fin-card">
              <div class="fc-label">Pourboires (Tips)</div>
              <div class="fc-val">${fmtMoney(f.tipRevenue)}</div>
              <div class="fc-sub">Tip Jar artistes</div>
            </div>
            <div class="fin-card">
              <div class="fc-label">KOINS rechargés</div>
              <div class="fc-val">${fmtMoney(f.koinsRecharged)}</div>
              <div class="fc-sub">Via Mobile Money</div>
            </div>
          </div>
          <div class="fin-split">
            <div class="fs-item"><div class="fs-dot" style="background:var(--green)"></div><div class="fs-body"><div class="fs-label">Artistes / Labels (50%)</div>${pctBar(50,'var(--green)')}</div><div class="fs-val green">${fmtMoney(f.artistShare)}</div></div>
            <div class="fs-item"><div class="fs-dot" style="background:var(--gold)"></div><div class="fs-body"><div class="fs-label">KORAWAVE (40%)</div>${pctBar(40,'var(--gold)')}</div><div class="fs-val gold">${fmtMoney(f.korawaveShare)}</div></div>
            <div class="fs-item"><div class="fs-dot" style="background:var(--red)"></div><div class="fs-body"><div class="fs-label">Ministère de la Culture (10%)</div>${pctBar(10,'var(--red)')}</div><div class="fs-val red">${fmtMoney(f.ministryShare)}</div></div>
          </div>
          <div class="fin-tables">
            <div class="fin-table-wrap">
              <h4>Top artistes — revenus</h4>
              ${f.topArtists.length ? `<table class="fin-table"><thead><tr><th>#</th><th>Artiste</th><th>Part (50%)</th></tr></thead><tbody>
                ${f.topArtists.map((a, i) => `<tr><td class="gold">${i+1}</td><td>${esc(a.name)}</td><td>${fmtMoney(a.earned)}</td></tr>`).join('')}
              </tbody></table>` : '<div class="empty" style="padding:20px">Aucune donnée</div>'}
            </div>
            <div class="fin-table-wrap">
              <h4>Revenus par genre</h4>
              ${f.topGenres.length ? `<table class="fin-table"><thead><tr><th>Genre</th><th>Revenus</th></tr></thead><tbody>
                ${f.topGenres.map((g) => `<tr><td>${esc(g.genre)}</td><td>${fmtMoney(g.revenue)}</td></tr>`).join('')}
              </tbody></table>` : '<div class="empty" style="padding:20px">Aucune donnée</div>'}
            </div>
          </div>
          <div class="fin-history">
            <h4>Historique (${fmtNum(f.transactions.length)} transactions)</h4>
            <div class="fin-txn-list">
              ${f.transactions.length ? f.transactions.map((t) => `
                <div class="fin-txn">
                  <span class="fin-txn-type ${t.type==='achat'?'type-buy':'type-tip'}">${t.type==='achat'?'🛒':'💝'} ${t.type}</span>
                  <span class="fin-txn-user">${esc(t.user)}</span>
                  <span class="fin-txn-item">${esc(t.item)}</span>
                  <span class="fin-txn-date">${t.createdAt?t.createdAt.slice(0,10):'—'}</span>
                  <span class="fin-txn-amount gold">${fmtMoney(t.amount)}</span>
                </div>`).join('') : '<div class="empty" style="padding:20px">Aucune transaction sur cette période.</div>'}
            </div>
          </div>
        `;
        panel.querySelectorAll('[data-finperiod]').forEach((btn) => {
          btn.addEventListener('click', () => { period = parseInt(btn.dataset.finperiod); load(); });
        });
      } catch (err) {
        panel.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      }
    };

    await load();
  }

  async function mountUsersAdmin() {
    const panel = document.getElementById('usersPanel');
    if (!panel) return;
    try {
      const { users } = await api('/admin/users');
      let roleFilter = 'all';

      const renderTable = () => {
        const filtered = roleFilter === 'all' ? users : users.filter((u) => u.role === roleFilter);
        const countByRole = (r) => users.filter((u) => u.role === r).length;
        panel.innerHTML = `
          <div class="user-filters">
            ${[['all','Tous',users.length],['user','Membres',countByRole('user')],['artist','Artistes',countByRole('artist')],['admin','Admins',countByRole('admin')]].map(([id,label,n]) => `
              <button class="subtab ${roleFilter===id?'active':''}" data-ufilt="${id}">${label} (${n})</button>`).join('')}
            <a class="btn btn-outline btn-sm csv-dl" href="/api/admin/export/users.csv" download style="margin-left:auto">⬇ CSV Utilisateurs</a>
            <a class="btn btn-outline btn-sm csv-dl" href="/api/admin/export/catalogue.csv" download>⬇ CSV Catalogue</a>
          </div>
          <div class="users-table">
            ${filtered.length ? filtered.map((u) => `
              <div class="user-row ${u.banned ? 'user-banned' : ''}">
                <div class="ur-avatar">${esc(initial(u.artistName || u.name))}</div>
                <div class="ur-info">
                  <div class="ur-name">${esc(u.artistName || u.name)} <span class="role-badge rb-${u.role}">${u.role}</span>${u.verified ? ' <span class="verified-badge">✔</span>' : ''}${u.banned ? ' <span class="pill" style="background:var(--red-dim);color:var(--red);font-size:10px">Banni</span>' : ''}</div>
                  <div class="ur-meta">${esc(u.phone || u.email || '—')} · ${u.tracks} titre(s) · ${fmtNum(u.koins)} KOINS</div>
                </div>
                ${u.role !== 'admin' ? `
                  <select class="input ur-role-sel" style="width:auto;padding:5px 8px;font-size:12px" data-uid="${u.id}" data-current-role="${u.role}">
                    <option value="user" ${u.role==='user'?'selected':''}>Membre</option>
                    <option value="artist" ${u.role==='artist'?'selected':''}>Artiste</option>
                  </select>
                  <button class="btn ${u.banned?'btn-gold':'btn-outline'} btn-sm" style="padding:5px 12px;font-size:12px" data-ban-uid="${u.id}" data-ban-state="${u.banned?'1':'0'}">${u.banned?'Débannir':'Bannir'}</button>
                ` : '<span style="color:var(--muted);font-size:12px;padding:0 8px">Admin</span>'}
              </div>`).join('') : '<div class="empty" style="padding:24px">Aucun utilisateur trouvé.</div>'}
          </div>
        `;

        panel.querySelectorAll('[data-ufilt]').forEach((btn) => {
          btn.addEventListener('click', () => { roleFilter = btn.dataset.ufilt; renderTable(); });
        });

        panel.querySelectorAll('[data-uid]').forEach((sel) => {
          sel.addEventListener('change', async () => {
            const u = users.find((x) => x.id === sel.dataset.uid);
            if (!u) return;
            const oldRole = u.role;
            try {
              await api('/admin/users/' + u.id, { method: 'PATCH', body: { role: sel.value } });
              u.role = sel.value;
              toast('Rôle mis à jour : ' + sel.value);
              renderTable();
            } catch (err) { toast(err.message); sel.value = oldRole; }
          });
        });

        panel.querySelectorAll('[data-ban-uid]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const u = users.find((x) => x.id === btn.dataset.banUid);
            if (!u) return;
            const newBanned = btn.dataset.banState === '0';
            try {
              await api('/admin/users/' + u.id, { method: 'PATCH', body: { banned: newBanned } });
              u.banned = newBanned;
              toast(newBanned ? 'Utilisateur banni' : 'Utilisateur restauré');
              renderTable();
            } catch (err) { toast(err.message); }
          });
        });
      };

      renderTable();
    } catch (e) {
      panel.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function mountFanPackAdmin() {
    const form = document.getElementById('fpForm');
    if (!form) return;

    async function refreshFpList() {
      const list = document.getElementById('fpPacksList');
      if (!list) return;
      try {
        const data = await api('/fan-packs');
        const myPacks = (data.packs || []).filter((fp) => State.user && fp.artistId === State.user.id);
        list.innerHTML = myPacks.length
          ? myPacks.map((fp) => `
              <div class="fp-admin-item">
                <div class="title">${esc(fp.title)}</div>
                <div class="count">${fp.trackCount} titres · -${fp.discountPct}% · ${fmtNum(fp.price)} K</div>
                <button class="del-fp" data-del-fp="${fp.id}">Supprimer</button>
              </div>`).join('')
          : '<div style="font-size:12px;color:var(--muted);padding:10px 0">Aucun pack actif.</div>';
        list.querySelectorAll('[data-del-fp]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            if (!confirm('Supprimer ce Fan Pack ?')) return;
            try {
              await api(`/artist/fan-packs/${btn.dataset.delFp}`, { method: 'DELETE' });
              toast('Fan Pack supprimé');
              await loadData();
              refreshFpList();
            } catch (e) { toast(e.message); }
          });
        });
      } catch (e) { console.error(e); }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const state = document.getElementById('fpState');
      state.textContent = '';
      const title = f.fpTitle.value.trim();
      const description = f.fpDesc.value.trim();
      const trackIds = [...form.querySelectorAll('input[name="fpTrack"]:checked')].map((cb) => cb.value);
      const discountPct = f.fpDiscount.value;
      if (trackIds.length < 2) { state.textContent = 'Sélectionne au moins 2 titres.'; state.style.color = '#f87171'; return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true; btn.textContent = 'Création…';
      try {
        await api('/artist/fan-packs', { method: 'POST', body: { title, description, trackIds, discountPct: parseInt(discountPct, 10) } });
        toast('🎁 Fan Pack créé !');
        f.reset(); btn.disabled = false; btn.textContent = '🎁 Créer le Fan Pack';
        state.textContent = '✓ Pack créé avec succès !'; state.style.color = '#4ade80';
        await loadData();
        refreshFpList();
      } catch (err) { state.textContent = err.message; state.style.color = '#f87171'; btn.disabled = false; btn.textContent = '🎁 Créer le Fan Pack'; }
    });

    refreshFpList();
  }

  async function moderateComment(action, id) {
    try {
      await api(`/admin/comments/${id}/moderate`, { method: 'POST', body: { action } });
      toast(action === 'delete' ? 'Commentaire supprimé' : 'Commentaire restauré');
      render();
    } catch (e) { toast(e.message); }
  }

  // ---------- ESPACE ARTISTE ----------
  async function viewArtist() {
    uploadMode = 'artist';
    let stats = null, content = { tracks: [], videos: [] };
    try {
      [stats, content] = await Promise.all([api('/artist/stats'), api('/artist/content')]);
    } catch (e) { return `<div class="empty">${esc(e.message)}</div>`; }
    State._artistContent = content;

    const topRows = stats.topTracks.length
      ? stats.topTracks.map((t, i) => `
        <div class="top-row">
          <div class="rank">${i + 1}</div>
          <div class="tr-art">${t.coverUrl ? `<img class="tr-art" src="${esc(t.coverUrl)}" />` : '♪'}</div>
          <div class="tr-t">${esc(t.title)}</div>
          <div class="tr-p">${fmtNum(t.plays)} ▶</div>
        </div>`).join('')
      : '<div class="empty" style="padding:20px">Pas encore de titre.</div>';

    return `
      <div class="artist-banner">
        <div class="ab-avatar">${esc(initial(stats.artistName))}</div>
        <div style="flex:1">
          <h1>${esc(stats.artistName)} ${stats.verified ? '<span class="verified-badge">✔</span>' : ''}</h1>
          <div class="ab-sub">Espace artiste KORAWAVE · ${fmtNum(stats.fans)} fan(s)</div>
        </div>
        <span class="pill ${stats.verified ? 'ok' : 'pending'}">${stats.verified ? 'Artiste vérifié' : 'Vérification en attente'}</span>
      </div>

      <div class="stats-grid">
        <div class="stat"><div class="ic">▶️</div><div class="lab">Écoutes totales</div><div class="val gold">${fmtNum(stats.totalPlays)}</div></div>
        <div class="stat"><div class="ic">🎵</div><div class="lab">Mes titres</div><div class="val">${fmtNum(stats.tracks)}</div></div>
        <div class="stat"><div class="ic">🎬</div><div class="lab">Mes vidéos</div><div class="val">${fmtNum(stats.videos)}</div></div>
        <div class="stat"><div class="ic">❤️</div><div class="lab">Fans</div><div class="val">${fmtNum(stats.fans)}</div></div>
        <div class="stat"><div class="ic">💰</div><div class="lab">Mes revenus (50%)</div><div class="val gold">${fmtMoney(stats.artistRevenue)}</div></div>
      </div>

      <div class="an-panel" id="artistAnalyticsPanel">
        <div class="an-head">
          <h3>📊 Mes statistiques</h3>
          <div class="period-tabs">
            <button class="ptab active" data-anperiod="7">7 jours</button>
            <button class="ptab" data-anperiod="30">30 jours</button>
          </div>
        </div>
        <div id="analyticsContent"><div class="empty" style="padding:40px 0">Chargement…</div></div>
      </div>

      <div class="dash-grid">
        <div class="panel" id="uploadPanel">
          <h3>＋ Publier un contenu</h3>
          <div class="subtabs">
            <button class="subtab ${dashSubtab==='audio'?'active':''}" data-sub="audio">🎵 Mon audio</button>
            <button class="subtab ${dashSubtab==='video'?'active':''}" data-sub="video">🎬 Mon clip</button>
          </div>
          <div id="uploadForms"></div>

          <div class="fp-admin-panel">
            <h3 style="margin-bottom:14px">🎁 Mes Fan Packs</h3>
            <form class="fp-form" id="fpForm">
              <div class="field"><label>Nom du pack</label><input class="input" name="fpTitle" placeholder="Ex : Pack Essentiel 2025" required /></div>
              <div class="field"><label>Description <span style="color:var(--muted2)">(optionnel)</span></label><input class="input" name="fpDesc" placeholder="Une courte accroche pour tes fans…" /></div>
              <div class="field">
                <label>Titres à inclure <span style="color:var(--muted2)">(min. 2)</span></label>
                <div class="fp-track-checks" id="fpTrackChecks">
                  ${content.tracks.length
                    ? content.tracks.map((t) => `
                        <label class="fp-track-check">
                          <input type="checkbox" name="fpTrack" value="${esc(t.id)}" />
                          ${esc(t.title)}
                        </label>`).join('')
                    : '<span style="font-size:12px;color:var(--muted)">Publie d\'abord des titres pour créer un pack.</span>'}
                </div>
              </div>
              <div class="field"><label>Réduction (%)</label>
                <select class="input" name="fpDiscount">
                  <option value="15">15% de réduction</option>
                  <option value="20" selected>20% de réduction</option>
                  <option value="25">25% de réduction</option>
                  <option value="30">30% de réduction</option>
                </select>
              </div>
              <button class="btn btn-gold btn-block" type="submit" ${content.tracks.length < 2 ? 'disabled' : ''}>🎁 Créer le Fan Pack</button>
              <div class="submit-state" id="fpState"></div>
            </form>
            <div class="fp-packs-list" id="fpPacksList"></div>
          </div>
        </div>

        <div class="panel">
          <h3>🏆 Mes titres les plus écoutés</h3>
          <div class="top-list">${topRows}</div>
          <h3 style="margin-top:26px">📚 Mon catalogue</h3>
          <div class="subtabs">
            <button class="subtab manage-sub active" data-msub="audio">Audios (${stats.tracks})</button>
            <button class="subtab manage-sub" data-msub="video">Vidéos (${stats.videos})</button>
          </div>
          <div class="manage-list" id="manageList"></div>
        </div>
      </div>`;
  }

  function audioForm() {
    return `
      <form id="audioForm">
        <div id="coverPrevWrap" style="text-align:center"></div>
        <label class="upload-zone" id="coverZone">
          <div class="uz-ic">🖼️</div>
          <div>Image de couverture (pochette)</div>
          <div style="font-size:12px;color:var(--muted2)">JPG / PNG — clique ou glisse</div>
          <div class="uz-name" id="coverName"></div>
          <input type="file" name="cover" accept="image/*" hidden />
        </label>
        <label class="upload-zone" id="audioZone">
          <div class="uz-ic">🎵</div>
          <div>Fichier audio</div>
          <div style="font-size:12px;color:var(--muted2)">MP3 / WAV / M4A — clique ou glisse</div>
          <div class="uz-name" id="audioName"></div>
          <input type="file" name="audio" accept="audio/*" hidden required />
        </label>
        <div class="field"><label>Titre</label><input class="input" name="title" placeholder="Nom du titre" required /></div>
        ${uploadMode === 'artist' ? '' : `<div class="field"><label>Artiste</label><input class="input" name="artist" placeholder="Nom de l'artiste" required /></div>`}
        <div class="row2">
          <div class="field"><label>Genre</label>
            <select class="input" name="genre">${GENRES.map((g) => `<option>${g}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Prix (GNF)</label><input class="input" name="price" type="number" value="500" min="0" /></div>
        </div>
        <div class="field">
          <label>📅 Date de sortie <span style="color:var(--muted2)">(optionnel — laisse vide pour publier maintenant)</span></label>
          <input class="input" name="releaseAt" type="datetime-local" />
        </div>
        <button class="btn btn-gold btn-block" type="submit">＋ Publier l'audio</button>
        <div class="submit-state" id="audioState"></div>
      </form>`;
  }

  function videoForm() {
    return `
      <form id="videoFormEl">
        <label class="upload-zone" id="videoZone">
          <div class="uz-ic">🎬</div>
          <div>Fichier vidéo</div>
          <div style="font-size:12px;color:var(--muted2)">MP4 / WEBM / MOV — clique ou glisse</div>
          <div class="uz-name" id="videoName"></div>
          <input type="file" name="video" accept="video/*" hidden required />
        </label>
        <label class="upload-zone" id="thumbZone">
          <div class="uz-ic">🖼️</div>
          <div>Miniature <span style="color:var(--muted2)">(optionnel)</span></div>
          <div style="font-size:12px;color:var(--muted2)">Image d'aperçu du clip</div>
          <div class="uz-name" id="thumbName"></div>
          <input type="file" name="thumb" accept="image/*" hidden />
        </label>
        <div class="field"><label>Titre</label><input class="input" name="title" placeholder="Nom du clip" required /></div>
        ${uploadMode === 'artist' ? '' : `<div class="field"><label>Artiste</label><input class="input" name="artist" placeholder="Nom de l'artiste" required /></div>`}
        <div class="row2">
          <div class="field"><label>Genre</label>
            <select class="input" name="genre">${GENRES.map((g) => `<option>${g}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Prix (GNF)</label><input class="input" name="price" type="number" value="1000" min="0" /></div>
        </div>
        <div class="field">
          <label>📅 Date de sortie <span style="color:var(--muted2)">(optionnel — laisse vide pour publier maintenant)</span></label>
          <input class="input" name="releaseAt" type="datetime-local" />
        </div>
        <button class="btn btn-gold btn-block" type="submit">＋ Publier la vidéo</button>
        <div class="submit-state" id="videoState"></div>
      </form>`;
  }

  function bindUploadZone(zoneId, inputName, onPick) {
    const zone = $('#' + zoneId);
    if (!zone) return;
    const input = zone.querySelector('input');
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('drag');
      if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; onPick(input.files[0]); }
    });
    input.addEventListener('change', () => { if (input.files[0]) onPick(input.files[0]); });
  }

  function mountUploadForms() {
    const host = $('#uploadForms');
    if (!host) return;
    if (dashSubtab === 'audio') {
      host.innerHTML = audioForm();
      bindUploadZone('coverZone', 'cover', (file) => {
        $('#coverName').textContent = file.name;
        const url = URL.createObjectURL(file);
        $('#coverPrevWrap').innerHTML = `<img class="cover-preview" src="${url}" alt="" />`;
      });
      bindUploadZone('audioZone', 'audio', (file) => { $('#audioName').textContent = file.name; });
      $('#audioForm').addEventListener('submit', submitAudio);
    } else {
      host.innerHTML = videoForm();
      bindUploadZone('videoZone', 'video', (file) => { $('#videoName').textContent = file.name; });
      bindUploadZone('thumbZone', 'thumb', (file) => { $('#thumbName').textContent = file.name; });
      $('#videoFormEl').addEventListener('submit', submitVideo);
    }
  }

  async function submitAudio(e) {
    e.preventDefault();
    const form = e.target;
    const state = $('#audioState');
    if (!form.audio.files[0]) { state.className = 'submit-state err'; state.textContent = 'Sélectionne un fichier audio.'; return; }
    const fd = new FormData(form);
    state.className = 'submit-state'; state.textContent = 'Téléversement en cours…';
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      await api(`/${uploadMode}/tracks`, { method: 'POST', form: fd });
      state.className = 'submit-state ok'; state.textContent = '✓ Audio publié !';
      toast('🎵 Audio ajouté au catalogue');
      await loadData(); render();
    } catch (err) { state.className = 'submit-state err'; state.textContent = err.message; btn.disabled = false; }
  }

  async function submitVideo(e) {
    e.preventDefault();
    const form = e.target;
    const state = $('#videoState');
    if (!form.video.files[0]) { state.className = 'submit-state err'; state.textContent = 'Sélectionne un fichier vidéo.'; return; }
    const fd = new FormData(form);
    state.className = 'submit-state'; state.textContent = 'Téléversement en cours…';
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      await api(`/${uploadMode}/videos`, { method: 'POST', form: fd });
      state.className = 'submit-state ok'; state.textContent = '✓ Vidéo publiée !';
      toast('🎬 Vidéo ajoutée au catalogue');
      await loadData(); render();
    } catch (err) { state.className = 'submit-state err'; state.textContent = err.message; btn.disabled = false; }
  }

  let manageSub = 'audio';
  function mountManageList(source) {
    const host = $('#manageList');
    if (!host) return;
    const src = source || (uploadMode === 'artist' ? (State._artistContent || { tracks: [], videos: [] }) : State);
    const items = manageSub === 'audio' ? src.tracks : src.videos;
    if (!items.length) { host.innerHTML = `<div class="empty" style="padding:24px">Catalogue vide.</div>`; return; }
    const isArtist = uploadMode === 'artist';
    const verified = isArtist && State.user?.verified;
    host.innerHTML = items.map((it) => {
      const img = manageSub === 'audio'
        ? (it.coverUrl ? `<img src="${esc(it.coverUrl)}" />` : `<div class="mi-ph">♪</div>`)
        : (it.thumbUrl ? `<img src="${esc(it.thumbUrl)}" />` : `<div class="mi-ph">🎬</div>`);
      const scheduled = it.releaseAt && new Date(it.releaseAt) > Date.now();
      const sub = scheduled
        ? `<span class="card-soon">⏳ Sortie le ${fmtDateTime(it.releaseAt)}</span>`
        : `${esc(it.artist)} · ${fmtMoney(it.price)} · ${fmtNum(it.plays)} ▶`;
      const canShare = verified && manageSub === 'audio' && !scheduled;
      const canEdit = uploadMode === 'admin';
      return `
        <div class="manage-item">
          ${img}
          <div class="mi-info"><div class="t">${esc(it.title)}${it.shareEnabled ? ' <span class="verified-badge" title="Partagé">↗</span>' : ''}</div><div class="s">${sub}</div></div>
          ${canShare ? `<button class="mi-share" data-share="${it.id}" title="Partager un extrait 30s">↗</button>` : ''}
          ${canEdit ? `<button class="mi-edit" data-edit-content="${manageSub}:${it.id}" title="Modifier">✏️</button>` : ''}
          <button class="mi-del" data-del="${it.id}" data-deltype="${manageSub}" data-delmode="${uploadMode}" title="Supprimer">🗑</button>
        </div>`;
    }).join('');
  }

  function mountFingerprintAdmin() {
    const tracks = State.tracks || [];
    const withFp = tracks.filter((t) => t.fingerprint).length;
    const without = tracks.filter((t) => !t.fingerprint && t.audioUrl);
    const container = $('#manageList');
    if (!container) return;
    const banner = el(`<div class="fp-admin-banner">
      <span>🎤 Empreintes audio : <strong>${withFp}/${tracks.length}</strong> titres indexés</span>
      ${without.length ? `<button class="btn btn-outline btn-sm" id="fpComputeBtn">Indexer ${without.length} titre(s) manquant(s)</button>` : '<span class="pill" style="background:var(--gold-dim);color:var(--gold)">✓ Tout est indexé</span>'}
    </div>`);
    container.parentElement?.insertBefore(banner, container);

    banner.querySelector('#fpComputeBtn')?.addEventListener('click', async function () {
      this.disabled = true;
      this.textContent = 'Calcul en cours…';
      let done = 0;
      for (const track of without) {
        try {
          const bits = await computeAndSendFingerprint(track.id, track.audioUrl);
          done++;
          this.textContent = `${done}/${without.length} indexé(s)…`;
          toast(`✓ ${track.title} indexé (${bits} bits)`);
        } catch (e) {
          toast(`Erreur sur "${track.title}" : ` + e.message);
        }
      }
      this.textContent = `✓ ${done} indexé(s)`;
      await loadData();
    });
  }

  function editContentModal(type, id) {
    const items = type === 'audio' ? State.tracks : State.videos;
    const item = items.find((x) => x.id === id);
    if (!item) return;
    const GENRES = ['Mandingue','Afrobeats','Hip-hop','Reggae','Mode Griot','Jazz','Mamaya','Faré-Gnakhi','Coupé-décalé','Gospel','Blues','Autre'];
    const m = el(`<div class="overlay">
      <div class="modal">
        <button class="modal-close" data-close>&times;</button>
        <div class="modal-tag">✏️ Modifier le ${type === 'audio' ? 'titre' : 'clip'}</div>
        <h3>${esc(item.title)}</h3>
        <form id="editContentForm" style="margin-top:16px">
          <div class="field"><label>Titre</label><input class="input" name="title" value="${esc(item.title)}" required /></div>
          <div class="field"><label>Genre</label>
            <select class="input" name="genre">
              ${GENRES.map((g) => `<option value="${g}" ${item.genre===g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Prix (KOINS)</label><input class="input" name="price" type="number" min="0" value="${item.price || 0}" /></div>
          <div class="field"><label>Sortie programmée <span style="color:var(--muted2)">(vide = dès maintenant)</span></label><input class="input" type="datetime-local" name="releaseAt" value="${item.releaseAt ? item.releaseAt.slice(0,16) : ''}" /></div>
          <button class="btn btn-gold btn-block" type="submit">Enregistrer</button>
          <div class="form-error" id="editContentErr"></div>
        </form>
      </div>
    </div>`);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) closeModal(); });
    m.querySelector('#editContentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const endpoint = type === 'audio' ? `/admin/tracks/${id}` : `/admin/videos/${id}`;
      const btn = f.querySelector('[type=submit]');
      btn.disabled = true; btn.textContent = 'Enregistrement…';
      try {
        await api(endpoint, { method: 'PATCH', body: {
          title: f.title.value.trim(),
          genre: f.genre.value,
          price: parseInt(f.price.value) || 0,
          releaseAt: f.releaseAt.value || null,
        }});
        toast('✅ Modifié avec succès');
        closeModal();
        await loadData(); mountManageList();
      } catch (err) {
        document.getElementById('editContentErr').textContent = err.message;
        btn.disabled = false; btn.textContent = 'Enregistrer';
      }
    });
    $('#modalRoot').appendChild(m);
  }

  async function deleteItem(type, id, mode) {
    if (!confirm('Supprimer définitivement cet élément ?')) return;
    try {
      await api(`/${mode || 'admin'}/${type === 'audio' ? 'tracks' : 'videos'}/${id}`, { method: 'DELETE' });
      toast('Élément supprimé');
      await loadData(); render();
    } catch (e) { toast(e.message); }
  }

  async function verifyArtist(id) {
    try {
      const r = await api(`/admin/artists/${id}/verify`, { method: 'POST' });
      toast(r.verified ? 'Artiste vérifié ✔' : 'Vérification retirée');
      await loadData(); render();
    } catch (e) { toast(e.message); }
  }

  // ============================================================
  //  RENDU PRINCIPAL
  // ============================================================
  async function render() {
    const c = $('#content');
    switch (State.view) {
      case 'search': c.innerHTML = await viewSearch(); break;
      case 'artistPage': c.innerHTML = await viewArtistPublic(); mountArtistPage(); break;
      case 'playlists': c.innerHTML = await viewPlaylists(); mountPlaylistsView(); break;
      case 'playlistDetail': c.innerHTML = await viewPlaylistDetail(); mountPlaylistDetail(); break;
      case 'messages': c.innerHTML = await viewMessages(); mountMessagesView(); break;
      case 'thread': c.innerHTML = await viewThread(); mountThread(); break;
      case 'music': c.innerHTML = viewMusic(); break;
      case 'videos': c.innerHTML = viewVideos(); break;
      case 'griot': c.innerHTML = viewGriot(); break;
      case 'dashboard':
        if (!State.user || State.user.role !== 'admin') { State.view = 'home'; c.innerHTML = viewHome(); mountSliders(); break; }
        c.innerHTML = await viewDashboard();
        if (adminTab === 'apercu') mountAnalytics('admin');
        if (adminTab === 'contenu') { mountUploadForms(); mountManageList(); mountFingerprintAdmin(); }
        if (adminTab === 'battle') mountBattleAdmin();
        if (adminTab === 'events') mountEventsAdmin();
        if (adminTab === 'finance') mountFinanceAdmin();
        if (adminTab === 'users') mountUsersAdmin();
        break;
      case 'artist':
        if (!State.user || State.user.role !== 'artist') { State.view = 'home'; c.innerHTML = viewHome(); mountSliders(); break; }
        c.innerHTML = await viewArtist();
        mountUploadForms(); mountManageList(State._artistContent); mountFanPackAdmin(); mountAnalytics('artist');
        break;
      case 'wallet':
        if (!State.user) { State.view = 'home'; c.innerHTML = viewHome(); mountSliders(); break; }
        c.innerHTML = await viewWallet();
        document.getElementById('pushToggleBtn')?.addEventListener('click', async (e) => {
          const active = e.currentTarget.dataset.pushActive === '1';
          if (active) await unsubscribePush(); else await subscribePush();
        });
        document.getElementById('pushTestBtn')?.addEventListener('click', () => api('/push/test', { method: 'POST' }).then(() => toast('Notification de test envoyée !')).catch((err) => toast(err.message)));
        break;
      case 'battle':
        c.innerHTML = await viewBattle();
        break;
      case 'events':
        c.innerHTML = await viewEvents();
        break;
      default: c.innerHTML = viewHome(); mountSliders();
    }
    c.scrollTo?.(0, 0);
    $('#main').scrollTop = 0;
  }

  // ============================================================
  //  LECTEUR AUDIO
  // ============================================================
  const audio = $('#audioEl');

  // Membre connecté = streaming complet gratuit (sans téléchargement, CLAUDE.md).
  // Invité = aperçu 10s.
  const canPlayFull = () => !!State.user;

  function playTrack(id, forcePreview) {
    const target = State.tracks.find((t) => t.id === id);
    if (target && target.released === false) {
      toast('🔒 Disponible le ' + fmtDateTime(target.releaseAt));
      return;
    }
    const all = (filteredTracks().length ? filteredTracks() : State.tracks).filter((t) => t.released !== false);
    const idx = all.findIndex((t) => t.id === id);
    if (idx < 0) return;
    State.queue = all; State.queueIndex = idx;
    loadCurrent(forcePreview || !canPlayFull());
  }

  // Aperçu 10s explicite (pilule « 10s »), disponible pour tout le monde
  function previewTrack(id) { playTrack(id, true); }

  function loadCurrent(preview) {
    const t = State.queue[State.queueIndex];
    if (!t) return;
    hidePreviewBanner();
    State.current = t;
    State.previewMode = !!preview;
    State.previewStart = 0;
    State.previewItem = preview ? { type: 'audio', id: t.id } : null;
    audio.src = t.audioUrl;
    audio.play().catch(() => {});
    $('#playBtn').textContent = '⏸';
    $('#npTitleText').textContent = t.title;
    $('#npArtist').textContent = t.artist;
    $('#npArt').innerHTML = t.coverUrl ? `<img src="${esc(t.coverUrl)}" />` : '<span class="ph">♪</span>';
    $('#npPreview').classList.toggle('hidden', !preview);
    $('#progress').classList.toggle('preview', !!preview);
    // Pourboire : visible si le titre appartient à un artiste (≠ contenu admin) et que je suis connecté
    $('#npTip').style.display = (State.user && t.ownerId && t.ownerId !== State.user.id) ? 'block' : 'none';
    updateLikeBtn();
    api(`/tracks/${t.id}/play`, { method: 'POST' }).then((r) => { t.plays = r.plays; }).catch(() => {});
  }

  // Calcule le départ de l'aperçu (refrain ~ sec 30 si le titre est assez long)
  audio.addEventListener('loadedmetadata', () => {
    if (State.previewMode) {
      State.previewStart = audio.duration > 40 ? 30 : 0;
      try { audio.currentTime = State.previewStart; } catch (e) {}
    }
  });

  function endPreview() {
    audio.pause();
    $('#playBtn').textContent = '▶';
    showPreviewBanner();
  }
  function showPreviewBanner() {
    $('#previewMsg').textContent = State.user
      ? 'Aperçu de 10 secondes terminé.'
      : 'Aperçu de 10s terminé — connecte-toi pour écouter en entier.';
    $('#previewUnlock').textContent = State.user ? 'Écouter en entier' : 'Se connecter';
    $('#previewBanner').classList.remove('hidden');
  }
  function hidePreviewBanner() { $('#previewBanner').classList.add('hidden'); }

  function unlockFull() {
    const item = State.previewItem;
    hidePreviewBanner();
    if (!State.user) { loginModal(); return; }
    if (item && item.type === 'video') { playVideo(item.id, false); return; }
    // audio : repasse en lecture complète depuis le début
    State.previewMode = false; State.previewItem = null;
    $('#npPreview').classList.add('hidden');
    $('#progress').classList.remove('preview');
    try { audio.currentTime = 0; } catch (e) {}
    audio.play(); $('#playBtn').textContent = '⏸';
  }

  function togglePlay() {
    if (!State.current) { if (State.tracks.length) playTrack(State.tracks[0].id); return; }
    if (audio.paused) {
      if (State.previewMode && audio.currentTime - State.previewStart >= PREVIEW_SECS - 0.05) {
        try { audio.currentTime = State.previewStart; } catch (e) {}
        hidePreviewBanner();
      }
      audio.play(); $('#playBtn').textContent = '⏸';
    } else { audio.pause(); $('#playBtn').textContent = '▶'; }
  }
  function nextTrack() { if (State.queueIndex < State.queue.length - 1) { State.queueIndex++; loadCurrent(!canPlayFull()); } }
  function prevTrack() {
    if (!State.previewMode && audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (State.queueIndex > 0) { State.queueIndex--; loadCurrent(!canPlayFull()); }
  }

  function updateLikeBtn() {
    const btn = $('#npLike');
    if (!State.current) return;
    btn.classList.toggle('on', State.likedIds.has('audio:' + State.current.id));
  }

  async function toggleLike(type, id) {
    if (!State.user) { toast('Connecte-toi pour aimer ce titre'); loginModal(); return; }
    try {
      const r = await api('/like', { method: 'POST', body: { contentType: type, contentId: id } });
      const key = type + ':' + id;
      if (r.liked) State.likedIds.add(key); else State.likedIds.delete(key);
      const item = (type === 'audio' ? State.tracks : State.videos).find((x) => x.id === id);
      if (item) item.likes = r.likes;
      updateLikeBtn();
      if (State.view !== 'dashboard') render();
    } catch (e) { toast(e.message); }
  }

  const fmtTime = (s) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  };

  audio.addEventListener('timeupdate', () => {
    if (State.previewMode) {
      const elapsed = Math.max(0, audio.currentTime - State.previewStart);
      $('#progressFill').style.width = Math.min(100, (elapsed / PREVIEW_SECS) * 100) + '%';
      $('#curTime').textContent = fmtTime(elapsed);
      $('#durTime').textContent = '0:10';
      if (elapsed >= PREVIEW_SECS) endPreview();
      return;
    }
    $('#progressFill').style.width = (audio.currentTime / (audio.duration || 1)) * 100 + '%';
    $('#curTime').textContent = fmtTime(audio.currentTime);
  });
  audio.addEventListener('loadedmetadata', () => {
    if (!State.previewMode) $('#durTime').textContent = fmtTime(audio.duration);
  });
  audio.addEventListener('ended', () => { if (!State.previewMode) nextTrack(); });

  // ============================================================
  //  LECTEUR VIDÉO (modale)
  // ============================================================
  function playVideo(id, forcePreview) {
    const v = State.videos.find((x) => x.id === id);
    if (!v) return;
    if (v.released === false) { toast('🔒 Disponible le ' + fmtDateTime(v.releaseAt)); return; }
    const preview = forcePreview !== undefined ? forcePreview : !canPlayFull();
    audio.pause(); $('#playBtn').textContent = '▶'; hidePreviewBanner();
    const m = el(`
      <div class="overlay">
        <div class="modal video-modal">
          <button class="modal-close" data-close style="z-index:8;color:#fff">&times;</button>
          ${preview ? '<div class="vm-preview-badge">◷ Aperçu 10s</div>' : ''}
          <video src="${esc(v.videoUrl)}" controls autoplay ${v.thumbUrl ? `poster="${esc(v.thumbUrl)}"` : ''}></video>
          ${preview ? `<div class="vm-lock"><div class="vl-ic">🔒</div><p>Aperçu de 10 secondes terminé.<br>${State.user ? 'Lance la vidéo complète.' : 'Connecte-toi pour regarder en entier.'}</p><button class="btn btn-gold" id="vmUnlock">${State.user ? 'Voir en entier' : 'Se connecter'}</button></div>` : ''}
          <div class="vm-info">
            <h3>${esc(v.title)}</h3>
            <p class="sub">${esc(v.artist)} · ${esc(v.genre)} · ${fmtMoney(v.price)}</p>
          </div>
        </div>
      </div>`);
    const videoEl = m.querySelector('video');
    let capped = preview;
    if (preview) {
      videoEl.addEventListener('timeupdate', () => {
        if (capped && videoEl.currentTime >= PREVIEW_SECS) {
          videoEl.pause();
          m.querySelector('.vm-lock').classList.add('show');
        }
      });
      m.querySelector('#vmUnlock').addEventListener('click', () => {
        if (!State.user) { closeModal(); loginModal(); return; }
        capped = false;
        m.querySelector('.vm-lock').classList.remove('show');
        videoEl.play();
      });
    }
    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) closeModal(); });
    $('#modalRoot').appendChild(m);
    api(`/videos/${id}/play`, { method: 'POST' }).then((r) => { v.plays = r.plays; }).catch(() => {});
  }

  // ============================================================
  //  PARTAGE D'EXTRAIT 30s (artiste vérifié)
  // ============================================================
  function socialButtons(url, text) {
    const u = encodeURIComponent(url), t = encodeURIComponent(text);
    return `
      <a class="soc fb" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${u}">f Facebook</a>
      <a class="soc wa" target="_blank" rel="noopener" href="https://wa.me/?text=${t}%20${u}">WhatsApp</a>
      <a class="soc tw" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?url=${u}&text=${t}">X / Twitter</a>`;
  }

  function shareModal(id) {
    const t = (State._artistContent?.tracks || State.tracks).find((x) => x.id === id);
    if (!t) return;
    let start = t.shareStart || 0;
    let timer = null;
    const preview = new Audio(t.audioUrl);
    _sharePreview = preview;

    const m = el(`
      <div class="overlay">
        <div class="modal">
          <button class="modal-close" data-close>&times;</button>
          <h3>Partager un extrait <span style="color:var(--gold)">30s</span></h3>
          <p class="sub">${esc(t.title)} — ${esc(t.artist)}</p>
          <div class="share-preview">
            <div class="wm">KORAWAVE</div>
            <div class="wm-sub">Disponible sur KORAWAVE</div>
            <button class="btn btn-gold" id="prevBtnS" type="button">▶ Écouter l'extrait</button>
          </div>
          <div class="field">
            <label>Début du passage : <span id="startLabel">${fmtSec(start)}</span></label>
            <input type="range" id="shareStart" min="0" max="0" value="${start}" step="1" class="range-gold" />
          </div>
          <button class="btn btn-gold btn-block" id="genBtn" type="button">🔗 Générer le lien de partage</button>
          <div id="shareResult" class="hidden">
            <div class="field" style="margin-top:16px">
              <label>Lien universel KORAWAVE</label>
              <div style="display:flex;gap:8px">
                <input class="input" id="shareLink" readonly />
                <button class="btn btn-outline" id="copyLink" type="button">Copier</button>
              </div>
            </div>
            <p class="sub" style="margin:14px 0 8px">Partager sur :</p>
            <div class="share-social" id="shareSocial"></div>
            <p class="sub" style="font-size:11px;margin-top:14px">TikTok & YouTube : via leurs APIs de publication (OAuth) côté serveur en production. L'extrait est borné à 30s et watermarqué KORAWAVE.</p>
          </div>
        </div>
      </div>`);

    const range = m.querySelector('#shareStart');
    const startLabel = m.querySelector('#startLabel');
    const prevBtn = m.querySelector('#prevBtnS');

    preview.addEventListener('loadedmetadata', () => {
      const max = Math.max(0, Math.floor(preview.duration - 30));
      range.max = max;
      if (start > max) { start = 0; range.value = 0; startLabel.textContent = fmtSec(0); }
    });
    range.addEventListener('input', () => { start = parseInt(range.value, 10) || 0; startLabel.textContent = fmtSec(start); });

    function stopPreview() { preview.pause(); clearTimeout(timer); prevBtn.textContent = "▶ Écouter l'extrait"; }
    prevBtn.addEventListener('click', () => {
      if (!preview.paused) { stopPreview(); return; }
      preview.currentTime = start;
      preview.play().then(() => {
        prevBtn.textContent = '⏸ Lecture…';
        clearTimeout(timer);
        timer = setTimeout(stopPreview, 30000);
      }).catch(() => toast('Aperçu indisponible'));
    });
    preview.addEventListener('ended', stopPreview);

    m.querySelector('#genBtn').addEventListener('click', async () => {
      try {
        const r = await api(`/artist/tracks/${id}/share`, { method: 'POST', body: { start } });
        m.querySelector('#shareLink').value = r.shareUrl;
        m.querySelector('#shareSocial').innerHTML = socialButtons(r.shareUrl, `Écoute "${t.title}" sur KORAWAVE 🎶`);
        m.querySelector('#shareResult').classList.remove('hidden');
        toast('🔗 Lien d\'extrait généré');
        loadData();
      } catch (e) { toast(e.message); }
    });
    m.querySelector('#copyLink').addEventListener('click', () => {
      const inp = m.querySelector('#shareLink');
      inp.select();
      navigator.clipboard?.writeText(inp.value).then(() => toast('Lien copié ✓')).catch(() => {});
    });

    m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close !== undefined) { stopPreview(); closeModal(); } });
    $('#modalRoot').appendChild(m);
  }

  // ============================================================
  //  PAGE PUBLIQUE D'UN EXTRAIT PARTAGÉ  (/titre/:id)
  // ============================================================
  async function renderSharePage(id) {
    $('#app').classList.add('hidden');
    const root = $('#shareRoot');
    root.classList.remove('hidden');
    let data;
    try { data = await api('/share/' + id); }
    catch (e) {
      root.innerHTML = `<div class="share-page"><div class="share-card"><div class="brand-logo" style="font-size:34px">KORAWAVE</div><p class="sub" style="margin-top:18px">Extrait indisponible ou expiré.</p><a class="btn btn-gold" href="/">Aller sur KORAWAVE</a></div></div>`;
      return;
    }
    const preview = new Audio(data.audioUrl);
    let timer = null;
    root.innerHTML = `
      <div class="share-page">
        <div class="share-card">
          <div class="brand-logo" style="font-size:30px;text-align:center">KORAWAVE</div>
          <div class="brand-dots" style="justify-content:center;margin:8px 0 22px">
            <span class="brand-dot" style="background:var(--red)"></span>
            <span class="brand-dot" style="background:var(--yellow)"></span>
            <span class="brand-dot" style="background:var(--green)"></span>
          </div>
          <div class="share-cover">${data.coverUrl ? `<img src="${esc(data.coverUrl)}" />` : '<span class="ph">♪</span>'}<div class="wm">KORAWAVE · extrait 30s</div></div>
          <h2 class="share-title">${esc(data.title)}</h2>
          <p class="share-artist">${esc(data.artist)}${data.verified ? ' <span class="verified-badge">✔</span>' : ''} · ${esc(data.genre)}</p>
          <button class="btn btn-gold btn-block" id="spPlay" type="button" style="margin:18px 0 10px">▶ Écouter l'extrait (30s)</button>
          <div class="share-prog"><div class="share-prog-fill" id="spFill"></div></div>
          <a class="btn btn-outline btn-block" href="/" style="margin-top:16px">🎧 Écouter en entier sur KORAWAVE — ${fmtMoney(data.price)}</a>
          <p class="sub" style="margin-top:18px">Partager :</p>
          <div class="share-social">${socialButtons(location.href, `Écoute "${data.title}" sur KORAWAVE 🎶`)}</div>
        </div>
      </div>`;

    const playBtn = root.querySelector('#spPlay');
    const fill = root.querySelector('#spFill');
    function stop() { preview.pause(); clearTimeout(timer); playBtn.textContent = "▶ Écouter l'extrait (30s)"; }
    playBtn.addEventListener('click', () => {
      if (!preview.paused) { stop(); return; }
      preview.currentTime = data.shareStart || 0;
      preview.play().then(() => { playBtn.textContent = '⏸ Lecture…'; timer = setTimeout(stop, 30000); }).catch(() => {});
    });
    preview.addEventListener('timeupdate', () => {
      const elapsed = preview.currentTime - (data.shareStart || 0);
      fill.style.width = Math.min(100, (elapsed / 30) * 100) + '%';
    });
    preview.addEventListener('ended', stop);
  }

  // ============================================================
  //  NAVIGATION
  // ============================================================
  function setActiveNav() {
    $$('#mainNav .nav-item, #adminNav .nav-item, #artistNav .nav-item, #walletNav .nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === State.view && !b.dataset.genre);
    });
    // Cat panel genre highlighting
    $$('#catPanel .cat-item').forEach((b) => {
      if (b.dataset.genre) b.classList.toggle('active', b.dataset.genre === (State.genreFilter || 'Tous'));
    });
  }

  function go(view) {
    State.view = view; State.genreFilter = null; State._artistFilter = null; State._artistPageId = null; State.search = ''; $('#searchInput').value = '';
    setActiveNav(); render();
  }

  // ============================================================
  //  ÉVÉNEMENTS GLOBAUX
  // ============================================================
  function bindGlobal() {
    $('#openLogin').onclick = loginModal;
    $('#openRegister').onclick = registerModal;
    $('#logoutBtn').onclick = logout;
    $('#identifyBtn').onclick = identifyModal;

    // Cat panel — mobile overlay close
    const overlay = $('#sidebarOverlay');
    const catPanel = $('#catPanel');
    function closeCatPanel() { catPanel?.classList.remove('open'); overlay?.classList.remove('show'); }
    if (overlay) overlay.addEventListener('click', closeCatPanel);
    catPanel?.addEventListener('click', (e) => {
      if (e.target.closest('[data-genre]') && window.innerWidth <= 768) closeCatPanel();
    });

    // Cat panel click — genre filter
    catPanel?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cat-item');
      if (!btn || !btn.dataset.genre) return;
      const g = btn.dataset.genre;
      State.genreFilter = g === 'Tous' ? null : g;
      State.view = 'music';
      setActiveNav(); render();
    });
    $('#userChip').onclick = () => {
      if (State.user?.role === 'admin') go('dashboard');
      else if (State.user) go('wallet');
    };
    $('#npTip').onclick = () => { if (State.current?.ownerId) tipModal(State.current.ownerId, State.current.artist); };

    // Cloche de notifications
    $('#bellBtn').onclick = (e) => { e.stopPropagation(); toggleBellPanel(); };
    $('#bellPanel').addEventListener('click', (e) => {
      const n = e.target.closest('[data-nid]');
      if (n) {
        $('#bellPanel').classList.add('hidden');
        if (n.dataset.ntype === 'battle') { go('battle'); battleDetailModal(n.dataset.nid); }
        else { detailModal(n.dataset.ntype, n.dataset.nid); }
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.bell-wrap')) $('#bellPanel')?.classList.add('hidden');
    });

    $('#playBtn').onclick = togglePlay;
    $('#nextBtn').onclick = nextTrack;
    $('#prevBtn').onclick = prevTrack;
    $('#npLike').onclick = () => { if (State.current) toggleLike('audio', State.current.id); };
    $('#volume').oninput = (e) => { audio.volume = e.target.value / 100; };
    audio.volume = 0.8;
    $('#previewUnlock').onclick = unlockFull;
    $('#previewClose').onclick = hidePreviewBanner;

    $('#progress').onclick = (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      if (State.previewMode) {
        try { audio.currentTime = State.previewStart + pct * PREVIEW_SECS; } catch (err) {}
        if (audio.paused) { audio.play(); $('#playBtn').textContent = '⏸'; hidePreviewBanner(); }
        return;
      }
      if (audio.duration) audio.currentTime = pct * audio.duration;
    };

    // Topnav clicks (main nav + conditional navs)
    ['#mainNav','#adminNav','#artistNav','#walletNav'].forEach(sel => {
      document.querySelector(sel)?.addEventListener('click', (e) => {
        const btn = e.target.closest('.nav-item');
        if (btn?.dataset.view) go(btn.dataset.view);
      });
    });
    $('#becomeArtistBtn').onclick = becomeArtistModal;

    let searchT;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(searchT);
      searchT = setTimeout(() => {
        const q = e.target.value.trim();
        State.search = q.toLowerCase();
        if (q.length >= 2) {
          State.view = 'search';
          State.genreFilter = null;
          State._artistFilter = null;
        } else if (q.length === 0) {
          if (State.view === 'search') { State.view = 'home'; }
        }
        render();
      }, 180);
    });

    // Délégation pour tout le contenu dynamique
    $('#content').addEventListener('click', (e) => {
      const t = e.target;
      const prev = t.closest('[data-preview]');
      const prevVid = t.closest('[data-previewvideo]');
      const playBtn = t.closest('[data-play]');
      const card = t.closest('[data-track]');
      const playVid = t.closest('[data-playvideo]');
      const vcard = t.closest('[data-video]');
      const chip = t.closest('[data-chip]');
      const tickerGenre = t.closest('[data-ticker-genre]');
      const viewBtn = t.closest('[data-view-btn]');
      const sub = t.closest('[data-sub]');
      const msub = t.closest('[data-msub]');
      const del = t.closest('[data-del]');
      const verify = t.closest('[data-verify]');
      const share = t.closest('[data-share]');
      const buy = t.closest('[data-buy]');
      const pack = t.closest('[data-pack]');
      const detail = t.closest('[data-detail]');

      if (t.id === 'heroRegister') return registerModal();
      if (detail) { const [ty, cid] = detail.dataset.detail.split(':'); return detailModal(ty, cid); }
      if (buy) { const [ty, cid] = buy.dataset.buy.split(':'); return buyContent(ty, cid); }
      if (pack) return rechargeModal(pack.dataset.pack);
      if (prev) return previewTrack(prev.dataset.preview);
      if (prevVid) return playVideo(prevVid.dataset.previewvideo, true);
      if (playBtn) return playTrack(playBtn.dataset.play);
      if (playVid) return playVideo(playVid.dataset.playvideo);
      const plRow = t.closest('.pl-track-row[data-play]');
      if (plRow && !t.closest('.pl-remove-track')) return playTrack(plRow.dataset.play);
      if (card && !playVid && !t.closest('[data-artist-page]') && !t.closest('[data-addtopl]')) return playTrack(card.dataset.track);
      if (vcard) return playVideo(vcard.dataset.video);
      if (chip) {
        const g = chip.dataset.chip;
        State.genreFilter = g === 'Tous' ? null : g;
        return render();
      }
      if (tickerGenre) {
        State.genreFilter = tickerGenre.dataset.tickerGenre;
        go('music');
        return;
      }
      if (viewBtn) return go(viewBtn.dataset.viewBtn);
      const adminTabBtn = t.closest('[data-admintab]');
      if (adminTabBtn) { adminTab = adminTabBtn.dataset.admintab; render(); return; }
      const msgPartner = t.closest('[data-msg-partner]');
      if (msgPartner) {
        if (!State.user) { loginModal(); return; }
        State._threadPartnerId = msgPartner.dataset.msgPartner;
        State.view = 'thread'; setActiveNav(); render(); return;
      }
      const addToPlBtn = t.closest('[data-addtopl]');
      if (addToPlBtn) { e.stopPropagation(); addToPlaylistModal(addToPlBtn.dataset.addtopl); return; }
      const removeTrack = t.closest('[data-pl-id][data-track-id]');
      if (removeTrack && removeTrack.classList.contains('pl-remove-track')) {
        e.stopPropagation();
        api('/playlists/' + removeTrack.dataset.plId + '/tracks/' + removeTrack.dataset.trackId, { method: 'DELETE' })
          .then(() => { toast('Retiré de la playlist'); render(); })
          .catch((err) => toast(err.message));
        return;
      }
      const artistPage = t.closest('[data-artist-page]');
      if (artistPage && artistPage.dataset.artistPage) {
        e.stopPropagation();
        State._artistPageId = artistPage.dataset.artistPage;
        State.view = 'artistPage';
        State.search = ''; $('#searchInput').value = '';
        setActiveNav(); render(); return;
      }
      const searchArtist = t.closest('[data-search-artist]');
      if (searchArtist) {
        State._artistFilter = searchArtist.dataset.searchArtist;
        State.search = ''; $('#searchInput').value = '';
        State.view = 'music'; setActiveNav(); render(); return;
      }
      if (sub) { dashSubtab = sub.dataset.sub; render(); return; }
      if (msub) { manageSub = msub.dataset.msub; $$('.manage-sub').forEach((b) => b.classList.toggle('active', b === msub)); mountManageList(); return; }
      if (del) return deleteItem(del.dataset.deltype, del.dataset.del, del.dataset.delmode);
      const editContent = t.closest('[data-edit-content]');
      if (editContent) { const [ty, cid] = editContent.dataset.editContent.split(':'); return editContentModal(ty, cid); }
      if (verify) return verifyArtist(verify.dataset.verify);
      if (share) return shareModal(share.dataset.share);
      const mod = t.closest('[data-mod]');
      if (mod) { const [action, cid] = mod.dataset.mod.split(':'); return moderateComment(action, cid); }
      const battleCard = t.closest('[data-battle]');
      if (battleCard) return battleDetailModal(battleCard.dataset.battle);
      const closeBattle = t.closest('[data-close-battle]');
      if (closeBattle) return adminCloseBattle(closeBattle.dataset.closeBattle);

      // Fan Pack
      const buyFp = t.closest('[data-buy-fp]');
      if (buyFp) return buyFanPack(buyFp.dataset.buyFp);

      // Events
      const evCard = t.closest('[data-event]');
      if (evCard) return eventDetailModal(evCard.dataset.event);

      // Top Guinée — joue le titre du champion
      const tgPlay = t.closest('[data-play-tg]');
      if (tgPlay) {
        const trackId = tgPlay.dataset.playTg;
        const track = State.tracks.find((tr) => tr.id === trackId);
        if (track) { State.queue = [track]; State.queueIndex = 0; loadCurrent(!canPlayFull()); }
        return;
      }

      // Radio button in hero
      if (t.id === 'radioBtn' || t.closest('#radioBtn')) return moodModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
        e.preventDefault(); togglePlay();
      }
      if (e.key === 'Escape') closeModal();
    });
  }

  // ============================================================
  //  INIT
  // ============================================================
  async function init() {
    // Page publique de partage d'extrait : /titre/:id
    const shareMatch = location.pathname.match(/^\/titre\/([^/]+)$/);
    if (shareMatch) { await renderSharePage(shareMatch[1]); return; }

    bindGlobal();
    if (State.token) {
      try {
        const { user } = await api('/auth/me');
        State.user = user;
        if (user.role === 'admin') State.view = 'dashboard';
        else if (user.role === 'artist') State.view = 'artist';
      } catch (e) { State.token = null; localStorage.removeItem('kw_token'); }
    }
    renderAuthUI(); setActiveNav();
    await loadData();
    await render();
    loadNotifications();
    initPush();
    if (State.user) startMsgBadge();
    // polling léger des notifications (toutes les 45s)
    setInterval(() => { if (State.user) loadNotifications(); }, 45000);
  }

  init();
})();
