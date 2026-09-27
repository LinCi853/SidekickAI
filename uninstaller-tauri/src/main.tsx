import React from 'react'
import ReactDOM from 'react-dom/client'
import UninstallPage from '../../installer-shared/uninstall/UninstallPage'
import '../../installer-shared/uninstall/styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UninstallPage entry="standalone" />
  </React.StrictMode>,
)
