/** Credencial "Galeed API" — origem do seu Galeed + chave gld_ (Bearer).
 *  O teste da credencial lista os ingestores (GET /v1/ingestors, autenticado). */
import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class GaleedApi implements ICredentialType {
	name = 'galeedApi';

	displayName = 'Galeed API';

	documentationUrl = 'https://github.com/a360-business/galeed-community/blob/main/INGESTORES.md';

	properties: INodeProperties[] = [
		{
			displayName: 'URL do Galeed',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://galeed.suaempresa.com',
			description:
				'A origem do seu Galeed, sem /v1 no fim. No Docker é o mesmo endereço do painel; em dev local, http://localhost:8790.',
			required: true,
		},
		{
			displayName: 'Chave da API (gld_...)',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Gere no painel em Conectar → chaves do cérebro. Pra ingerir, a chave precisa da capacidade can_ingest.',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(new RegExp("/+$"), "")}}',
			url: '/v1/ingestors',
		},
	};
}
