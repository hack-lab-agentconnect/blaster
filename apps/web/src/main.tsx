import { ConvexProvider, ConvexReactClient } from "convex/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL?.trim();
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      {convexClient ? (
        <ConvexProvider client={convexClient}>
          <App />
        </ConvexProvider>
      ) : (
        <App />
      )}
    </BrowserRouter>
  </React.StrictMode>,
);
