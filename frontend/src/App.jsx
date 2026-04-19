import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { ToastProvider } from './components/Toast.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';

import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import NotFound from './pages/NotFound.jsx';

import DashboardLayout from './layouts/DashboardLayout.jsx';
import AdminLayout from './layouts/AdminLayout.jsx';

import OverviewTab from './pages/dashboard/OverviewTab.jsx';
import OrdersTab from './pages/dashboard/OrdersTab.jsx';
import MenuTab from './pages/dashboard/MenuTab.jsx';
import MessagesTab from './pages/dashboard/MessagesTab.jsx';
import MarketingTab from './pages/dashboard/MarketingTab.jsx';
import AnalyticsTab from './pages/dashboard/AnalyticsTab.jsx';
import PaymentsTab from './pages/dashboard/PaymentsTab.jsx';
import SettingsTab from './pages/dashboard/SettingsTab.jsx';
import RestaurantTab from './pages/dashboard/RestaurantTab.jsx';

import AdminFlows from './pages/admin/AdminFlows.jsx';
import AdminTemplates from './pages/admin/AdminTemplates.jsx';
import AdminRestaurants from './pages/admin/AdminRestaurants.jsx';
import AdminPincodes from './pages/admin/AdminPincodes.jsx';

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />

            <Route
              path="/dashboard"
              element={
                <ProtectedRoute role="restaurant">
                  <DashboardLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<OverviewTab />} />
              <Route path="orders" element={<OrdersTab />} />
              <Route path="menu" element={<MenuTab />} />
              <Route path="messages" element={<MessagesTab />} />
              <Route path="marketing" element={<MarketingTab />} />
              <Route path="analytics" element={<AnalyticsTab />} />
              <Route path="payments" element={<PaymentsTab />} />
              <Route path="settings" element={<SettingsTab />} />
              <Route path="restaurant" element={<RestaurantTab />} />
            </Route>

            <Route
              path="/admin"
              element={
                <ProtectedRoute role="admin">
                  <AdminLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="flows" replace />} />
              <Route path="flows" element={<AdminFlows />} />
              <Route path="templates" element={<AdminTemplates />} />
              <Route path="restaurants" element={<AdminRestaurants />} />
              <Route path="pincodes" element={<AdminPincodes />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
