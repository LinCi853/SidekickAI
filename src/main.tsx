import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import "./styles/globals.css";
import "./styles/app-layout.css";
import "./styles/oxy-visual-hierarchy.css";
import { useThemeStore } from "./store/useThemeStore";
import { useUiVersionStore } from "./store/useUiVersionStore";
import { getInitialWindowTitle } from "./lib/window-title";

const windowQuery = new URLSearchParams(window.location.search);
document.title = getInitialWindowTitle(windowQuery.get('mode'), windowQuery.get('windowId') ?? 'main');

// 全局兜底：异步未捕获异常至少留下日志（渲染期错误由 ErrorBoundary 捕获）
window.addEventListener('error', (event) => {
  console.error('[global] Uncaught error:', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[global] Unhandled rejection:', event.reason);
});

// React 渲染前同步一次主题到 DOM（与 index.html 内联脚本配合，确保无闪烁）
useThemeStore.getState().initTheme();
// 同步界面版本（经典版/Oxy Design System）到 <html data-ui-version>
// 控制器会自动处理 Oxy 下的亮色强制、UI 比例自动计算、监听器注册等
useUiVersionStore.getState().initUiVersion();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
