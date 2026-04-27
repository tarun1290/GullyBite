import type { ReactNode } from 'react';
import DashboardLayoutClient from './DashboardLayoutClient';
import { PwaInstallBanner } from '../../components/shared/PwaInstallBanner';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DashboardLayoutClient>{children}</DashboardLayoutClient>
      <PwaInstallBanner />
    </>
  );
}
