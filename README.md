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

In the SDP node, **Authentication** picks how the node signs in to SDP. n8n then shows its
**Setup credential** dropdown with both options (FCT-1676).

**OAuth2 (SDP, Microsoft or Google)**, the default for a new node: click **Connect to SDP** in the
node, then sign in to SDP with a password, a Microsoft or a Google account and approve. There is
nothing to fill in: the SDP address `https://n8n.safedatapath.eu`, PKCE, the public client `n8n` and
the empty client secret are all fixed. That is what makes n8n show its one-click button, on n8n Cloud
and self-hosted alike. For a local or test SDP, set the address on the n8n instance:

```
CREDENTIALS_OVERWRITE_DATA={"sdpOAuth2Api":{"baseUrl":"http://localhost:8081"}}
```

This needs the SDP OAuth2 server of FCT-1628. Until it ships, Connect opens the SDP trial entry flow
(`/trial?entry=n8n`), where the visitor signs in or creates an account, but no token comes back to n8n.

**API Key (Machine User)**: create an **SDP API** credential:

- **Base URL**: already set to `https://n8n.safedatapath.eu`. Change it only for another SDP instance (no trailing slash).
- **API Key**: an SDP machine-user token holding the `PIPELINE_INSERT` permission.

The key is sent as `Authorization: Bearer <apiKey>`.

The node is at version 2. Version 2 only moves the Authentication default to OAuth2. A node saved
as version 1, before the OAuth2 option existed, stays on API Key and keeps working unchanged.

## Operations

### Register Execution (auto-schema)

Hashes the data passing **through this node** and registers it as an SDP pipeline by calling
`POST /api/pipeline/register-from-execution`. On the first run for a given workflow, SDP auto-models
the pipeline schema (`wf-<workflowId>`); subsequent runs reuse it.

Parameters: Workflow ID (`{{ $workflow.id }}`), Workflow Name, Execution ID (`{{ $execution.id }}`),
Step Name, Step Type, Hash Algorithm (SHA-256 / SHA-512), Hash Encoding (Hex / Base64).

> **Capture scope:** a node placed in a workflow only sees the data that flows **through it**, not the
> output of every other node. For whole-workflow, zero-touch capture of every node's I/O, use SDP's
> server-side polling integration instead.

### Where to place the node, and how many

The node outputs a capture status, not the data it received. Put it on a **side branch**: a second wire
out of the node before it, never in line between two nodes, or the rest of the workflow gets the status
instead of its data.

**Several SDP nodes in one workflow** are fine (FCT-1652). Every run gives **one** product in SDP,
whatever the number of SDP nodes. Each SDP node that runs adds to it the files it fingerprints and its
callback URL, and each SDP node is a step of the product. A file fingerprinted by two SDP nodes counts
once. One SDP node at the end of each branch of an IF is a good pattern: whichever branch runs is
captured. An SDP node inside a sub-workflow adds its files to the sub-workflow's own product, linked
under the parent.

## Nothing arrives in SDP

The node only tells SDP which execution to capture. SDP then reads the execution back from n8n, so
SDP needs three things of its own. Check them in this order:

1. **The node is green in n8n.** A 401 or 403 on the node means the SDP API key of the credential is
   wrong or lacks `PIPELINE_INSERT`.
2. **SDP knows where n8n is.** On the SDP server, `sdp.n8n.base-url` must be the root address of this
   n8n instance, for example `https://n8n.example.com`, with no path. The address shown in the browser
   (`.../home/workflows`) does not work. When the key is not set at all, SDP calls the Factiven n8n
   test instance and logs a warning at each capture. SDP must be able to reach the address.
3. **SDP holds an n8n API key** for the tenant, saved on the SDP Secret page, and that key may read
   the executions and workflows of this n8n user.

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

## Publishing

Publishing is automated from the **repository-root** GitHub Actions workflow
(`.github/workflows/publish-n8n-node.yml`) and uses **npm provenance**, as required for n8n
verification since 2026-05-01. Tag a release as `n8n-nodes-sdp-v<version>` to trigger it.

## License

MIT
