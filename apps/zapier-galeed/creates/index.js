/** As AÇÕES do Zapier (creates) — espelham os ingestores da /v1 e o /v1/ask.
 *  Cada perform é um POST simples; o Bearer entra pelo middleware (authentication.js). */
'use strict';

const url = (bundle, path) => `${String(bundle.authData.baseUrl).replace(/\/+$/, '')}${path}`;

/** POST JSON e devolve o corpo (o 202 dos ingestores já é um resumo útil pro Zap). */
const post = async (z, bundle, path, body) => {
	const response = await z.request({ method: 'POST', url: url(bundle, path), body });
	return response.data;
};

const ingerirTexto = {
	key: 'ingerir_texto',
	noun: 'Texto',
	display: {
		label: 'Ingerir Texto',
		description: 'Joga um texto (ata, e-mail, nota) na memória do cérebro.',
	},
	operation: {
		inputFields: [
			{ key: 'text', label: 'Texto', type: 'text', required: true },
			{ key: 'title', label: 'Título', type: 'string' },
			{ key: 'occurred_at', label: 'Data do evento (ISO)', type: 'string' },
			{ key: 'ref', label: 'Referência (dedupe)', type: 'string', helpText: 'Id estável do evento na origem — reenvio com a mesma ref não duplica.' },
		],
		perform: (z, bundle) => post(z, bundle, '/v1/ingestors/texto', bundle.inputData),
		sample: { status: 'organizing', ingestor: 'texto', recebidos: 1, enfileirados: 1, jobs: ['j-1'] },
	},
};

const mensagemDeChat = {
	key: 'mensagem_chat',
	noun: 'Mensagem',
	display: {
		label: 'Ingerir Mensagem de Chat',
		description: 'Canal de conversa (Instagram, Telegram, livechat…) — acumula na janela e ingere o diálogo inteiro.',
	},
	operation: {
		inputFields: [
			{ key: 'canal', label: 'Canal', type: 'string', required: true, helpText: 'Ex.: instagram, telegram, livechat.' },
			{ key: 'chat_id', label: 'ID do chat', type: 'string', required: true, helpText: 'Id estável da conversa na ferramenta.' },
			{ key: 'quem', label: 'Quem falou', type: 'string', required: true, helpText: 'Nome do contato — ou "Você" pra respostas suas.' },
			{ key: 'texto', label: 'Texto da mensagem', type: 'text', required: true },
			{ key: 'chat_label', label: 'Rótulo do chat', type: 'string', helpText: 'Ex.: Instagram — @beatriz.' },
			{ key: 'quando', label: 'Quando (ISO)', type: 'string' },
			{ key: 'ref', label: 'Referência (dedupe)', type: 'string' },
		],
		perform: (z, bundle) => post(z, bundle, '/v1/ingestors/chat', bundle.inputData),
		sample: { status: 'buffered', ingestor: 'chat', recebidos: 1, na_janela: 1 },
	},
};

const transcricaoDeReuniao = {
	key: 'transcricao_reuniao',
	noun: 'Reunião',
	display: {
		label: 'Ingerir Transcrição de Reunião',
		description: 'Transcrição de qualquer notetaker (Fireflies, tl;dv, MeetGeek…).',
	},
	operation: {
		inputFields: [
			{ key: 'title', label: 'Título da reunião', type: 'string', required: true },
			{ key: 'transcript', label: 'Transcrição', type: 'text', required: true },
			{ key: 'participants', label: 'Participantes', type: 'string', helpText: 'Separados por vírgula.' },
			{ key: 'occurred_at', label: 'Data/hora (ISO)', type: 'string' },
			{ key: 'ref', label: 'Referência (dedupe)', type: 'string', helpText: 'Ex.: o id da reunião no notetaker.' },
		],
		perform: (z, bundle) => post(z, bundle, '/v1/ingestors/notetaker', bundle.inputData),
		sample: { status: 'organizing', ingestor: 'notetaker', recebidos: 1, enfileirados: 1, jobs: ['j-1'] },
	},
};

const formularioLead = {
	key: 'formulario_lead',
	noun: 'Lead',
	display: {
		label: 'Ingerir Formulário/Lead',
		description: 'Submissão de formulário (site, Google Forms, Typeform) vira memória.',
	},
	operation: {
		inputFields: [
			{ key: 'formulario', label: 'Nome do formulário', type: 'string', required: true },
			{
				key: 'campos',
				label: 'Campos',
				dict: true,
				required: true,
				helpText: 'Pares campo → valor (ex.: Nome → João, Telefone → (47) 9...). Mapeie os campos do seu form aqui.',
			},
			{ key: 'ref', label: 'Referência (dedupe)', type: 'string' },
		],
		perform: (z, bundle) => post(z, bundle, '/v1/ingestors/formulario', bundle.inputData),
		sample: { status: 'organizing', ingestor: 'formulario', recebidos: 1, enfileirados: 1, jobs: ['j-1'] },
	},
};

const planilhaTabela = {
	key: 'planilha_tabela',
	noun: 'Tabela',
	display: {
		label: 'Ingerir Planilha/Tabela',
		description: 'Cada linha vira um fato carimbado na hora — sem IA. Preços, catálogo, comissões.',
	},
	operation: {
		inputFields: [
			{ key: 'titulo', label: 'Título da tabela', type: 'string', required: true },
			{ key: 'data', label: 'Data de vigência (YYYY-MM-DD)', type: 'string', helpText: 'A partir de quando os valores valem (bitemporal).' },
			{
				key: 'csv',
				label: 'CSV',
				type: 'text',
				required: true,
				helpText: 'Com cabeçalho: entidade,atributo,valor[,unidade,periodo,tier,data] — aceita ; do Excel BR. Dica: no Google Sheets, exporte o intervalo como CSV.',
			},
		],
		perform: (z, bundle) => post(z, bundle, '/v1/ingestors/planilha', bundle.inputData),
		sample: { status: 'organizing', ingestor: 'planilha', recebidos: 1, aplicados: 1, jobs: [] },
	},
};

const perguntar = {
	key: 'perguntar',
	noun: 'Resposta',
	display: {
		label: 'Perguntar ao Cérebro',
		description: 'Resposta sintetizada com fontes — mande pra onde quiser (WhatsApp, Slack, e-mail).',
	},
	operation: {
		inputFields: [
			{ key: 'question', label: 'Pergunta', type: 'text', required: true, helpText: 'Escreva como falaria com uma pessoa do time.' },
		],
		perform: (z, bundle) => post(z, bundle, '/v1/ask', { question: bundle.inputData.question }),
		sample: { answer: 'O pacote de 10 sessões custa R$ 1.500 [2].', facts: [], withheld: 0 },
	},
};

module.exports = { ingerirTexto, mensagemDeChat, transcricaoDeReuniao, formularioLead, planilhaTabela, perguntar };
