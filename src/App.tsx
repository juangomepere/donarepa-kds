import { Navigate, Route, Routes } from 'react-router-dom';
import Login from './pages/Login';
import PosSim from './pages/PosSim';
import Kds from './pages/Kds';
import Monitor from './pages/Monitor';
import Track from './pages/Track';
import Admin from './pages/Admin';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/kds" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/pos-sim" element={<PosSim />} />
      <Route path="/kds" element={<Kds />} />
      <Route path="/monitor" element={<Monitor />} />
      <Route path="/t/:token" element={<Track />} />
      <Route path="/admin" element={<Admin />} />
    </Routes>
  );
}
