/** M8/S1 — Entry do front. Monta <AuthProvider><RouterProvider/></AuthProvider>.
 *  O barrel de ui ("./ui") injeta tokens.css + base.css (fundação visual do S0). */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { router } from "./app/routes";
import { ErrorBoundary } from "./app/ErrorBoundary";
import "./ui";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="no aplicativo">
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
