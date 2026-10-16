# n8n-nodes-sdp

An [n8n](https://n8n.io) community node for **SafeDataPath (SDP)**. It registers the provenance of
your workflow data in SDP with cryptographic checksums, so a run can later be independently verified.

This package is part of the SDP n8n integration (FCT-1315). It is the **visibility / active-capture**
half of the integration; the passive, whole-workflow capture is handled separately by SDP's polling
service (Approach 4).

## Installation

Follow the n8n [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/),
then install `n8n-nodes-sdp` from **Settings → Community Nodes**.

## Credentials

In the **SafeDataPath** node, **Authentication** picks how the node signs in to SafeDataPath. n8n then shows its
**Setup credential** dropdown with both options (FCT-1676).

**OAuth2 (SafeDataPath, Microsoft or Google)**, the default for a new node: click **Connect to SDP** in the
node, then sign in to SDP with a password, a Microsoft or a Google account and approve. There is
nothing to fill in: the SDP address `https://n8n.safedatapath.eu`, PKCE, the public client `n8n` and
the empty client secret are all fixed. That is what makes n8n show its one-click button, on n8n Cloud
and self-hosted alike. For a local or test SDP, set the address on the n8n instance:

```
CREDENTIALS_OVERWRITE_DATA={"sdpOAuth2Api":{"baseUrl":"http://localhost:8081"}}
```

This needs the SDP OAuth2 server of FCT-1628. Until it ships, Connect opens the SDP trial entry flow
(`/trial?entry=n8n`), where the visitor signs in or creates an account, but no token comes back to n8n.

**API Key (Machine User)**: create a **SafeDataPath API** credential:

- **Base URL**: already set to `https://n8n.safedatapath.eu`. Change it only for another SDP instance (no trailing slash).
- **API Key**: an SDP machine-user token holding the `PIPELINE_INSERT` permission.

The key is sent as `Authorization: Bearer <apiKey>`.

The node is at version 2. Version 2 only moves the Authentication default to OAuth2. A node saved
as version 1, before the OAuth2 option existed, stays on API Key and keeps working unchanged.

## The node

The node is called **SafeDataPath** in n8n (internal name `sdp`). Search the node picker for
SafeDataPath, SDP, provenance, audit trail, proof, timestamp and the like. Its panel holds the
credential and one notice, nothing else.

**Place it first in your workflow.** When it runs, it asks SafeDataPath to record the run, sends the
SHA-512 of every file that reaches it (the files stay in n8n), and hands its input items on unchanged,
so the next nodes get the trigger data. SafeDataPath records the run once it finishes: the record
appears a few seconds after the run ends.

**One node per workflow.** n8n lets you add it once (`maxNodes: 1`): one run gives one record.

**It never stops your workflow** (FCT-1746). The request times out after 10 seconds and is tried up to
3 times, 1 then 2 seconds apart, in the node itself (not n8n's Retry On Fail). If it still fails, the
node logs `SafeDataPath: run <execution id> not recorded ...` in the n8n log and the workflow carries on.
Only a manual run with no credential, or a credential SafeDataPath refuses, stops with a clear message,
so you see it while testing.

## Nothing arrives in SDP

The node only tells SDP which execution to capture. SDP then reads the execution back from n8n, so
SDP needs three things of its own. Check them in this order:

1. **The request reached SafeDataPath.** The node never turns red in a production run: search the
   n8n log for `SafeDataPath: run <execution id> not recorded`. An HTTP 401 or 403 there means the
   credential's key is wrong or lacks `PIPELINE_INSERT`; a manual run shows it on the node.
2. **SDP knows where n8n is.** On the SDP server, `sdp.n8n.base-url` must be the root address of this
   n8n instance, for example `https://n8n.example.com`, with no path. The address shown in the browser
   (`.../home/workflows`) does not work. When the key is not set at all, SDP calls the Factiven n8n
   test instance and logs a warning at each capture. SDP must be able to reach the address.
3. **SDP holds an n8n API key** for the tenant, saved on the SDP Secret page, and that key may read
   the executions and workflows of this n8n user.

SDP captures the run once it is over, read every 15 seconds. A run still not over after 7 days, or
canceled in n8n, gives a product in error that says why, not nothing. A run still running is not
an error: its product only appears when it ends.

The SDP log says which one is missing. Search it for `n8n capture:`. To test point 2 and 3 from the
SDP server, with the id of a finished execution:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  -H "X-N8N-API-KEY: <n8n API key>" \
  "<sdp.n8n.base-url>/api/v1/executions/<id>?includeData=true"
```

`200 application/json` is right. `200 text/html` means the base URL carries a path. `401` or `403`
means n8n refuses the key. `404` means n8n did not keep this execution, or the key cannot see it.

## Development

```bash
npm install        # commit the resulting package-lock.json
npm run lint
npm run build
npm run dev        # runs a local n8n with this node linked
```

Built with the [`@n8n/node-cli`](https://www.npmjs.com/package/@n8n/node-cli) toolchain. The package
has **no runtime dependencies** (verified-node requirement): HTTP uses n8n's helpers and hashing uses
Node's built-in `crypto`.

## Integration tests

`test/integration/capture.test.mts` drives a real n8n through its public API: it creates `sdpApi`
credentials and workflows, fires them by webhook, reads each capture back from SDP, then deletes what
it created. Three cases: a successful run is captured; a failed run is still captured; a wrong SDP
key captures nothing and does not stop the run.

```bash
export N8N_URL=https://n8n.example.com N8N_API_KEY=...
export SDP_URL=https://sdp.example.com SDP_API_KEY=...   # AGENT key of the tenant that reads this n8n back
npm run typecheck:test
npm run test:integration   # JUnit report in integration-capture.xml
```

The node type defaults to `CUSTOM.sdp`, the name n8n gives a node installed in its custom directory;
set `N8N_SDP_NODE_TYPE=n8n-nodes-sdp.sdp` for a node installed from npm. The TeamCity build
`sdp_N8nNodeIntegration` runs it through `test/integration/ci.sh`, after deploying the branch build.

## Publishing

Publishing is automated from the **repository-root** GitHub Actions workflow
(`.github/workflows/publish-n8n-node.yml`) and uses **npm provenance**, as required for n8n
verification since 2026-05-01. Tag a release as `n8n-nodes-sdp-v<version>` to trigger it.

## License

MIT
