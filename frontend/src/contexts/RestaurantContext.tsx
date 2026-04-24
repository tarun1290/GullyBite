'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { getRestaurantProfile } from '../api/restaurant';
import type { Restaurant } from '../types';

interface RestaurantContextValue {
  restaurant: Restaurant | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const RestaurantContext = createContext<RestaurantContextValue | null>(null);

export function RestaurantProvider({ children }: { children: ReactNode }) {
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getRestaurantProfile();
      setRestaurant(data || null);
    } catch (err) {
      const e = err as { userMessage?: string; message?: string };
      setError(e?.userMessage || e?.message || 'Could not load restaurant profile');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  const value: RestaurantContextValue = {
    restaurant,
    loading,
    error,
    refetch: fetchProfile,
  };

  return <RestaurantContext.Provider value={value}>{children}</RestaurantContext.Provider>;
}

export function useRestaurant(): RestaurantContextValue {
  const ctx = useContext(RestaurantContext);
  if (!ctx) {
    throw new Error('useRestaurant must be used within a RestaurantProvider');
  }
  return ctx;
}

export default RestaurantContext;
