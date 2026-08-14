import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

const headers = readFileSync(join(dist, '_headers'), 'utf8');
assert.match(headers, /Content-Security-Policy:/);
assert.match(headers, /Strict-Transport-Security:/);
assert.match(headers, /! Access-Control-Allow-Origin/);

console.log('Security dist: brak plików wrażliwych, trasy Functions i nagłówki poprawne.');
