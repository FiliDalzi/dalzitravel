#!/usr/bin/env node
/**
 * DalziTravel — Generatore icone PWA
 *
 * Genera DUE set di icone PNG reali tramite sharp:
 *   icon-NxN.png          → purpose "any"      (logo a pieno bordo)
 *   icon-NxN-maskable.png → purpose "maskable" (safe zone 10% padding)
 *
 * La separazione dei due set elimina il warning Lighthouse/Chrome:
 * "any maskable" combinati sulla stessa icona è sconsigliato.
 *
 * Uso: node scripts/generate-icons.js
 */

const path = require('path');
const fs   = require('fs');

let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error("❌ 'sharp' non trovato. Esegui: npm install sharp");
  process.exit(1);
}

const SIZES   = [72, 96, 128, 144, 152, 192, 384, 512];
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

/** Icona "any": logo a pieno bordo, niente padding extra */
function svgAny(size) {
  const rx  = Math.round(size * 0.20);
  const fs_ = Math.round(size * 0.42);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0ea5e9"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${rx}" fill="url(#g)"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial Black,Arial,sans-serif" font-weight="900"
        font-size="${fs_}" fill="white">D</text>
</svg>`;
}

/**
 * Icona "maskable": safe zone = 10% padding su tutti i lati (W3C spec).
 * Il SO maschera l'icona in cerchio/squircle: il contenuto visivo
 * deve stare nell'80% centrale per non essere ritagliato.
 * Lo sfondo pieno copre tutta l'area compresi i bordi mascherati.
 */
function svgMaskable(size) {
  const pad   = Math.round(size * 0.10);
  const inner = size - pad * 2;
  const rx    = Math.round(inner * 0.22);
  const fs_   = Math.round(inner * 0.42);
  const cx    = size / 2;
  const cy    = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0ea5e9"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="#0c4a6e"/>
  <rect x="${pad}" y="${pad}" width="${inner}" height="${inner}" rx="${rx}" fill="url(#g)"/>
  <text x="${cx}" y="${cy * 1.04}" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial Black,Arial,sans-serif" font-weight="900"
        font-size="${fs_}" fill="white">D</text>
</svg>`;
}

function svgScreenshot(w, h) {
  const fsBig   = Math.round(w * 0.05);
  const fsSub   = Math.round(w * 0.025);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="#020617"/>
  <text x="${w/2}" y="${h/2}" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial Black,Arial,sans-serif" font-size="${fsBig}" font-weight="900" fill="#0ea5e9">DalziTravel</text>
  <text x="${w/2}" y="${h/2 + fsBig}" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial,sans-serif" font-size="${fsSub}" fill="#475569">Il tuo viaggio, generato dall'AI</text>
</svg>`;
}

(async () => {
  console.log('Generazione icone PWA DalziTravel…\n');

  for (const size of SIZES) {
    await sharp(Buffer.from(svgAny(size))).png()
      .toFile(path.join(OUT_DIR, `icon-${size}x${size}.png`));

    await sharp(Buffer.from(svgMaskable(size))).png()
      .toFile(path.join(OUT_DIR, `icon-${size}x${size}-maskable.png`));

    console.log(`  ✓ ${size}x${size}  → any + maskable`);
  }

  await sharp(Buffer.from(svgScreenshot(1280, 720))).png()
    .toFile(path.join(OUT_DIR, 'screenshot-wide.png'));
  console.log('  ✓ screenshot-wide.png');

  await sharp(Buffer.from(svgScreenshot(750, 1334))).png()
    .toFile(path.join(OUT_DIR, 'screenshot-narrow.png'));
  console.log('  ✓ screenshot-narrow.png');

  console.log('\n✅ Icone generate in public/icons/');
  console.log('   Nessun warning "any maskable" — i due set sono separati.');
  console.log('   Per icone personalizzate: https://maskable.app + https://realfavicongenerator.net\n');
})();
