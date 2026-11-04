import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ConnectionService } from './hybrid/connection';
import './styles.css';
const connection = new ConnectionService(
  import.meta.env.VITE_API_BASE_URL ?? 'https://unconfigured.invalid',
  import.meta.env.VITE_API_DEPLOYMENT_ID ?? '',
  import.meta.env.DEV,
);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App connection={connection} />
  </React.StrictMode>,
);
