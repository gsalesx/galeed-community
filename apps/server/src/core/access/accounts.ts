/** M8/S2 — CONTAS / SESSÃO / MEMBERSHIP (camada de auth do front, ACIMA dos principals do M7).
 *
 *  Estas tabelas são BRAIN-INDEPENDENTES: o login é cross-brain (uma conta vê N brains via
 *  galeed_account_brains). Por isso NÃO usam o engine por-tenant (`getEngine(brain)`); usam a pool
 *  compartilhada de platform/db-conn.ts, com queries sem `brain` onde a tabela é global.
 *
 *  - Conta: galeed_accounts (email único, senha hash scrypt).
 *  - Sessão: galeed_sessions (token_hash sha256; o cru só circula no cookie httpOnly).
 *  - Membership: galeed_account_brains (conta ↔ brain + papel owner/member).
 *
 *  Schema garantido pelas migrações 20/21/22 (migrations.ts) — aqui só rodamos um `create table
 *  if not exists` idempotente no boot lazy, pra não depender da ordem de execução do engine. */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { closeSharedSql, getSharedSql, sharedSqlGeneration } from "../platform/db-conn.ts";

// ---- tipos (ARCHITECTURE §6) ----
export interface Account {
  id: string;
  name: string;
  email: string;
}
export interface Brain {
  id: string;
  name: string;
  role: "owner" | "member";
}
export interface Session {
  account: Account;
  brains: Brain[];
  currentBrain: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

// ---------- schema lazy sobre a conexão compartilhada ----------

let _ready: Promise<void> | null = null;
let _readyGeneration = -1;

/** Garante o schema das tabelas de conta sobre a pool compartilhada. Lazy: só toca o banco
 *  quando a primeira operação de conta/sessão acontece — rotas sem DB (health, me-sem-cookie)
 *  nunca disparam isto. */
async function db(): Promise<any> {
  const sql = await getSharedSql();
  const gen = sharedSqlGeneration();
  if (_ready && _readyGeneration === gen) {
    await _ready;
    return sql;
  }
  _readyGeneration = gen;
  _ready = (async () => {
    await sql.unsafe(`
      create table if not exists galeed_accounts (
        id text primary key, name text, email text unique, pass_hash text,
        created_at timestamptz default now()
      );
      create table if not exists galeed_sessions (
        token_hash text primary key, account_id text,
        created_at timestamptz default now(), expires_at timestamptz
      );
      create table if not exists galeed_account_brains (
        account_id text, brain text, role text default 'owner',
        primary key (account_id, brain)
      );
    `);
  })();
  await _ready;
  return sql;
}

/** Fecha a conexão (testes / shutdown). No-op se nunca abriu. */
export async function closeAccounts(): Promise<void> {
  _ready = null;
  _readyGeneration = -1;
  await closeSharedSql();
}

// ---------- hashing de senha (scrypt, salt embutido) ----------

interface ScryptOpts {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOpts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, derived) => (err ? reject(err) : resolve(derived as Buffer)));
  });
}

/** Política de senha AUTORITATIVA no servidor (defesa contra bypass da rota — o front só checa
 *  mínimo 8). Pura: lança `Error('senha fraca: ...')` se não atender, ou retorna void. Sem dep nova. */
export function validatePasswordStrength(pw: string): void {
  const s = pw ?? "";
  if (s.length < 8) throw new Error("senha fraca: mínimo 8 caracteres");
  // checagem barata de senha trivial: tudo-igual ("aaaaaaaa") ou só dígitos curta
  if (/^(.)\1*$/.test(s)) throw new Error("senha fraca: não use caracteres repetidos");
  if (/^\d+$/.test(s) && s.length < 12) throw new Error("senha fraca: não use só números");
}

