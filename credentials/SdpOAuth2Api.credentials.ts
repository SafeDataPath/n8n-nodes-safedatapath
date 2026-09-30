import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

// FCT-1676. Connect to SDP with OAuth2 (PKCE), the way HubSpot's OAuth2 credential works: the user only
// sees the SDP address, everything else is fixed. The SDP side (authorize and token endpoints, the public
// "n8n" client) is FCT-1628; until it ships, Connect opens /oauth/authorize and fails.
export class SdpOAuth2Api implements ICredentialType {
	name = 'sdpOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'SDP OAuth2 API';

	documentationUrl = 'https://safedatapath.io';

	icon: Icon = { light: 'file:sdp.light.svg', dark: 'file:sdp.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			// The SDP instance n8n users connect to. Kept editable for a local or test SDP.
			default: 'https://n8n.safedatapath.eu',
			placeholder: 'https://n8n.safedatapath.eu',
			description: 'Root URL of the SDP instance, without a trailing slash. Keep the default unless told otherwise.',
			required: true,
		},
		{
			displayName: 'Use Dynamic Client Registration',
			name: 'useDynamicClientRegistration',
			type: 'hidden',
			default: false,
		},
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'pkce',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: '={{$self["baseUrl"].replace(/\\/+$/, "")}}/oauth/authorize',
			required: true,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: '={{$self["baseUrl"].replace(/\\/+$/, "")}}/api/oauth2/token',
			required: true,
		},
		// A public PKCE client: n8n sends client_secret only when it is not empty.
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'hidden',
			default: 'n8n',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'hidden',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
	];
}
