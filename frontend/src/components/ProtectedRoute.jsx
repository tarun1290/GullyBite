import { Navigate, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from './Toast.jsx';

export default function ProtectedRoute({ children, role, redirectTo = '/' }) {
  const { isAuthenticated, loading, user } = useAuth();
  const { showToast } = useToast();
  const location = useLocation();
  const warnedRef = useRef(false);

  const roleMismatch = role && user && user.role !== role;

  useEffect(() => {
    if (roleMismatch && !warnedRef.current) {
      warnedRef.current = true;
      showToast('Access denied', 'error');
    }
  }, [roleMismatch, showToast]);

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span className="spin" aria-label="Loading" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to={redirectTo} replace state={{ from: location }} />;
  }

  if (roleMismatch) {
    return <Navigate to={redirectTo} replace />;
  }

  return children;
}