// Custo do scrypt: N=32768 (2× o default 16384 do Node), r=8, p=1. maxmem precisa caber
// N*r*128 com folga (32768*8*128 ≈ 32MiB) → 64MiB. Os parâmetros são GRAVADOS no hash, pra
// que verifyPassword saiba reproduzi-los (e pra permitir subir o custo no futuro sem quebrar).
const SCRYPT_OPTS: ScryptOpts = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// Defaults do Node assumidos por hashes legados de 3 partes (gravados sem parâmetros). maxmem
// suficiente pro N legado (16384) — mantido em 64MiB.
const SCRYPT_LEGACY_OPTS: ScryptOpts = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Hash de senha com scrypt. Formato: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` (parâmetros +
 *  salt embutidos). */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const o = SCRYPT_OPTS;
  const derived = await scryptAsync(pw, salt, 64, o);
  return `scrypt$${o.N}$${o.r}$${o.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Confere uma senha contra um hash scrypt em tempo constante. Suporta AMBOS os formatos:
 *  novo 5-partes `scrypt$N$r$p$salt$hash` (usa os N/r/p lidos) e antigo 3-partes
 *  `scrypt$salt$hash` (assume os defaults do Node). */
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  const parts = (hash || "").split("$");
  if (parts[0] !== "scrypt") return false;
  let opts: ScryptOpts;
  let saltHex: string;
  let hashHex: string;
  if (parts.length === 6) {
    // novo formato: scrypt$N$r$p$salt$hash
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0) {
      return false;
    }
    opts = { N, r, p, maxmem: 64 * 1024 * 1024 };
    saltHex = parts[4];
    hashHex = parts[5];
  } else if (parts.length === 3) {
    // legado: scrypt$salt$hash → defaults do Node
    opts = SCRYPT_LEGACY_OPTS;
    saltHex = parts[1];
    hashHex = parts[2];
  } else {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (!salt.length || !expected.length) return false;
  const derived = await scryptAsync(pw, salt, expected.length, opts);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------- tokens de sessão ----------

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------- contas ----------

function rowToAccount(r: any): Account {
  return { id: r.id, name: r.name || "", email: r.email || "" };
}

/** Cria uma conta (email único). Se `brainName`, cria também a membership owner desse brain.
 *  Lança se o email já existir. Retorna a conta criada. */
export async function createAccount(p: {
  name: string;
  email: string;
  password: string;
  brainName?: string;
}): Promise<Account> {
  const sql = await db();
  const email = p.email.trim().toLowerCase();
  if (!email) throw new Error("email obrigatório");
  if (!p.password) throw new Error("senha obrigatória");
  validatePasswordStrength(p.password); // ACHADO #4: política autoritativa no servidor (antes de hash/insert)
  const existing = (await sql`select id from galeed_accounts where email = ${email} limit 1`) as any[];
  if (existing.length) throw new Error("email já cadastrado");
  const brainName = (p.brainName ?? "").trim();
  // P0-B (mata C2): colisão de nome de brain = takeover de tenant. MESMO guard do wizard
  // (bff-wizard.ts). Checa ANTES do insert da conta — nada de conta órfã.
  if (brainName && (await brainExists(brainName))) {
    throw new Error("esse nome de cérebro já existe — escolha outro.");
  }
  const id = randomUUID();
  const passHash = await hashPassword(p.password);
  await sql`
    insert into galeed_accounts (id, name, email, pass_hash)
    values (${id}, ${p.name || ""}, ${email}, ${passHash})`;
  if (brainName) {
    try {
      await claimBrainSlug(id, brainName); // P1-C: fecha a janela do check-then-act
    } catch (err) {
      // perdeu a corrida DEPOIS do insert da conta: desfaz a conta (nada de conta órfã — P0-B)
      await sql`delete from galeed_accounts where id = ${id}`;
      throw err;
    }
  }
  return { id, name: p.name || "", email };
}

/** Conta por email (case-insensitive). Inclui o pass_hash p/ login. */
export async function accountByEmail(email: string): Promise<(Account & { passHash: string }) | null> {
  const sql = await db();
  const rows = (await sql`
    select id, name, email, pass_hash from galeed_accounts
    where email = ${email.trim().toLowerCase()} limit 1`) as any[];
  if (!rows.length) return null;
  return { ...rowToAccount(rows[0]), passHash: rows[0].pass_hash || "" };
}

/** Conta por id. */
export async function accountById(id: string): Promise<Account | null> {
  const sql = await db();
  const rows = (await sql`select id, name, email from galeed_accounts where id = ${id} limit 1`) as any[];
  return rows.length ? rowToAccount(rows[0]) : null;
}

// ---------- sessões ----------

/** Cria uma sessão p/ a conta. Gera um token CRU aleatório, persiste só o sha256, expira em 30d.
 *  Retorna o token CRU (vai pro cookie httpOnly; nunca persistido). */
export async function createSession(accountId: string): Promise<string> {
  const sql = await db();
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sql`
    insert into galeed_sessions (token_hash, account_id, expires_at)
    values (${tokenHash}, ${accountId}, ${expiresAt})`;
  return token;
}

/** Valida um token de sessão (hash + não expirado) → conta, ou null. */
export async function sessionAccount(token: string): Promise<Account | null> {
  if (!token) return null;
  const sql = await db();
  const tokenHash = sha256(token);
  const rows = (await sql`
    select a.id, a.name, a.email
    from galeed_sessions s
    join galeed_accounts a on a.id = s.account_id
    where s.token_hash = ${tokenHash}
      and (s.expires_at is null or s.expires_at > now())
    limit 1`) as any[];
  return rows.length ? rowToAccount(rows[0]) : null;
}

/** Destrói uma sessão (logout). No-op se o token não existir. */
export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  const sql = await db();
  await sql`delete from galeed_sessions where token_hash = ${sha256(token)}`;
}

