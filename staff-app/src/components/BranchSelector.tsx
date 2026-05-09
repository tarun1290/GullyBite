// Branch selector for the staff-app header. Surfaces the auth store's
// `currentBranchId` selection plus an "All Branches" option, anchored
// to a small chip-style trigger button.
//
// Visibility: hidden entirely when staffUser.branchIds.length <= 1
// (the operator has no choice to make). Otherwise renders a chip
// labeled with the current selection's name; tapping opens a modal
// list of branches with the active row highlighted.
//
// Selection updates flow through useAuth().setCurrentBranchId, which
// (a) persists to SecureStore via gb_current_branch_id and
// (b) pushes the new value into api.ts's X-Branch-Id header so every
//     subsequent request carries it. Screens subscribe to
//     currentBranchId in their fetch deps to refetch on change.

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../store/authStore';
import { colors } from '../theme';

const ACTIVE_TINT = colors.acc;

export default function BranchSelector(): React.ReactElement | null {
  const { staffUser, currentBranchId, setCurrentBranchId } = useAuth();
  const [open, setOpen] = useState<boolean>(false);

  const branches = staffUser?.branches || [];
  const branchIds = staffUser?.branchIds || [];

  // Single-branch sessions hide the selector entirely — there's no
  // selection to make and the chip would just be visual noise.
  if (branchIds.length <= 1) return null;

  const currentLabel = useMemo<string>(() => {
    if (!currentBranchId) return 'Branch';
    if (currentBranchId === 'all') return 'All Branches';
    const match = branches.find((b) => b.id === currentBranchId);
    return match?.name || 'Branch';
  }, [currentBranchId, branches]);

  async function pick(value: string) {
    await setCurrentBranchId(value);
    setOpen(false);
  }

  return (
    <View>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.chip, pressed && { opacity: 0.7 }]}
        accessibilityLabel="Select branch"
      >
        <Text style={styles.chipText} numberOfLines={1}>📍 {currentLabel}</Text>
        <Text style={styles.caret}>▾</Text>
      </Pressable>

      <Modal
        animationType="fade"
        transparent
        visible={open}
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Inner pressable swallows clicks so tapping the sheet itself
              doesn't dismiss the modal. */}
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Select branch</Text>
            <ScrollView style={styles.list}>
              <BranchRow
                label="All Branches"
                hint="Combined view across every assigned branch"
                active={currentBranchId === 'all'}
                onPress={() => pick('all')}
              />
              {branches.map((b) => (
                <BranchRow
                  key={b.id}
                  label={b.name}
                  active={currentBranchId === b.id}
                  onPress={() => pick(b.id)}
                />
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

interface RowProps {
  label: string;
  hint?: string;
  active: boolean;
  onPress: () => void;
}

function BranchRow({ label, hint, active, onPress }: RowProps): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.65 }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      {active ? <Text style={styles.rowCheck}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.rim,
    borderRadius: 999,
    backgroundColor: colors.ink2,
    marginLeft: 12,
    maxWidth: 180,
  },
  chipText: { color: colors.tx, fontSize: 12, fontWeight: '600' },
  caret: { color: colors.dim, fontSize: 11 },
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlayModalTinted,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.ink2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.rim,
    padding: 16,
    maxHeight: '80%',
  },
  sheetTitle: { color: colors.tx, fontSize: 14, fontWeight: '700', marginBottom: 8 },
  list: { },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
    gap: 8,
  },
  rowLabel: { color: colors.tx, fontSize: 14, fontWeight: '500' },
  rowLabelActive: { color: ACTIVE_TINT, fontWeight: '700' },
  rowHint: { color: colors.dim, fontSize: 11, marginTop: 2 },
  rowCheck: { color: ACTIVE_TINT, fontSize: 16, fontWeight: '700' },
});
