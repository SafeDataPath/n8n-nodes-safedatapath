import type {
	IAuthenticateGeneric,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

// TODO(FCT-1315): remove this disable and add a real credential `test` once SDP exposes a lightweight
// authenticated GET that an INSERT-only API key can call (read endpoints currently return 403 for such
// a key, which would make any test a false negative).
// eslint-disable-next-line @n8n/community-nodes/credential-test-required
export class SdpApi implements ICredentialType {
	name = 'sdpApi';

	displayName = 'SDP API';

	documentationUrl = 'https://safedatapath.io';

	icon: Icon = { light: 'file:sdp.light.svg', dark: 'file:sdp.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			// FCT-1571: the SDP instance n8n users connect to. Kept editable for a local or test SDP.
			default: 'https://n8n.safedatapath.eu',
			placeholder: 'https://n8n.safedatapath.eu',
			description: 'Root URL of the SDP instance, without a trailing slash. Keep the default unless told otherwise.',
			required: true,
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'SDP API key (machine-user token) holding the PIPELINE_INSERT permission',
			required: true,
		},
	];

	// The SDP Integration API authenticates with a Bearer token.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// TODO(FCT-1315): add a credential `test` once SDP exposes a lightweight authenticated GET that an
	// INSERT-only API key can call (a read endpoint currently returns 403 for such a key -> false
	// negative). The `credential-test-required` lint rule is disabled for this file until then.
}
