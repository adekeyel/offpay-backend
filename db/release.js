const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Runs migrate.js then seed.js as a single, unambiguous command.
 *
 * Why this file exists: Railway's preDeployCommand does not reliably chain
 * "node a.js && node b.js" the way a real shell would — in practice it can
 * tokenize the string and hand Node only the first script plus a pile of
 * ignored extra arguments, silently skipping everything after "&&". Rather
 * than depend on the exact quoting/parsing behavior of whatever platform
 * runs this (Railway today, possibly something else tomorrow), this script
 * is the ONE thing the platform needs to invoke — `node db/release.js` —
 * with zero spaces, operators, or quoting for it to get wrong.
 */
const root = path.join(__dirname, '..');

function run(script) {
  console.log(`--- running ${script} ---`);
  execFileSync(process.execPath, [path.join(root, script)], {
    stdio: 'inherit',
    cwd: root,
  });
}

try {
  run('db/migrate.js');
  run('db/seed.js');
  console.log('--- release step complete ---');
} catch (err) {
  // migrate.js / seed.js already print their own error and exit non-zero;
  // execFileSync throws in that case, so just make sure this wrapper also
  // exits non-zero (rather than appearing to succeed).
  process.exit(err.status || 1);
}
