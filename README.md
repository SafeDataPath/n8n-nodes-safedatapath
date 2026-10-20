# n8n-nodes-safedatapath

An [n8n](https://n8n.io) community node for [SafeDataPath](https://safedatapath.io). Add it to a workflow and
SafeDataPath records every run of that workflow as verifiable proof: which steps ran, in which order, with what
outcome, and a SHA-512 fingerprint of every file that reached the node. Anyone can later check that a record has
not been altered since.

- [Installation](#installation)
- [Credentials](#credentials)
- [Usage](#usage)
- [Example](#example)
- [Troubleshooting](#troubleshooting)
- [Compatibility](#compatibility)
- [Resources](#resources)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
in the n8n documentation, and install the package `n8n-nodes-safedatapath`.

## Credentials

The node's **Authentication** field offers two ways to sign in to SafeDataPath.

**OAuth2 (SafeDataPath, Microsoft or Google)** is the default. Click the connect button in the node, sign in to
SafeDataPath with a password, a Microsoft or a Google account, and approve. There is nothing to fill in. If you
have no SafeDataPath account yet, the same screen creates one.

**API Key (Machine User)** suits a self-hosted SafeDataPath or an automated setup. Create a **SafeDataPath API**
credential with:

- **Base URL**: the address of your SafeDataPath instance, without a trailing slash. Keep the default,
  `https://n8n.safedatapath.eu`, unless you were told otherwise.
- **API Key**: the API key of a SafeDataPath machine user that may register pipelines.

Click **Test** in the credential to check the key: it passes only if SafeDataPath would accept a capture with it.

## Usage

**Place the node first in your workflow**, right after the trigger. When it runs, it asks SafeDataPath to record
the run and passes its input items on unchanged, so the next nodes receive the trigger data as before.
SafeDataPath reads the run back from n8n once it ends: the record appears a few seconds after the run finishes,
including the steps that ran after the node.

Files that reach the node are fingerprinted with SHA-512. Only the fingerprints are sent; the files stay in n8n.

A workflow holds one SafeDataPath node: one run gives one record.

**The node never stops your workflow.** If SafeDataPath cannot be reached, the request is tried up to 3 times,
then the run carries on and the node's output panel says the run was not recorded. Only a manual run with a
missing or refused credential stops, so you see the cause while building the workflow.

## Example

1. Create a workflow with a **Webhook** trigger.
2. Add the **SafeDataPath** node right after it and connect it with OAuth2.
3. Add the rest of your workflow after the SafeDataPath node, for example an **HTTP Request** that downloads an
   invoice and a **Google Drive** node that stores it.
4. Activate the workflow and call the webhook.

A few seconds after the run ends, it appears in SafeDataPath with each step, its outcome, and the fingerprint of
the downloaded invoice.

## Troubleshooting

**The output panel says the run was not recorded.** The message gives the reason. `HTTP 401` or `HTTP 403` means
the credential's key is wrong, has no right to register pipelines, or n8n is not enabled for your SafeDataPath
account: click **Test** in the credential. A timeout means SafeDataPath could not be reached from your n8n.

**Nothing appears in SafeDataPath.** SafeDataPath reads the run back from n8n, so it needs an n8n API key for your
n8n instance. Save one on the Secret page in SafeDataPath, and make sure that key may read your workflows and
executions.

## Compatibility

Tested with n8n 2.31. Built with the [`@n8n/node-cli`](https://www.npmjs.com/package/@n8n/node-cli) toolchain.
The package has no runtime dependencies.

## Resources

- [SafeDataPath](https://safedatapath.io)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Development

```bash
npm install
npm run lint
npm run build
npm run dev    # starts a local n8n with this node loaded
```

Releases are published to npm by the `publish.yml` GitHub Actions workflow, with npm provenance, when a version
tag is pushed. Run `npm run release` to bump the version, tag and push.

## License

[MIT](LICENSE)
