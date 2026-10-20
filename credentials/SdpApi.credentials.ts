import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class SdpApi implements ICredentialType {
	name = 'sdpApi';

	displayName = 'SafeDataPath API';

	documentationUrl = 'https://safedatapath.io';

	// Same logo as the node, so the Connect button and the credential page show SDP's own mark.
	icon: Icon = { light: 'file:SDP_LOGO.png', dark: 'file:sdp_logo_2.png' };

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			// FCT-1571: the SDP instance n8n users connect to. Kept editable for a local or test SDP.
			default: 'https://n8n.safedatapath.eu',
			placeholder: 'https://n8n.safedatapath.eu',
			description: 'Root URL of the SafeDataPath instance, without a trailing slash. Keep the default unless told otherwise.',
			required: true,
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'SafeDataPath API key (machine-user token) holding the PIPELINE_INSERT permission',
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

	// FCT-1651: the capture's own checks, so a key that passes the test is one the capture accepts.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/api/n8n/credential-check',
		},
	};
}
