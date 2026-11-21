// Lint: money/quantity code must not use parseFloat / toFixed / Math.round on monetary values.
const fs = require('fs');
const path = require('path');
const bad = /parseFloat\(|\.toFixed\(|Math\.round\(.*(price|total|amount|cost|qty)/i;
let failed = false;
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(f.name)) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.ts$/.test(f.name) && !/\.spec\.ts$/.test(f.name)) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
        if (bad.test(l)) {
          console.error(`${p}:${i + 1}: float money pattern: ${l.trim()}`);
          failed = true;
        }
      });
    }
  }
})(path.join(__dirname, '..', 'apps'));
process.exit(failed ? 1 : 0);
