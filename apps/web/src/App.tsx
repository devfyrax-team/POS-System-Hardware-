import { Navigate, Route, Routes } from 'react-router-dom';
import { Toasts } from './ui';
import { RequireAdmin, RequireShop } from './session';
import { AdminLogin, Home, Login, TillPicker } from './pages/Login';
import { BackOffice } from './pages/BackOffice';
import { Pos } from './pages/Pos';
import { AdminShell } from './pages/Admin';

export default function App() {
  return (
    <>
      <Toasts />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/" element={<RequireShop><Home /></RequireShop>} />
        <Route path="/till" element={<RequireShop><TillPicker /></RequireShop>} />
        <Route path="/pos" element={<RequireShop><Pos /></RequireShop>} />
        <Route path="/app/*" element={<RequireShop><BackOffice /></RequireShop>} />
        <Route path="/admin/*" element={<RequireAdmin><AdminShell /></RequireAdmin>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
