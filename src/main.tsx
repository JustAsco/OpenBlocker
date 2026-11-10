import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { StoreProvider } from "./lib/store";
import { FreezeScreen } from "./pages/FreezeScreen";

// Freeze windows load `index.html#freeze`.
const isFreezeWindow = window.location.hash === "#freeze";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StoreProvider>{isFreezeWindow ? <FreezeScreen /> : <App />}</StoreProvider>
  </React.StrictMode>,
);
