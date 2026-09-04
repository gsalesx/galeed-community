/** M8/S1 — Router do console (createBrowserRouter; ARCHITECTURE §4).
 *
 *  Estrutura:
 *    públicas (sem shell):  / (→ /entrar)  ·  /entrar  ·  /criar-conta
 *    onboarding:             /comecar (→ /criar-cerebro, o wizard conversacional)
 *    console (AppShell):     /app, /app/*      (RequireAuth; /app/acesso idem)
 *    portal (shell slim):    /portal           (RequireAuth)
 *
 *  As telas (screens/<X>/index.tsx) vêm dos Devs S4–S11. O S1 já deixa cada rota
 *  apontando pro módulo via React.lazy. Os stubs mínimos já existem (export default
 *  → <EmConstrucao/>), então o import resolve e `vite build` passa; quando o Dev
 *  entrega a tela real, sobrescreve o arquivo e a rota passa a renderizá-la.
 *
 *  `lazyScreen(loader, nome)`: blinda o lazy — se o módulo falhar em carregar
 *  (ex. ainda não entregue / erro de chunk), renderiza <EmConstrucao nome/> em vez
 *  de derrubar a rota inteira.
 */
import { lazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Loading } from "../ui";
import { AppShell } from "./AppShell";
import { EmConstrucao } from "./GlobalStates";

type ScreenModule = { default: ComponentType };

/** Lazy blindado: erro de import vira <EmConstrucao/> (não quebra a rota). */
function lazyScreen(loader: () => Promise<ScreenModule>, nome: string) {
  return lazy(() =>
    loader().catch(() => ({ default: () => <EmConstrucao nome={nome} /> })),
  );
}

// --- telas (lazy) ---------------------------------------------------------
const Entrar = lazyScreen(() => import("../screens/Entrar/index"), "Entrar");
const CriarConta = lazyScreen(() => import("../screens/CriarConta/index"), "Criar conta");
const Painel = lazyScreen(() => import("../screens/Painel/index"), "Início");
const Buscar = lazyScreen(() => import("../screens/Buscar/index"), "Buscar");
const Perguntar = lazyScreen(() => import("../screens/Perguntar/index"), "Perguntar");
const Fatos = lazyScreen(() => import("../screens/Fatos/index"), "Fatos");
const Dossie = lazyScreen(() => import("../screens/Dossie/index"), "Dossiê");
const Adicionar = lazyScreen(() => import("../screens/Adicionar/index"), "Adicionar");
const Fontes = lazyScreen(() => import("../screens/Fontes/index"), "Fontes");
const Revisar = lazyScreen(() => import("../screens/Revisar/index"), "Revisar");
const CriarCerebro = lazyScreen(() => import("../screens/CriarCerebro/index"), "Criar cérebro");
const Acesso = lazyScreen(() => import("../screens/Acesso/index"), "Acesso");
const Conectar = lazyScreen(() => import("../screens/Conectar/index"), "Conectar");
const Saude = lazyScreen(() => import("../screens/Saude/index"), "Saúde");
const Ajustes = lazyScreen(() => import("../screens/Ajustes/index"), "Ajustes");
const Plano = lazyScreen(() => import("../screens/Plano/index"), "Plano & Créditos");
const Funcionario = lazyScreen(() => import("../screens/Funcionario/index"), "Portal");

// --- guard de auth --------------------------------------------------------
/** Exige sessão. loading → Skeleton; sem sessão → /entrar. */
function RequireAuth() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <Loading label="Carregando…" />
      </div>
    );
  }
  if (!session) return <Navigate to="/entrar" replace />;
  return <Outlet />;
}

/** Exige pelo menos 1 brain. Conta logada SEM nenhum cérebro → wizard conversacional. */
function RequireBrain() {
  const { session } = useAuth();
  if (session && session.brains.length === 0) return <Navigate to="/criar-cerebro" replace />;
  return <Outlet />;
}

/** Telas públicas montam fora do shell, com Suspense próprio (sem AppShell). */
function PublicScreen({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Loading label="Carregando…" style={{ margin: 40 }} />}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  // públicas (sem shell) — edição community: sem landing; a raiz é o login.
  { path: "/", element: <Navigate to="/entrar" replace /> },
  { path: "/entrar", element: <PublicScreen><Entrar /></PublicScreen> },
  { path: "/criar-conta", element: <PublicScreen><CriarConta /></PublicScreen> },

  // onboarding — o wizard conversacional assumiu o /comecar (rota antiga preservada).
  { path: "/comecar", element: <Navigate to="/criar-cerebro" replace /> },

  // protegidas
  {
    element: <RequireAuth />,
    children: [
      // onboarding + criação de cérebro (M21/S6) — chat conversacional; exige só sessão
      // (FORA do RequireBrain), sem AppShell: a tela tem topbar slim própria.
      { path: "/criar-cerebro", element: <PublicScreen><CriarCerebro /></PublicScreen> },

      // console — AppShell completo (exige ≥1 brain; sem brain → /criar-cerebro)
      {
        element: <RequireBrain />,
        children: [
        {
        path: "/app",
        element: <AppShell />,
        children: [
          { index: true, element: <Painel /> },
          { path: "buscar", element: <Buscar /> },
          { path: "perguntar", element: <Perguntar /> },
          { path: "fatos", element: <Fatos /> },
          // Dossiê: a página da ENTIDADE (decisões com porquê acima de números) — desenho do PO.
          { path: "dossie/:entity", element: <Dossie /> },
          { path: "adicionar", element: <Adicionar /> },
          { path: "fontes", element: <Fontes /> },
          { path: "revisar", element: <Revisar /> },
          { path: "acesso", element: <Acesso /> },
          { path: "conectar", element: <Conectar /> },
          { path: "saude", element: <Saude /> },
          { path: "ajustes", element: <Ajustes /> },
          { path: "plano", element: <Plano /> },
          // rotas removidas (ex.: /app/mapa) caem no painel em vez de página em branco.
          { path: "*", element: <Navigate to="/app" replace /> },
        ],
        },
        ],
      },

      // portal do funcionário — shell slim
      {
        element: <AppShell slim />,
        children: [{ path: "/portal", element: <Funcionario /> }],
      },
    ],
  },

  // fallback
  { path: "*", element: <Navigate to="/entrar" replace /> },
]);

export default router;
