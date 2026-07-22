import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { useThemeStore } from "./store/useThemeStore";

// React 渲染前同步一次主题到 DOM（与 index.html 内联脚本配合，确保无闪烁）
useThemeStore.getState().initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
