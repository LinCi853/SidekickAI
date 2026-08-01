// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
var __electron_vite_injected_dirname = "E:\\Oniroixs\\apps\\SidekickAI";
var electron_vite_config_default = defineConfig({
  main: {
    // 主进程入口（Electron Main Process）
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "electron/main.ts")
        }
      }
    },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@main": resolve(__electron_vite_injected_dirname, "electron"),
        "@shared": resolve(__electron_vite_injected_dirname, "electron/shared")
      }
    }
  },
  preload: {
    // Preload 脚本入口（contextBridge 暴露 API 到渲染进程）
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "electron/preload.ts"),
          webview: resolve(__electron_vite_injected_dirname, "electron/webview-preload.ts")
        }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // 渲染进程（React UI），复用现有 src/ 目录
    root: "src",
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/index.html")
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__electron_vite_injected_dirname, "src"),
        "@components": resolve(__electron_vite_injected_dirname, "src/components"),
        "@hooks": resolve(__electron_vite_injected_dirname, "src/hooks"),
        "@lib": resolve(__electron_vite_injected_dirname, "src/lib"),
        "@store": resolve(__electron_vite_injected_dirname, "src/store"),
        "@styles": resolve(__electron_vite_injected_dirname, "src/styles")
      }
    },
    server: {
      port: 5173
    }
  }
});
export {
  electron_vite_config_default as default
};
