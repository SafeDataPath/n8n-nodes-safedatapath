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

Create an **SDP API** credential:

- **Base URL**: already set to `https://n8n.safedatapath.eu`. Change it only for another SDP instance (no trailing slash).
- **API Key** — an SDP machine-user token holding the `PIPELINE_INSERT` permission.

The key is sent as `Authorization: Bearer <apiKey>`.

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
