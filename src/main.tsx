import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "./styles/app-layout.css";
import "./styles/oxy-visual-hierarchy.css";
import { useThemeStore } from "./store/useThemeStore";
import { useUiVersionStore } from "./store/useUiVersionStore";

// React 渲染前同步一次主题到 DOM（与 index.html 内联脚本配合，确保无闪烁）
useThemeStore.getState().initTheme();
// 同步界面版本（经典版/Oxy Design System）到 <html data-ui-version>
// 控制器会自动处理 Oxy 下的亮色强制、UI 比例自动计算、监听器注册等
useUiVersionStore.getState().initUiVersion();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
