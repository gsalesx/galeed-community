import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Front do galeed. Em dev, proxia /api e /auth → BFF do M8 (web-server.ts, porta 8789),
// pra rodar sem CORS e com o cookie de sessão (credentials:'include') funcionando.
const BFF = process.env.GALEED_BFF || "http://localhost:8789";
// API pública /v1 do gateway (mesma que o Caddy roteia em prod) — mesmo padrão do proxy do BFF,
// pra as URLs same-origin que a tela Conectar mostra funcionarem em dev também.
const GATEWAY = process.env.GALEED_GATEWAY || "http://localhost:8790";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BFF, changeOrigin: true },
      "/auth": { target: BFF, changeOrigin: true },
      "/v1": { target: GATEWAY, changeOrigin: true },
    },
  },
});
