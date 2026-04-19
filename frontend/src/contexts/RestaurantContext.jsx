import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getRestaurantProfile } from '../api/restaurant.js';

const RestaurantContext = createContext(null);

export function RestaurantProvider({ children }) {
  const [restaurant, setRestaurant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getRestaurantProfile();
      setRestaurant(data || null);
    } catch (err) {
      setError(err?.userMessage || err?.message || 'Could not load restaurant profile');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  const value = {
    restaurant,
    loading,
    error,
    refetch: fetchProfile,
  };

  return <RestaurantContext.Provider value={value}>{children}</RestaurantContext.Provider>;
}

export function useRestaurant() {
  const ctx = useContext(RestaurantContext);
  if (!ctx) {
    throw new Error('useRestaurant must be used within a RestaurantProvider');
  }
  return ctx;
}

export default RestaurantContext;
