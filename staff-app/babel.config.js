module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // expo-router v4 requires its babel transform for the route-tree
      // resolution metadata to be baked into the bundle. Without it,
      // <Slot/> / <Stack/> in app/_layout.tsx throw at first render
      // past the splash with no error boundary above to catch it.
      'expo-router/babel',
      // react-native-reanimated must be listed last
      'react-native-reanimated/plugin',
    ],
  };
};
