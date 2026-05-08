'use client';

// Inline compound-segment condition builder. Renders a list of
// { field, op, value } rows that the campaign creation form passes to
// the backend's segmentBuilder service for recipient resolution.
//
// Field/op metadata mirrors the backend's services/segmentBuilder.js
// SUPPORTED_FIELDS table — keep them in sync. The visual layout is
// AND-only (every condition must match); we do not surface OR grouping
// here because the backend doesn't support it either.

import type { SegmentCondition } from '../../../api/restaurant';

type FieldType = 'number' | 'enum' | 'boolean' | 'string' | 'month';

interface FieldConfig {
  label: string;
  type: FieldType;
  ops: Array<'gte' | 'lte' | 'eq' | 'neq' | 'in' | 'gt' | 'lt'>;
  // Enum value list — only for type === 'enum'.
  values?: ReadonlyArray<{ value: string | number; label: string }>;
}

const FIELD_CONFIG: Record<string, FieldConfig> = {
  days_since_last_order: {
    label: 'Days since last order',
    type: 'number',
    ops: ['gte', 'lte', 'eq'],
  },
  order_count: {
    label: 'Total orders',
    type: 'number',
    ops: ['gte', 'lte', 'eq'],
  },
  total_spend_rs: {
    label: 'Total spent (₹)',
    type: 'number',
    ops: ['gte', 'lte', 'eq'],
  },
  avg_order_value_rs: {
    label: 'Avg order value (₹)',
    type: 'number',
    ops: ['gte', 'lte', 'eq'],
  },
  rfm_label: {
    label: 'Customer type',
    type: 'enum',
    ops: ['eq', 'in'],
    values: [
      { value: 'Champion', label: 'Champion' },
      { value: 'Loyal', label: 'Loyal' },
      { value: 'Potential Loyalist', label: 'Potential Loyalist' },
      { value: 'At Risk', label: 'At Risk' },
      { value: 'Hibernating', label: 'Hibernating' },
      { value: 'Lost', label: 'Lost' },
      { value: 'Big Spender', label: 'Big Spender' },
      { value: 'New Customer', label: 'New Customer' },
    ],
  },
  birthday_month: {
    label: 'Birthday month',
    type: 'enum',
    ops: ['eq', 'in'],
    values: [
      { value: 1, label: 'January' },
      { value: 2, label: 'February' },
      { value: 3, label: 'March' },
      { value: 4, label: 'April' },
      { value: 5, label: 'May' },
      { value: 6, label: 'June' },
      { value: 7, label: 'July' },
      { value: 8, label: 'August' },
      { value: 9, label: 'September' },
      { value: 10, label: 'October' },
      { value: 11, label: 'November' },
      { value: 12, label: 'December' },
    ],
  },
  captain_acquired: {
    label: 'City Captain acquired',
    type: 'boolean',
    ops: ['eq'],
  },
  acquisition_source: {
    label: 'Acquisition source',
    type: 'string',
    ops: ['eq'],
  },
};

const OP_LABEL: Record<string, string> = {
  gte: '≥',
  lte: '≤',
  gt: '>',
  lt: '<',
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
};

// Default value for a freshly-added condition on a given field.
// Numeric fields start blank (user types); enum fields pick the first
// value; boolean defaults to true; string blank.
function defaultValueFor(field: string): unknown {
  const cfg = FIELD_CONFIG[field];
  if (!cfg) return '';
  if (cfg.type === 'boolean') return true;
  if (cfg.type === 'enum') return cfg.values?.[0]?.value ?? '';
  return '';
}

// Default op for a field — always the first allowed op so the value
// editor renders something sensible immediately.
function defaultOpFor(field: string): string {
  return FIELD_CONFIG[field]?.ops[0] ?? 'eq';
}

interface ConditionBuilderProps {
  conditions: SegmentCondition[];
  onChange: (conditions: SegmentCondition[]) => void;
  estimatedCount: number | null;
  loadingCount: boolean;
}

