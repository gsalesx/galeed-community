/** /app/adicionar virou popup em Fontes. Links antigos caem aqui e abrem o modal. */
import { Navigate } from "react-router-dom";

export default function Adicionar() {
  return <Navigate to="/app/fontes?manual=1" replace />;
}
