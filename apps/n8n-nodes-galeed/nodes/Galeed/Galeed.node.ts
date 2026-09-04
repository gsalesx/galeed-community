/** Nó "Galeed" — estilo DECLARATIVO (o framework do n8n monta os HTTP requests pelo routing).
 *
 *  Recursos:
 *   - Memória:  Perguntar (POST /v1/ask) · Buscar fatos (GET /v1/facts)
 *   - Ingestão: texto · mensagem de chat (janela de conversa) · transcrição de reunião ·
 *               formulário/lead · planilha/tabela (fatos sem IA) · payload cru p/ um ingestor
 *
 *  A URL/token vêm da credencial Galeed API. Docs: INGESTORES.md e CASOS.md no repo. */
import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

export class Galeed implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Galeed',
		name: 'galeed',
		icon: 'file:galeed.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'A memória do seu negócio — ingerir conteúdo e perguntar com fonte',
		defaults: { name: 'Galeed' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'galeedApi', required: true }],
		requestDefaults: {
			baseURL: '={{ $credentials.baseUrl.replace(new RegExp("/+$"), "") }}',
			headers: { 'Content-Type': 'application/json' },
		},
		properties: [
			{
				displayName: 'Recurso',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Ingestão', value: 'ingestao', description: 'Jogar conteúdo pra dentro do cérebro' },
					{ name: 'Memória', value: 'memoria', description: 'Perguntar e consultar fatos' },
				],
				default: 'ingestao',
			},

			// ───────────────────────────── MEMÓRIA ─────────────────────────────
			{
				displayName: 'Operação',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['memoria'] } },
				options: [
					{
						name: 'Perguntar',
						value: 'perguntar',
						action: 'Perguntar ao cérebro',
						description: 'Resposta sintetizada com fontes (usa IA no servidor)',
						routing: { request: { method: 'POST', url: '/v1/ask' } },
					},
					{
						name: 'Buscar Fatos',
						value: 'fatos',
						action: 'Buscar fatos tipados',
						description: 'Série de fatos vigentes (sem IA)',
						routing: { request: { method: 'GET', url: '/v1/facts' } },
					},
				],
				default: 'perguntar',
			},
			{
				displayName: 'Pergunta',
				name: 'question',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Ex.: O que ficou combinado com a Acme?',
				displayOptions: { show: { resource: ['memoria'], operation: ['perguntar'] } },
				routing: { send: { type: 'body', property: 'question' } },
			},
			{
				displayName: 'Área',
				name: 'area',
				type: 'string',
				default: '',
				description: 'Filtra os fatos por área do cérebro (opcional)',
				displayOptions: { show: { resource: ['memoria'], operation: ['fatos'] } },
				routing: { send: { type: 'query', property: 'area' } },
			},
			{
				displayName: 'Limite',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['memoria'], operation: ['fatos'] } },
				routing: { send: { type: 'query', property: 'limit' } },
			},

			// ───────────────────────────── INGESTÃO ─────────────────────────────
			{
				displayName: 'Operação',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['ingestao'] } },
				options: [
					{
						name: 'Enviar Texto',
						value: 'texto',
						action: 'Enviar um texto',
						description: 'Qualquer texto vira memória (ata, e-mail, nota)',
						routing: { request: { method: 'POST', url: '/v1/ingestors/texto' } },
					},
					{
						name: 'Enviar Mensagem De Chat',
						value: 'chat',
						action: 'Enviar mensagem de chat',
						description: 'Canal de conversa — acumula na janela e ingere o diálogo inteiro',
						routing: { request: { method: 'POST', url: '/v1/ingestors/chat' } },
					},
					{
						name: 'Enviar Transcrição De Reunião',
						value: 'reuniao',
						action: 'Enviar transcrição de reunião',
						description: 'Transcrição de qualquer notetaker (Fireflies, tl;dv…)',
						routing: { request: { method: 'POST', url: '/v1/ingestors/notetaker' } },
					},
					{
						name: 'Enviar Formulário/Lead',
						value: 'formulario',
						action: 'Enviar formulário ou lead',
						description: 'Submissão de formulário (site, Google Forms, Typeform)',
						routing: { request: { method: 'POST', url: '/v1/ingestors/formulario' } },
					},
					{
						name: 'Enviar Planilha/Tabela',
						value: 'planilha',
						action: 'Enviar planilha ou tabela',
						description: 'Cada linha vira um fato carimbado na hora — sem IA',
						routing: { request: { method: 'POST', url: '/v1/ingestors/planilha' } },
					},
					{
						name: 'Enviar Payload Cru',
						value: 'cru',
						action: 'Enviar payload cru pra um ingestor',
						description: 'Escolhe o ingestor pelo slug e manda o JSON como veio',
						routing: {
							request: {
								method: 'POST',
								url: '=/v1/ingestors/{{ $parameter["slug"] }}',
								body: '={{ JSON.parse($parameter["payload"]) }}',
							},
						},
					},
				],
				default: 'texto',
			},

			// texto
			{
				displayName: 'Texto',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['ingestao'], operation: ['texto'] } },
				routing: { send: { type: 'body', property: 'text' } },
			},
			{
				displayName: 'Título',
				name: 'title',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['ingestao'], operation: ['texto'] } },
				routing: { send: { type: 'body', property: 'title' } },
			},

			// chat (janela de conversa)
			{
				displayName: 'Canal',
				name: 'canal',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Ex.: instagram, telegram, livechat',
				displayOptions: { show: { resource: ['ingestao'], operation: ['chat'] } },
				routing: { send: { type: 'body', property: 'canal' } },
			},
			{
				displayName: 'ID Do Chat',
				name: 'chatId',
				type: 'string',
				default: '',
				required: true,
				description: 'Id estável da conversa na ferramenta (agrupa a janela)',
				displayOptions: { show: { resource: ['ingestao'], operation: ['chat'] } },
				routing: { send: { type: 'body', property: 'chat_id' } },
			},
			{
				displayName: 'Quem Falou',
				name: 'quem',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Ex.: Beatriz — ou "Você" pra respostas suas',
				displayOptions: { show: { resource: ['ingestao'], operation: ['chat'] } },
				routing: { send: { type: 'body', property: 'quem' } },
			},
			{
				displayName: 'Texto Da Mensagem',
				name: 'textoMsg',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['ingestao'], operation: ['chat'] } },
				routing: { send: { type: 'body', property: 'texto' } },
			},
			{
				displayName: 'Rótulo Do Chat',
				name: 'chatLabel',
				type: 'string',
				default: '',
				placeholder: 'Ex.: Instagram — @beatriz',
				displayOptions: { show: { resource: ['ingestao'], operation: ['chat'] } },
				routing: { send: { type: 'body', property: 'chat_label' } },
			},

			// reunião
			{
				displayName: 'Título Da Reunião',
				name: 'meetingTitle',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['ingestao'], operation: ['reuniao'] } },
				routing: { send: { type: 'body', property: 'title' } },
			},
			{
				displayName: 'Transcrição',
				name: 'transcript',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['ingestao'], operation: ['reuniao'] } },
				routing: { send: { type: 'body', property: 'transcript' } },
			},
			{
				displayName: 'Participantes',
				name: 'participants',
				type: 'string',
				default: '',
				description: 'Separados por vírgula',
				displayOptions: { show: { resource: ['ingestao'], operation: ['reuniao'] } },
				routing: { send: { type: 'body', property: 'participants' } },
			},

			// formulário
			{
				displayName: 'Nome Do Formulário',
				name: 'formName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Ex.: Orçamento pelo site',
				displayOptions: { show: { resource: ['ingestao'], operation: ['formulario'] } },
				routing: { send: { type: 'body', property: 'formulario' } },
			},
			{
				displayName: 'Campos (JSON)',
				name: 'campos',
				type: 'json',
				default: '{}',
				required: true,
				description: 'Objeto {"Nome": "João", "Telefone": "..."} — mapeie os campos do seu form',
				displayOptions: { show: { resource: ['ingestao'], operation: ['formulario'] } },
				routing: {
					send: {
						type: 'body',
						property: 'campos',
						value: '={{ typeof $value === "string" ? JSON.parse($value) : $value }}',
					},
				},
			},

			// planilha
			{
				displayName: 'Título Da Tabela',
				name: 'tituloTabela',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Ex.: Tabela de preços — agosto',
				displayOptions: { show: { resource: ['ingestao'], operation: ['planilha'] } },
				routing: { send: { type: 'body', property: 'titulo' } },
			},
			{
				displayName: 'Linhas (JSON) Ou CSV',
				name: 'modoPlanilha',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Linhas (JSON)', value: 'linhas' },
					{ name: 'CSV', value: 'csv' },
				],
				default: 'linhas',
				displayOptions: { show: { resource: ['ingestao'], operation: ['planilha'] } },
			},
			{
				displayName: 'Linhas',
				name: 'linhas',
				type: 'json',
				default: '[{"entidade": "", "atributo": "preço", "valor": 0, "unidade": "BRL"}]',
				displayOptions: { show: { resource: ['ingestao'], operation: ['planilha'], modoPlanilha: ['linhas'] } },
				routing: {
					send: {
						type: 'body',
						property: 'linhas',
						value: '={{ typeof $value === "string" ? JSON.parse($value) : $value }}',
					},
				},
			},
			{
				displayName: 'CSV',
				name: 'csv',
				type: 'string',
				typeOptions: { rows: 5 },
				default: '',
				description: 'Com cabeçalho: entidade,atributo,valor[,unidade,periodo,tier,data] — aceita ; do Excel BR',
				displayOptions: { show: { resource: ['ingestao'], operation: ['planilha'], modoPlanilha: ['csv'] } },
				routing: { send: { type: 'body', property: 'csv' } },
			},

			// cru
			{
				displayName: 'Slug Do Ingestor',
				name: 'slug',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Ex.: evolution-whatsapp, chatwoot, meu-ingestor',
				displayOptions: { show: { resource: ['ingestao'], operation: ['cru'] } },
			},
			{
				displayName: 'Payload (JSON)',
				name: 'payload',
				type: 'json',
				default: '{}',
				required: true,
				displayOptions: { show: { resource: ['ingestao'], operation: ['cru'] } },
			},

			// comum à ingestão (opcional)
			{
				displayName: 'Referência (Dedupe)',
				name: 'ref',
				type: 'string',
				default: '',
				description: 'Id estável do evento na origem — reenvio com a mesma ref não duplica',
				displayOptions: { show: { resource: ['ingestao'], operation: ['texto', 'reuniao', 'formulario'] } },
				routing: { send: { type: 'body', property: 'ref' } },
			},
		],
	};
}
