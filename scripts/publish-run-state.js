// Reads a GitHub "list workflow runs" answer on stdin and prints the state of its Publish run:
// "<status> <conclusion> <url>", or "none" when there is no such run yet.
const answer = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const run = (answer.workflow_runs || []).find((w) => w.name === 'Publish');
console.log(run ? `${run.status} ${run.conclusion || '-'} ${run.html_url}` : 'none');
