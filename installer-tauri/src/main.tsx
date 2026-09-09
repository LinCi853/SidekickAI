// installer-tauri/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import './api' // 先注入 window.installer（Tauri invoke 桥接）
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
