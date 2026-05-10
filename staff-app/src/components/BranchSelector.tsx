// Branch selector for the staff-app header. Surfaces the auth store's
// `currentBranchId` selection plus an "All Branches" option, anchored
// to a small chip-style trigger button.
//
// Visibility: hidden entirely when staffUser.branchIds.length <= 1
// (the operator has no choice to make). Otherwise renders a chip
// labeled with the current selection's name; tapping opens a modal
// list of branches with the active row highlighted.
//
// Selection updates flow through useStaff().setCurrentBranchId, which
// (a) persists to SecureStore via gb_current_branch_id and
// (b) pushes the new value into api.ts's X-Branch-Id header so every
//     subsequent request carries it. Screens subscribe to
//     currentBranchId in their fetch deps to refetch on change.

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useStaff } from '../state/StaffContext';
import { colors, fontWeight, radius, space, text } from '../theme';

const ACTIVE_TINT = colors.acc;

export default function BranchSelector(): React.ReactElement | null {
  const { staffUser, currentBranchId, setCurrentBranchId } = useStaff();
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
    gap: space.px2, // was 6, rounded to 8 (px2)
    paddingHorizontal: space.px3, // was 10, rounded to 12 (px3)
    paddingVertical: space.px2, // was 6, rounded to 8 (px2)
    borderWidth: 1,
    borderColor: colors.rim,
    borderRadius: radius.full, // pill-shape (any value >= height/2 renders identically)
    backgroundColor: colors.ink2,
    marginLeft: space.px3,
    maxWidth: 180,
  },
  chipText: { color: colors.tx, fontSize: text.xs, fontWeight: fontWeight.semibold }, // was 12, rounded to 11.5 (xs)
  caret: { color: colors.dim, fontSize: text.xs }, // was 11, rounded to 11.5 (xs)
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlayModalTinted,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.px6,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.ink2,
    borderRadius: radius['2xl'], // was 14, rounded to 16 (2xl)
    borderWidth: 1,
    borderColor: colors.rim,
    padding: space.px4,
    maxHeight: '80%',
  },
  sheetTitle: { color: colors.tx, fontSize: text.base, fontWeight: fontWeight.bold, marginBottom: space.px2 },
  list: { },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.px3,
    paddingHorizontal: space.px2,
    borderRadius: radius.lg,
    gap: space.px2,
  },
  rowLabel: { color: colors.tx, fontSize: text.base, fontWeight: fontWeight.medium },
  rowLabelActive: { color: ACTIVE_TINT, fontWeight: fontWeight.bold },
  rowHint: { color: colors.dim, fontSize: text.xs, marginTop: space.px1 }, // was fontSize 11, rounded to 11.5 (xs); marginTop 2, rounded to 4 (px1)
  rowCheck: { color: ACTIVE_TINT, fontSize: text.lg, fontWeight: fontWeight.bold }, // was 16, rounded to 17 (lg)
});
