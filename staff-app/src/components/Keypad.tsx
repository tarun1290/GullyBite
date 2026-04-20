// Custom numeric keypad used by the PIN login screen. 3×3 digit grid,
// then 0-centre + backspace-right on the bottom row. No system keyboard.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/theme';

type Props = {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  disabled?: boolean;
};

const ROWS: Array<Array<string | 'blank' | 'back'>> = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['blank', '0', 'back'],
];

export function Keypad({ onDigit, onBackspace, disabled }: Props) {
  return (
    <View style={styles.wrap}>
      {ROWS.map((row, ri) => (
        <View key={ri} style={styles.row}>
          {row.map((cell, ci) => {
            if (cell === 'blank') {
              return <View key={ci} style={styles.keyBlank} />;
            }
            if (cell === 'back') {
              return (
                <Pressable
                  key={ci}
                  onPress={onBackspace}
                  disabled={disabled}
                  style={({ pressed }) => [styles.key, styles.keyGhost, pressed && styles.keyPressed]}
                  accessibilityLabel="Backspace"
                >
                  <Text style={styles.keyTextGhost}>{'\u232B'}</Text>
                </Pressable>
              );
            }
            return (
              <Pressable
                key={ci}
                onPress={() => onDigit(cell)}
                disabled={disabled}
                style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
                accessibilityLabel={`Digit ${cell}`}
              >
                <Text style={styles.keyText}>{cell}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', gap: 12 },
  row: { flexDirection: 'row', gap: 12 },
  key: {
    flex: 1,
    aspectRatio: 1.4,
    backgroundColor: colors.ink2,
    borderWidth: 1,
    borderColor: colors.rim,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyGhost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  keyBlank: { flex: 1, aspectRatio: 1.4 },
  keyPressed: { backgroundColor: colors.accGlow, borderColor: colors.acc },
  keyText: { fontSize: 28, fontWeight: '600', color: colors.tx },
  keyTextGhost: { fontSize: 26, color: colors.dim },
});
