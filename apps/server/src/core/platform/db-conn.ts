/** Conexão Postgres compartilhável para módulos DB-native que NÃO pertencem ao Engine por-tenant.
 *  Mesma postura do PostgresEngine: `prepare:false` (pooler Supabase, pgbouncer transaction mode),
 *  `ssl` por host, e fail-soft NO CHAMADOR (este módulo LANÇA se não houver DATABASE_URL — quem chama
 *  captura e degrada quando fizer sentido).
 *
 *  É uma FUNDAÇÃO de conexão: NÃO embute schema/DDL de nenhuma tabela. Cada consumidor ainda garante
 *  seu schema idempotente no boot lazy, espelhando migrations.ts. Tenant-neutro: a conexão não carrega
 *  `brain`; a query é que deve escopar por `brain` quando a tabela é tenant-scoped.
 *
 *  Regra arquitetural (ADR-013): módulos auxiliares como accounts, brain-context, schema-pack,
 *  ingest-queue e blob pointers usam esta pool. O Engine continua com sua própria conexão por tenant. */

let _sql: any | null = null;
let _generation = 0;

/** Abre (uma vez) a pool compartilhada. Lazy: só toca o driver na primeira chamada. LANÇA se não
 *  houver DATABASE_URL/GALEED_DB_URL/SUPABASE_DB_URL — o chamador degrada (fail-soft). */
export async function getSharedSql(): Promise<any> {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL || process.env.GALEED_DB_URL || process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("sem DATABASE_URL");
  const { default: postgres } = (await import("postgres")) as { default: any };
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  // sslmode=disable na URL desliga o TLS explicitamente — p/ Postgres em rede privada (Docker/k8s)
  // SEM TLS, onde o host não é "localhost" e o "require" abaixo resetaria o handshake.
  const noSsl = isLocal || /[?&]sslmode=disable(\b|$)/.test(url);
  // SSL: local/disable sem TLS; remoto VERIFICA o certificado (rejectUnauthorized) para impedir MITM —
  // "require" só cifra mas não valida a cadeia. Escape hatch p/ cert self-signed: DB_SSL_INSECURE=1
  // cai para "require" (cifra sem verificar).
  const remoteSsl = process.env.DB_SSL_INSECURE === "1" ? "require" : { rejectUnauthorized: true };
  _sql = postgres(url, {
    prepare: false, // compatível com o pooler do Supabase (pgbouncer transaction mode)
    max: 4,
    idle_timeout: 20,
    ssl: noSsl ? false : remoteSsl,
    onnotice: () => {},
  });
  return _sql;
}

/** Geração da pool compartilhada. Consumidores que mantêm schema lazy próprio usam isto para rerodar
 *  `create table if not exists` depois de `closeSharedSql()` abrir uma nova conexão no mesmo processo. */
export function sharedSqlGeneration(): number {
  return _generation;
}

/** Fecha a pool compartilhada (testes / shutdown). No-op se nunca abriu. */
export async function closeSharedSql(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 }).catch(() => {});
    _sql = null;
    _generation++;
  }
}