export default function ConditionBuilder({
  conditions,
  onChange,
  estimatedCount,
  loadingCount,
}: ConditionBuilderProps) {
  const addCondition = () => {
    const firstField = Object.keys(FIELD_CONFIG)[0] || 'days_since_last_order';
    onChange([
      ...conditions,
      { field: firstField, op: defaultOpFor(firstField), value: defaultValueFor(firstField) },
    ]);
  };

  const updateCondition = (index: number, patch: Partial<SegmentCondition>) => {
    const next = conditions.map((c, i) => (i === index ? { ...c, ...patch } : c));
    onChange(next);
  };

  // When the field changes, op + value must reset — the previous op
  // may not be valid for the new field, and a number value left over
  // would break an enum render.
  const changeField = (index: number, newField: string) => {
    onChange(
      conditions.map((c, i) =>
        i === index
          ? { field: newField, op: defaultOpFor(newField), value: defaultValueFor(newField) }
          : c,
      ),
    );
  };

  // When the op changes, the value type may need to flip (single ↔ array
  // for in/eq). Convert defensively.
  const changeOp = (index: number, newOp: string) => {
    const cond = conditions[index];
    if (!cond) return;
    let newValue: unknown = cond.value;
    if (newOp === 'in' && !Array.isArray(cond.value)) {
      newValue = cond.value === '' || cond.value === null || cond.value === undefined
        ? []
        : [cond.value];
    } else if (newOp !== 'in' && Array.isArray(cond.value)) {
      newValue = cond.value[0] ?? defaultValueFor(cond.field);
    }
    updateCondition(index, { op: newOp, value: newValue });
  };

  const removeCondition = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {conditions.length === 0 ? (
          <div className="text-[0.82rem] text-dim italic py-2 px-3 border border-dashed border-rim rounded-md">
            No conditions yet. Click <strong className="not-italic">+ Add condition</strong> below to start narrowing your audience.
          </div>
        ) : (
          conditions.map((cond, i) => (
            <ConditionRow
              key={i}
              cond={cond}
              onFieldChange={(f) => changeField(i, f)}
              onOpChange={(o) => changeOp(i, o)}
              onValueChange={(v) => updateCondition(i, { value: v })}
              onRemove={() => removeCondition(i)}
            />
          ))
        )}
      </div>

      <div>
        <button
          type="button"
          className="btn-g btn-xs"
          onClick={addCondition}
        >
          + Add condition
        </button>
      </div>

      <AudienceEstimate
        conditions={conditions}
        estimatedCount={estimatedCount}
        loadingCount={loadingCount}
      />
    </div>
  );
}

interface ConditionRowProps {
  cond: SegmentCondition;
  onFieldChange: (field: string) => void;
  onOpChange: (op: string) => void;
  onValueChange: (value: unknown) => void;
  onRemove: () => void;
}

function ConditionRow({
  cond, onFieldChange, onOpChange, onValueChange, onRemove,
}: ConditionRowProps) {
  const cfg = FIELD_CONFIG[cond.field];
  const validOps = cfg?.ops || ['eq'];
  // If the op got into an unsupported state (e.g. data drift), fall
  // back to the first valid op for rendering — saving will use the
  // valid op rather than the stored one.
  const safeOp = validOps.includes(cond.op as never) ? cond.op : (validOps[0] || 'eq');

  return (
    <div className="flex gap-2 items-start flex-wrap py-2 px-2 border border-rim rounded-md bg-ink2">
      <select
        value={cond.field}
        onChange={(e) => onFieldChange(e.target.value)}
        className="w-fit min-w-[180px] py-1 px-2 border border-rim rounded-sm bg-white text-tx text-[0.82rem]"
      >
        {Object.entries(FIELD_CONFIG).map(([key, c]) => (
          <option key={key} value={key}>{c.label}</option>
        ))}
      </select>

      <select
        value={safeOp}
        onChange={(e) => onOpChange(e.target.value)}
        className="w-fit min-w-[80px] py-1 px-2 border border-rim rounded-sm bg-white text-tx text-[0.82rem]"
      >
        {validOps.map((op) => (
          <option key={op} value={op}>{OP_LABEL[op] || op}</option>
        ))}
      </select>

      <div className="flex-1 min-w-[140px]">
        <ValueEditor cond={{ ...cond, op: safeOp }} onValueChange={onValueChange} />
      </div>

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        className="btn-g btn-xs"
      >
        ✕
      </button>
    </div>
  );
}

interface ValueEditorProps {
  cond: SegmentCondition;
  onValueChange: (value: unknown) => void;
}

