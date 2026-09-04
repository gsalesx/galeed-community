/** M11/S3 — OBJECT STORAGE do ORIGINAL VERBATIM (ADR-005). A regra de ferro: a fonte crua, imutável,
 *  é a evidência. Chave lógica = (brain, content_hash) — o hash É o conteúdo, então `put` é idempotente
 *  e NUNCA sobrescreve. Adapter pattern (ADR-005-D1): dev = filesystem; prod = Supabase Storage. O core
 *  nunca importa SDK de vendor fora da impl supabase (import dinâmico). Tenant-neutro: blob por `brain`. */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** Metadados de proveniência gravados junto do blob (= o "de onde veio"). */
export interface BlobMeta {
  mime: string; // content-type original ("application/pdf", "text/plain", …)
  filename: string; // nome original do arquivo ("" se colado)
  source: string; // canal/origem ("upload", "paste", "notetaker", …)
}

/** Object storage do original verbatim. Chave lógica = (brain, content_hash). Adapter pattern:
 *  dev = filesystem; prod = Supabase Storage. O core nunca importa SDK de vendor fora da impl supabase. */
export interface BlobStore {
  /** grava o buffer sob (brain, hash). Idempotente: se o hash já existe, NÃO regrava (hash é o conteúdo). */
  put(brain: string, hash: string, buf: Buffer, meta: BlobMeta): Promise<{ key: string }>;
  /** lê o buffer; null se não existe. */
  get(brain: string, hash: string): Promise<Buffer | null>;
  exists(brain: string, hash: string): Promise<boolean>;
  /** chave de armazenamento (path no fs / object key no supabase). Determinística. */
  keyFor(brain: string, hash: string): string;
}

const HEX16 = /^[0-9a-f]{8,64}$/i; // o ingest usa sha256.slice(0,16) — aceita 8..64 hex

function safeBrain(brain: string): string {
  return brain.replace(/[^a-zA-Z0-9_-]/g, "_"); // path-safe; brains do Galeed já são slugs
}
function assertHash(hash: string): void {
  if (!HEX16.test(hash)) throw new Error("blob hash inválido");
}

export class FsBlobStore implements BlobStore {
  constructor(private rootDir = process.env.GALEED_BLOB_DIR || ".galeed-blobs") {}
  keyFor(brain: string, hash: string): string {
    assertHash(hash);
    return join(safeBrain(brain), hash);
  }
  private abs(brain: string, hash: string): string {
    const root = resolve(this.rootDir);
    const p = resolve(root, this.keyFor(brain, hash));
    if (p !== root && !p.startsWith(root + sep)) throw new Error("path traversal");
    return p;
  }
  async exists(brain: string, hash: string): Promise<boolean> {
    try {
      return (await stat(this.abs(brain, hash))).isFile();
    } catch {
      return false;
    }
  }
  async put(brain: string, hash: string, buf: Buffer, _meta: BlobMeta): Promise<{ key: string }> {
    const key = this.keyFor(brain, hash);
    const p = this.abs(brain, hash);
    if (await this.exists(brain, hash)) return { key }; // idempotente — hash é o conteúdo
    // PII em repouso: aqui só restringimos PERMISSÕES no dev (dir 0o700 / arquivo 0o600) p/ não ficar
    // world-readable na box. A cifra em repouso DE VERDADE é do adapter de PROD (SupabaseBlobStore /
    // object storage cifrado), não deste filesystem.
    await mkdir(resolve(this.rootDir, safeBrain(brain)), { recursive: true, mode: 0o700 });
    await writeFile(p, buf, { mode: 0o600 });
    return { key };
  }
  async get(brain: string, hash: string): Promise<Buffer | null> {
    try {
      return await readFile(this.abs(brain, hash));
    } catch {
      return null;
    }
  }
}

/** Prod (Supabase Storage). v1 = stub que só funciona com SUPABASE_URL/SUPABASE_SERVICE_KEY setadas.
 *  Importa o SDK DINAMICAMENTE (import() dentro dos métodos) p/ não criar dep no dev. Se faltar env,
 *  lança "supabase blob não configurado" — o getBlobStore() só o escolhe quando GALEED_BLOB_DRIVER=supabase. */
export class SupabaseBlobStore implements BlobStore {
  private bucket = process.env.GALEED_BLOB_BUCKET || "galeed-blobs";

  keyFor(brain: string, hash: string): string {
    assertHash(hash);
    return `${safeBrain(brain)}/${hash}`;
  }

  /** Cliente Supabase carregado DINAMICAMENTE — o SDK nunca é dep obrigatória do dev. Lança se faltar env. */
  private async client(): Promise<any> {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("supabase blob não configurado — defina SUPABASE_URL/SUPABASE_SERVICE_KEY");
    }
    // @ts-ignore — SDK opcional de vendor (adapter pattern ADR-005-D1): NÃO é dep do dev; só resolve
    // em prod quando GALEED_BLOB_DRIVER=supabase e o pacote está instalado. Import dinâmico de propósito.
    const { createClient } = (await import("@supabase/supabase-js")) as { createClient: any };
    return createClient(url, key);
  }

  async put(brain: string, hash: string, buf: Buffer, meta: BlobMeta): Promise<{ key: string }> {
    const key = this.keyFor(brain, hash);
    const sb = await this.client();
    // upsert:false → idempotente: se o objeto já existe, ignoramos o "already exists" (hash é o conteúdo).
    const { error } = await sb.storage.from(this.bucket).upload(key, buf, {
      contentType: meta.mime || "application/octet-stream",
      upsert: false,
    });
    if (error && !/exists/i.test(String(error.message || error))) throw error;
    return { key };
  }

  async get(brain: string, hash: string): Promise<Buffer | null> {
    const key = this.keyFor(brain, hash);
    const sb = await this.client();
    const { data, error } = await sb.storage.from(this.bucket).download(key);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  async exists(brain: string, hash: string): Promise<boolean> {
    return (await this.get(brain, hash)) !== null;
  }
}

let _store: BlobStore | null = null;
/** Singleton do store, escolhido por env. Default = filesystem (dev/HTC). */
export function getBlobStore(): BlobStore {
  if (_store) return _store;
  _store = process.env.GALEED_BLOB_DRIVER === "supabase" ? new SupabaseBlobStore() : new FsBlobStore();
  return _store;
}

/** Reseta o singleton (testes). No-op em prod. */
export function resetBlobStore(): void {
  _store = null;
}
