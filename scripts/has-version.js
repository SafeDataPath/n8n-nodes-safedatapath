// Reads the output of `npm view <name> versions --json` on stdin and exits 0 when it holds the version given
// as argument. npm prints a plain string, not an array, for a package with a single version.
const versions = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.exit((Array.isArray(versions) ? versions : [versions]).includes(process.argv[2]) ? 0 : 1);
