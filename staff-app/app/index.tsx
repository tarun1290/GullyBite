import { Redirect } from 'expo-router';

// `/` just defers to the guard in _layout.tsx, which will re-route
// based on whether a valid staff token is present in SecureStore.
export default function Index() {
  return <Redirect href="/login" />;
}
