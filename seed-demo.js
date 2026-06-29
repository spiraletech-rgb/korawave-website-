/**
 * KORAWAVE — Seed de contenu de démo.
 * Génère de vrais fichiers audio WAV (jouables par le navigateur) + pochettes SVG,
 * puis les publie via l'API admin. Réutilisable : `node seed-demo.js`.
 *
 * Le serveur doit tourner (npm start) sur http://localhost:4000.
 */
'use strict';

const BASE = process.env.BASE || 'http://localhost:4000';
const ADMIN = { identifier: 'admin@korawave.gn', password: 'Korawave2025' };

// --- Génère un WAV PCM 16 bits mono (gamme pentatonique, agréable) ---
function makeWav(seconds) {
  const sampleRate = 22050, bytesPerSample = 2;
  const n = Math.floor(seconds * sampleRate);
  const dataSize = n * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);

  const scale = [261.63, 293.66, 329.63, 392.0, 440.0]; // do ré mi sol la
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const note = scale[Math.floor(t * 2) % scale.length]; // change de note toutes les 0,5s
    phase += (2 * Math.PI * note) / sampleRate;
    // enveloppe douce par note + petit accord (octave) pour étoffer
    const env = 0.35 * (0.6 + 0.4 * Math.sin(t * 6));
    let s = (Math.sin(phase) + 0.4 * Math.sin(phase * 2)) * env;
    s = Math.max(-1, Math.min(1, s));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// --- Pochette SVG (or/noir KORAWAVE) ---
function makeCover(title, c1, c2) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <defs>
    <radialGradient id="g" cx="35%" cy="30%" r="80%">
      <stop offset="0%" stop-color="${c1}"/><stop offset="60%" stop-color="${c2}"/><stop offset="100%" stop-color="#0a0a0a"/>
    </radialGradient>
  </defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <g opacity="0.9">
    ${Array.from({ length: 28 }, (_, i) => {
      const x = 40 + i * 19; const h = 60 + Math.abs(Math.sin(i * 1.3)) * 240;
      return `<rect x="${x}" y="${300 - h / 2}" width="9" height="${h}" rx="4" fill="#c9a84c" opacity="0.55"/>`;
    }).join('')}
  </g>
  <text x="300" y="300" font-family="Arial Narrow, sans-serif" font-size="62" font-weight="bold"
        fill="#0a0a0a" text-anchor="middle" letter-spacing="6">KORAWAVE</text>
  <text x="300" y="345" font-family="Arial" font-size="22" fill="#0a0a0a" text-anchor="middle" opacity="0.7">${title}</text>
  <g>
    <circle cx="276" cy="380" r="7" fill="#ce1126"/><circle cx="300" cy="380" r="7" fill="#fcd116"/><circle cx="324" cy="380" r="7" fill="#009460"/>
  </g>
</svg>`;
  return Buffer.from(svg, 'utf-8');
}

async function main() {
  // login admin
  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  if (!lr.ok) throw new Error('Login admin échoué — le serveur tourne-t-il ? ' + (await lr.text()));
  const { token } = await lr.json();

  const demos = [
    { title: 'Conakry Sunrise', artist: 'KORAWAVE Studio', genre: 'Mandingue', price: 500, secs: 50, c1: '#e8c97a', c2: '#c9a84c' },
    { title: 'Kora Interlude (court)', artist: 'KORAWAVE Studio', genre: 'Mode Griot', price: 500, secs: 8, c1: '#7ad6b0', c2: '#009460' },
  ];

  for (const d of demos) {
    const wav = makeWav(d.secs);
    const cover = makeCover(d.title, d.c1, d.c2);
    const fd = new FormData();
    fd.append('title', d.title);
    fd.append('artist', d.artist);
    fd.append('genre', d.genre);
    fd.append('price', String(d.price));
    fd.append('audio', new Blob([wav], { type: 'audio/wav' }), 'demo.wav');
    fd.append('cover', new Blob([cover], { type: 'image/svg+xml' }), 'cover.svg');

    const r = await fetch(`${BASE}/api/admin/tracks`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
    });
    const out = await r.json();
    if (!r.ok) { console.error('Échec', d.title, out); continue; }
    console.log(`✓ Publié : ${out.track.title} (${d.secs}s) — ${out.track.audioUrl}`);
  }
  console.log('\nDémo prête. Ouvre http://localhost:4000 et clique « ◷ 10s » sur une carte.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
