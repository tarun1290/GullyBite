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
import RatingsTab from './pages/dashboard/RatingsTab.jsx';
import FeedbackTab from './pages/dashboard/FeedbackTab.jsx';
import LoyaltyTab from './pages/dashboard/LoyaltyTab.jsx';
import CustomersTab from './pages/dashboard/CustomersTab.jsx';
import CampaignsTab from './pages/dashboard/CampaignsTab.jsx';
import PaymentsTab from './pages/dashboard/PaymentsTab.jsx';
import SettingsTab from './pages/dashboard/SettingsTab.jsx';
import RestaurantTab from './pages/dashboard/RestaurantTab.jsx';
import MarketingAnalyticsTab from './pages/dashboard/MarketingAnalyticsTab.jsx';

import AdminFlows from './pages/admin/AdminFlows.jsx';
import AdminTemplates from './pages/admin/AdminTemplates.jsx';
import AdminCampaignTemplates from './pages/admin/AdminCampaignTemplates.jsx';
import AdminApplications from './pages/admin/AdminApplications.jsx';
import AdminRestaurants from './pages/admin/AdminRestaurants.jsx';
import AdminDirectory from './pages/admin/AdminDirectory.jsx';
import AdminOrders from './pages/admin/AdminOrders.jsx';
import AdminCustomers from './pages/admin/AdminCustomers.jsx';
import AdminIssues from './pages/admin/AdminIssues.jsx';
import AdminReferrals from './pages/admin/AdminReferrals.jsx';
import AdminPincodes from './pages/admin/AdminPincodes.jsx';
import AdminSettlements from './pages/admin/AdminSettlements.jsx';
import AdminFinancials from './pages/admin/AdminFinancials.jsx';
import AdminCoupons from './pages/admin/AdminCoupons.jsx';
import AdminCouponCodes from './pages/admin/AdminCouponCodes.jsx';
import AdminMarketing from './pages/admin/AdminMarketing.jsx';
import AdminAnalytics from './pages/admin/AdminAnalytics.jsx';
import AdminLogs from './pages/admin/AdminLogs.jsx';
import AdminDlq from './pages/admin/AdminDlq.jsx';
import AdminSyncLogs from './pages/admin/AdminSyncLogs.jsx';
import AdminActivity from './pages/admin/AdminActivity.jsx';
import AdminAbuse from './pages/admin/AdminAbuse.jsx';
import AdminAdmins from './pages/admin/AdminAdmins.jsx';
import AdminUsernames from './pages/admin/AdminUsernames.jsx';
import AdminLogistics from './pages/admin/AdminLogistics.jsx';
import AdminOverview from './pages/admin/AdminOverview.jsx';
import AdminFestivals from './pages/admin/AdminFestivals.jsx';
import AdminPlatformAnalytics from './pages/admin/AdminPlatformAnalytics.jsx';

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
              <Route path="marketing-analytics" element={<MarketingAnalyticsTab />} />
              <Route path="ratings" element={<RatingsTab />} />
              <Route path="feedback" element={<FeedbackTab />} />
              <Route path="loyalty" element={<LoyaltyTab />} />
              <Route path="customers" element={<CustomersTab />} />
              <Route path="campaigns" element={<CampaignsTab />} />
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
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<AdminOverview />} />
              <Route path="flows" element={<AdminFlows />} />
              <Route path="templates" element={<AdminTemplates />} />
              <Route path="campaign-templates" element={<AdminCampaignTemplates />} />
              <Route path="applications" element={<AdminApplications />} />
              <Route path="restaurants" element={<AdminRestaurants />} />
              <Route path="directory" element={<AdminDirectory />} />
              <Route path="orders" element={<AdminOrders />} />
              <Route path="customers" element={<AdminCustomers />} />
              <Route path="issues" element={<AdminIssues />} />
              <Route path="referrals" element={<AdminReferrals />} />
              <Route path="pincodes" element={<AdminPincodes />} />
              <Route path="settlements" element={<AdminSettlements />} />
              <Route path="financials" element={<AdminFinancials />} />
              <Route path="coupons" element={<AdminCoupons />} />
              <Route path="coupon-codes" element={<AdminCouponCodes />} />
              <Route path="marketing" element={<AdminMarketing />} />
              <Route path="analytics" element={<AdminAnalytics />} />
              <Route path="logs" element={<AdminLogs />} />
              <Route path="dlq" element={<AdminDlq />} />
              <Route path="sync-logs" element={<AdminSyncLogs />} />
              <Route path="activity" element={<AdminActivity />} />
              <Route path="abuse" element={<AdminAbuse />} />
              <Route path="admins" element={<AdminAdmins />} />
              <Route path="usernames" element={<AdminUsernames />} />
              <Route path="logistics" element={<AdminLogistics />} />
              <Route path="festivals" element={<AdminFestivals />} />
              <Route path="platform-marketing" element={<AdminPlatformAnalytics />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
