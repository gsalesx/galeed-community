/** Perguntar + Buscar na mesma rota. Toggle só troca a UI; as APIs continuam separadas. */
import { useSearchParams } from "react-router-dom";
import { Chip } from "../../ui";
import Buscar from "../Buscar/index";
import Perguntar from "./index";

type Modo = "perguntar" | "buscar";

function modoFromParams(params: URLSearchParams): Modo {
  return params.get("modo") === "buscar" ? "buscar" : "perguntar";
}

export default function PerguntarUnificado() {
  const [params, setParams] = useSearchParams();
  const modo = modoFromParams(params);

  function setModo(next: Modo) {
    if (next === modo) return;
    const n = new URLSearchParams(params);
    if (next === "buscar") n.set("modo", "buscar");
    else n.delete("modo");
    setParams(n, { replace: true });
  }

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-.025em", margin: 0 }}>
          Encontrar
        </h1>
      </header>
      <div
        role="group"
        aria-label="Modo de encontrar"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}
      >
        <Chip
          active={modo === "perguntar"}
          onToggle={() => setModo("perguntar")}
        >
          Perguntar ao agente
        </Chip>
        <Chip
          active={modo === "buscar"}
          onToggle={() => setModo("buscar")}
        >
          Somente pesquisar nos arquivos
        </Chip>
      </div>
      {modo === "buscar" ? <Buscar /> : <Perguntar />}
    </div>
  );
}