function ValueEditor({ cond, onValueChange }: ValueEditorProps) {
  const cfg = FIELD_CONFIG[cond.field];
  if (!cfg) {
    return (
      <input
        type="text"
        value={typeof cond.value === 'string' ? cond.value : ''}
        onChange={(e) => onValueChange(e.target.value)}
        className="w-full py-1 px-2 border border-rim rounded-sm bg-white text-tx text-[0.82rem]"
      />
    );
  }

  // Boolean — Yes / No select.
  if (cfg.type === 'boolean') {
    return (
      <select
        value={cond.value === true ? 'true' : 'false'}
        onChange={(e) => onValueChange(e.target.value === 'true')}
        className="w-full py-1 px-2 border border-rim rounded-sm bg-white text-tx text-[0.82rem]"
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  // Enum — single-select for eq, multi-select for in.
  if (cfg.type === 'enum') {
    const values = cfg.values || [];
    if (cond.op === 'in') {
      const currentArr = Array.isArray(cond.value) ? cond.value : [];
      // values are mixed string|number depending on field — coerce to
      // the option's native type when reading the multi-select's
      // selected options array.
      return (
        <select
          multiple
          value={currentArr.map(String)}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions).map((o) => {
              const match = values.find((v) => String(v.value) === o.value);
              return match ? match.value : o.value;
            });
            onValueChange(selected);
          }}
          className="w-full min-h-[80px] py-1 px-2 border border-rim rounded-sm bg-white text-tx text-[0.82rem]"
        >
          {values.map((v) => (
            <option key={String(v.value)} value={String(v.value)}>{v.label}</option>
          ))}
        </select>
      );
    }
    // eq — single select.
    return (
      <select
        value={cond.value === undefined || cond.value === null ? '' : String(cond.value)}
        onChange={(e) => {
          const match = values.find((v) => String(v.value) === e.target.value);
          onValueChange(match ? match.value : e.target.value);
        }}
        className="w-full py-1 px-2 border border-rim rounded-sm bg-white text-tx text-[0.82rem]"
      >
        {values.map((v) => (
          <option key={String(v.value)} value={String(v.value)}>{v.label}</option>
        ))}
      </select>
    );
  }

  // Number — input type=number, coerce on change so the consumer's
  // payload carries an actual number, not a string.
  if (cfg.type === 'number') {
    const numValue = typeof cond.value === 'number' ? cond.value : '';
    return (
      <input
        type="number"
        value={numValue === '' ? '' : String(numValue)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') {
            onValueChange('');
            return;
          }
          const n = Number(v);
          onValueChange(Number.isFinite(n) ? n : '');
        }}
        className="w-full py-1 px-2 border border-rim rounded-sm bg-white text-tx text-[0.82rem]"
        placeholder="Enter a number"
      />
    );
  }

  // String fallback.
  return (
    <input
      type="text"
      value={typeof cond.value === 'string' ? cond.value : ''}
      onChange={(e) => onValueChange(e.target.value)}
      className="w-full py-1 px-2 border border-rim rounded-sm bg-white text-tx text-[0.82rem]"
      placeholder="Enter a value"
    />
  );
}

interface AudienceEstimateProps {
  conditions: SegmentCondition[];
  estimatedCount: number | null;
  loadingCount: boolean;
}

function AudienceEstimate({ conditions, estimatedCount, loadingCount }: AudienceEstimateProps) {
  if (conditions.length === 0) {
    return (
      <div className="text-[0.82rem] text-dim py-2 px-3 bg-ink2 border border-rim rounded-md">
        Add conditions to estimate audience.
      </div>
    );
  }
  if (loadingCount) {
    return (
      <div className="text-[0.82rem] text-dim py-2 px-3 bg-ink2 border border-rim rounded-md">
        Calculating audience…
      </div>
    );
  }
  if (estimatedCount === null) {
    return (
      <div className="text-[0.82rem] text-dim py-2 px-3 bg-ink2 border border-rim rounded-md">
        Audience estimate unavailable.
      </div>
    );
  }
  // Match-count tone: green when there's an audience, amber when zero
  // so the operator notices an empty segment before submitting.
  const tone = estimatedCount > 0
    ? 'bg-[#ecfdf5] border-[#bbf7d0] text-[#065f46]'
    : 'bg-[#fffbeb] border-[#fde68a] text-[#92400e]';
  return (
    <div className={`text-[0.85rem] font-semibold py-2 px-3 border rounded-md ${tone}`}>
      ~{estimatedCount.toLocaleString('en-IN')} customer{estimatedCount === 1 ? '' : 's'} match
    </div>
  );
}
