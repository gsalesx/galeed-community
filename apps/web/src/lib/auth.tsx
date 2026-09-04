/** M8/S3 — Contexto de autenticação + multi-tenant (sem libs externas; Context + hooks).
 *
 *  <AuthProvider> envolve o app (S1 monta em main.tsx). No mount chama api.auth.me():
 *    - sessão → guarda { account, brains, currentBrain } e seta o brain atual no cliente.
 *    - null   → loading vira false, session = null (telas públicas / redirect ficam a cargo do S1).
 *
 *  useAuth()  → { session, loading, login, signup, logout, refresh }
 *  useBrain() → { current, brains, switchBrain }
 *
 *  switchBrain(id): atualiza o currentBrain no cliente de api (setCurrentBrain) e re-renderiza;
 *  todas as chamadas de leitura subsequentes carregam ?brain=<id> automaticamente.
 *
 *  Escuta o evento global `galeed:unauthorized` (disparado pelo cliente em 401) → limpa a sessão.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, setCurrentBrain, UNAUTHORIZED_EVENT, type Brain, type Session } from "./api";

interface AuthValue {
  session: Session | null;
  loading: boolean;
  login: (p: { email: string; password: string }) => Promise<Session>;
  signup: (p: { name: string; email: string; password: string; brainName?: string }) => Promise<Session>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** troca o brain atual (atualiza o cliente de api + re-render). */
  switchBrain: (id: string) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // guarda a última sessão pra reconciliar o currentBrain sem depender do estado stale
  const sessionRef = useRef<Session | null>(null);

  /** Aplica uma sessão (ou null): sincroniza o brain atual do cliente e o estado. */
  const apply = useCallback((s: Session | null) => {
    sessionRef.current = s;
    setCurrentBrain(s?.currentBrain || "");
    setSession(s);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.auth.me();
      apply(s);
    } catch {
      apply(null);
    } finally {
      setLoading(false);
    }
  }, [apply]);

  // mount: resolve a sessão
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 401 global → derruba a sessão local
  useEffect(() => {
    const onUnauthorized = () => {
      apply(null);
      setLoading(false);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [apply]);

  const login = useCallback(
    async (p: { email: string; password: string }) => {
      const s = await api.auth.login(p);
      apply(s);
      setLoading(false);
      return s;
    },
    [apply],
  );

  const signup = useCallback(
    async (p: { name: string; email: string; password: string; brainName?: string }) => {
      const s = await api.auth.signup(p);
      apply(s);
      setLoading(false);
      return s;
    },
    [apply],
  );

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      apply(null);
    }
  }, [apply]);

  const switchBrain = useCallback((id: string) => {
    const s = sessionRef.current;
    if (!s || !s.brains.some((b) => b.id === id)) return;
    const next: Session = { ...s, currentBrain: id };
    sessionRef.current = next;
    setCurrentBrain(id);
    setSession(next);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ session, loading, login, signup, logout, refresh, switchBrain }),
    [session, loading, login, signup, logout, refresh, switchBrain],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuthContext(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth/useBrain devem ser usados dentro de <AuthProvider>");
  return ctx;
}

export function useAuth() {
  const { session, loading, login, signup, logout, refresh } = useAuthContext();
  return { session, loading, login, signup, logout, refresh };
}

export interface BrainContext {
  current: Brain | null;
  brains: Brain[];
  switchBrain: (id: string) => void;
}

export function useBrain(): BrainContext {
  const { session, switchBrain } = useAuthContext();
  const brains = session?.brains ?? [];
  const current = brains.find((b) => b.id === session?.currentBrain) ?? null;
  return { current, brains, switchBrain };
}
