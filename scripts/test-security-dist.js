import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] || 'dist');
const forbidden = [
  '.env', '.dev.vars', '.git', 'package.json', 'package-lock.json', 'README.md',
  'functions', 'tests', 'data', 'node_modules', 'wrangler.toml', 'wrangler.jsonc'
];

for (const relative of forbidden) {
  assert.equal(existsSync(join(dist, relative)), false, `Wrażliwa ścieżka trafiła do dist: ${relative}`);
}

const worker = join(dist, '_worker.js');
assert.equal(existsSync(worker), true, 'Brak wymaganego artefaktu Pages Functions _worker.js');
assert.equal(statSync(worker).isDirectory(), true, '_worker.js powinien być artefaktem modułowym Wrangler');

const routes = JSON.parse(readFileSync(join(dist, '_routes.json'), 'utf8'));
assert.deepEqual(routes.include.sort(), ['/api/quote-notification', '/api/quote-products']);
assert.deepEqual(routes.exclude, []);

assert.equal(existsSync(join(dist, 'analytics.js')), true, 'Brak first-party modułu zdarzeń analytics.js');
const htmlFiles = [];
function collectHtml(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectHtml(path);
    else if (entry.name.endsWith('.html')) htmlFiles.push(path);
  }
}
collectHtml(dist);
for (const htmlFile of htmlFiles) {
  const html = readFileSync(htmlFile, 'utf8');
  assert.equal((html.match(/<script src="(?:\.\.\/|\.\.\/\.\.\/)?analytics\.js"><\/script>/g) || []).length, 1,
    `Strona musi ładować dokładnie jeden first-party moduł Analytics: ${htmlFile}`);
  assert.equal((html.match(/static\.cloudflareinsights\.com\/beacon\.min\.js/g) || []).length, 0,
    `Repo nie może dublować automatycznego beacona Cloudflare: ${htmlFile}`);
}

const headers = readFileSync(join(dist, '_headers'), 'utf8');
assert.match(headers, /Content-Security-Policy:/);
assert.match(headers, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com(?:;|\s)/);
assert.match(headers, /connect-src [^;]*'self'/);
assert.doesNotMatch(headers, /(?:script-src|connect-src) [^;]*\*/);
assert.match(headers, /Strict-Transport-Security:/);
assert.match(headers, /! Access-Control-Allow-Origin/);

console.log('Security dist: brak plików wrażliwych, trasy Functions i nagłówki poprawne.');
