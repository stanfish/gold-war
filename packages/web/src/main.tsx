import { createRoot } from 'react-dom/client';
import { GodPage } from './GodPage';
import { PlayerPage } from './PlayerPage';
import { SetupPage } from './SetupPage';
import './style.css';

function App() {
  const path = location.pathname.replace(/\/+$/, '');
  const k = new URLSearchParams(location.search).get('k');
  if (path === '/player1') return <PlayerPage seat="p1" k={k} />;
  if (path === '/player2') return <PlayerPage seat="p2" k={k} />;
  if (path === '/god') return <GodPage k={k} />;
  return <SetupPage />;
}

createRoot(document.getElementById('root')!).render(<App />);