// ---------- membership (conta ↔ brain) ----------

/** Brains de uma conta. `name` = id por enquanto (sem tabela de nome de brain ainda). */
export async function brainsOf(accountId: string): Promise<Brain[]> {
  const sql = await db();
  const rows = (await sql`
    select brain, role from galeed_account_brains
    where account_id = ${accountId} order by brain`) as any[];
  return rows.map((r) => ({
    id: r.brain,
    name: r.brain, // sem tabela de nome de brain ainda → name = id
    role: (r.role === "member" ? "member" : "owner") as Brain["role"],
  }));
}

/** M21/S4 — existe ALGUM membership pra esse brain (qualquer conta)? Colisão de slug = takeover de
 *  tenant; o wizard recusa com 409 ANTES de criar. */
export async function brainExists(brain: string): Promise<boolean> {
  const sql = await db();
  const rows = (await sql`select 1 from galeed_account_brains where brain = ${brain} limit 1`) as any[];
  return rows.length > 0;
}

/** Cria/atualiza a membership de uma conta num brain. */
export async function addBrainMembership(accountId: string, brain: string, role: "owner" | "member"): Promise<void> {
  const sql = await db();
  await sql`
    insert into galeed_account_brains (account_id, brain, role)
    values (${accountId}, ${brain}, ${role})
    on conflict (account_id, brain) do update set role = excluded.role`;
}

/** remove a participação de uma conta num brain (não apaga a conta global — só o membership). */
export async function removeBrainMembership(accountId: string, brain: string): Promise<void> {
  const sql = await db();
  await sql`delete from galeed_account_brains where account_id = ${accountId} and brain = ${brain}`;
}

/** P1-C (fecha o TOCTOU residual do P0-B/A9): criação ATÔMICA da posse de um brain. Advisory lock
 *  transacional por slug + check de existência + insert do owner na MESMA transação — dois claims
 *  concorrentes do mesmo slug: exatamente UM vence. UNIQUE(brain) não é viável (tabela é
 *  membership, N contas por brain). Colisão lança Error com a MESMA mensagem do wizard/P0-B. */
export async function claimBrainSlug(accountId: string, brain: string): Promise<void> {
  const sql = await db();
  await sql.begin(async (tx: any) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"galeed:brain:" + brain}))`;
    const rows = (await tx`select 1 from galeed_account_brains where brain = ${brain} limit 1`) as any[];
    if (rows.length) throw new Error("esse nome de cérebro já existe — escolha outro.");
    await tx`insert into galeed_account_brains (account_id, brain, role) values (${accountId}, ${brain}, 'owner')`;
  });
}

/** P1-C — compensação do confirm: desfaz a posse criada por claimBrainSlug quando um passo
 *  posterior falha (membership órfã bloquearia o slug pra sempre). Só remove a linha 'owner'
 *  da PRÓPRIA conta. */
export async function removeBrainOwnership(accountId: string, brain: string): Promise<void> {
  const sql = await db();
  await sql`delete from galeed_account_brains
            where account_id = ${accountId} and brain = ${brain} and role = 'owner'`;
}
