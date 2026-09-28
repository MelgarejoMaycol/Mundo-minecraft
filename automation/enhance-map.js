const fs = require('fs');
const path = require('path');

const renderDir = process.argv[2];
const repoDir = process.argv[3];

if (!renderDir || !repoDir) {
  throw new Error('Uso: node enhance-map.js <renderDir> <repoDir>');
}

function replaceRequired(content, oldText, newText, label) {
  if (content.includes(newText)) return content;
  if (!content.includes(oldText)) {
    throw new Error('No se encontró el patrón de uNmINeD para: ' + label);
  }
  return content.replace(oldText, newText);
}

const viewerPath = path.join(renderDir, 'unmined.js');
if (!fs.existsSync(viewerPath)) {
  throw new Error('No existe ' + viewerPath);
}

let viewer = fs.readFileSync(viewerPath, 'utf8');

if (!viewer.includes('OCAYORK_PERSISTENT_TILE_CACHE')) {
  viewer = replaceRequired(
    viewer,
    '        const dpiScale = window.devicePixelRatio ?? 1.0;',
    `        const dpiScale = window.devicePixelRatio ?? 1.0;
        /* OCAYORK_PERSISTENT_TILE_CACHE */
        const deviceMemory = navigator.deviceMemory ?? 4;
        const clientTileCacheSize = deviceMemory >= 8 ? 2048 : (deviceMemory >= 4 ? 1024 : 512);
        const clientPreload = deviceMemory >= 8 ? 3 : (deviceMemory >= 4 ? 2 : 1);`,
    'cache cliente'
  );

  viewer = replaceRequired(
    viewer,
    `            new ol.layer.Tile({
                source: new ol.source.XYZ({`,
    `            new ol.layer.Tile({
                preload: clientPreload,
                useInterimTilesOnError: true,
                updateWhileAnimating: true,
                updateWhileInteracting: true,
                source: new ol.source.XYZ({
                    cacheSize: clientTileCacheSize,`,
    'capa de tiles'
  );

  viewer = replaceRequired(
    viewer,
    `                    tilePixelRatio: dpiScale,
                    tileSize:`,
    `                    tilePixelRatio: dpiScale,
                    interpolate: false,
                    tileSize:`,
    'interpolación'
  );

  fs.writeFileSync(viewerPath, viewer);
}

const sourceSw = path.join(repoDir, 'sw.js');
const targetSw = path.join(renderDir, 'sw.js');
if (!fs.existsSync(sourceSw)) {
  throw new Error('No existe sw.js en el repositorio.');
}
fs.copyFileSync(sourceSw, targetSw);

const indexPath = path.join(renderDir, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('OCAYORK_PERSISTENT_MAP_CACHE')) {
  const registration = `
<script>
/* OCAYORK_PERSISTENT_MAP_CACHE */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
  });
}
</script>
`;

  html = html.includes('</body>')
    ? html.replace('</body>', registration + '\n</body>')
    : html + registration;

  fs.writeFileSync(indexPath, html);
}

console.log('Caché persistente del mapa aplicada: tiles visitados conservados + precarga cliente.');
