'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../Toast';
import { getFlowJson, updateFlow, publishFlow } from '../../api/admin';

interface FlowComponent {
  type: string;
  name?: string;
  text?: string;
  label?: string;
  required?: boolean;
  'input-type'?: string;
  'data-source'?: Array<{ id?: string; title?: string }>;
  'on-click-action'?: FlowAction;
  'list-items'?: string;
  _gb_logic?: boolean;
  condition?: { field?: string; operator?: string; value?: string };
  then_action?: FlowAction;
  else_action?: FlowAction;
  [key: string]: unknown;
}

interface FlowAction {
  name?: string;
  next?: { type?: string; name?: string };
  payload?: Record<string, string>;
}

interface FlowScreen {
  id: string;
  title?: string;
  terminal?: boolean;
  success?: boolean;
  data?: Record<string, unknown>;
  layout: { type?: string; children: FlowComponent[] };
  [key: string]: unknown;
}

interface Flow {
  version: string;
  screens: FlowScreen[];
  [key: string]: unknown;
}

interface FlowResponse {
  flow_json?: unknown;
  json?: unknown;
  name?: string;
  status?: string;
  version?: string;
  screens?: unknown[];
  [key: string]: unknown;
}

const COMP_DEFAULTS: Record<string, () => FlowComponent> = {
  TextHeading: () => ({ type: 'TextHeading', text: 'Heading' }),
  TextSubheading: () => ({ type: 'TextSubheading', text: 'Subheading' }),
  TextBody: () => ({ type: 'TextBody', text: 'Body text' }),
  TextCaption: () => ({ type: 'TextCaption', text: 'Caption' }),
  TextInput: () => ({ type: 'TextInput', label: 'Field', name: 'field_1', 'input-type': 'text', required: false }),
  Dropdown: () => ({ type: 'Dropdown', label: 'Select', name: 'dropdown_1', required: false, 'data-source': [{ id: 'opt1', title: 'Option 1' }] }),
  RadioButtonsGroup: () => ({ type: 'RadioButtonsGroup', label: 'Choose', name: 'radio_1', required: false, 'data-source': [{ id: 'opt1', title: 'Option 1' }] }),
  CheckboxGroup: () => ({ type: 'CheckboxGroup', label: 'Select', name: 'check_1', required: false, 'data-source': [{ id: 'opt1', title: 'Option 1' }] }),
  OptIn: () => ({ type: 'OptIn', label: 'I agree', name: 'optin_1', required: false }),
  Footer: () => ({ type: 'Footer', label: 'Submit', 'on-click-action': { name: 'complete', payload: {} } }),
  NavigationList: () => ({ type: 'NavigationList', label: 'Items', name: 'nav_1', 'list-items': '${data.items}', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: '' }, payload: {} } }),
  If: () => ({ type: 'If', name: 'condition_1', _gb_logic: true, condition: { field: '', operator: 'equals', value: '' }, then_action: { name: 'navigate', next: { type: 'screen', name: '' }, payload: {} }, else_action: { name: 'navigate', next: { type: 'screen', name: '' }, payload: {} } }),
};

const PALETTE: ReadonlyArray<{ cat: string; items: string[] }> = [
  { cat: 'Text', items: ['TextHeading', 'TextSubheading', 'TextBody', 'TextCaption'] },
  { cat: 'Input', items: ['TextInput', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'OptIn'] },
  { cat: 'Navigation', items: ['Footer', 'NavigationList'] },
  { cat: 'Logic', items: ['If'] },
];

const SKIP_PROPS = ['type', 'data-source', 'on-click-action', 'list-items', 'condition', 'then_action', 'else_action', '_gb_logic'];

function blankFlow(): Flow {
  return { version: '6.2', screens: [{ id: 'SCREEN_1', title: 'Screen 1', terminal: true, layout: { type: 'SingleColumnLayout', children: [] } }] };
}

function normalizeFlow(input: unknown): Flow {
  let raw = input as Record<string, unknown> | null;
  if (raw && typeof raw === 'object') {
    if (raw.flow_json && typeof raw.flow_json === 'object') raw = raw.flow_json as Record<string, unknown>;
    else if (raw.json && typeof raw.json === 'object') raw = raw.json as Record<string, unknown>;
  }
  if (!raw || typeof raw !== 'object') return blankFlow();

  const out: Flow = { version: (raw.version as string) || '6.2', screens: [] };
  Object.keys(raw).forEach((k) => { if (k !== 'version' && k !== 'screens') out[k] = raw![k]; });

  const screens = Array.isArray(raw.screens) ? (raw.screens as Array<Record<string, unknown> | null>) : [];
  if (!screens.length) return { ...out, screens: blankFlow().screens };

  out.screens = screens.map((s, i) => {
    const src = (s && typeof s === 'object') ? s : {};
    const screen: FlowScreen = {
      id: (src.id as string) || `SCREEN_${i + 1}`,
      title: (src.title as string) || `Screen ${i + 1}`,
      terminal: !!src.terminal,
      layout: { type: 'SingleColumnLayout', children: [] },
    };
    if (src.success !== undefined) screen.success = !!src.success;
    if (src.data && typeof src.data === 'object') screen.data = src.data as Record<string, unknown>;
    const layout = (src.layout as Record<string, unknown>) || {};
    screen.layout = {
      type: (layout.type as string) || 'SingleColumnLayout',
      children: Array.isArray(layout.children) ? (layout.children as FlowComponent[]) : [],
    };
    Object.keys(src).forEach((k) => {
      if (!['id', 'title', 'terminal', 'success', 'data', 'layout'].includes(k)) screen[k] = src[k];
    });
    return screen;
  });
  return out;
}

interface FlowEditorProps {
  flowId?: string | null;
  flowName?: string;
  flowStatus?: string;
  onClose?: () => void;
  onSaved?: () => void;
}

export default function FlowEditor({ flowId, flowName: initialName, flowStatus: initialStatus, onClose, onSaved }: FlowEditorProps) {
  const { showToast } = useToast();
  const [flow, setFlow] = useState<Flow>(blankFlow());
  const [screenIdx, setScreenIdx] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [jsonMode, setJsonMode] = useState<boolean>(false);
  const [jsonText, setJsonText] = useState<string>('');
  const [flowName, setFlowName] = useState<string>(initialName || (flowId ? `Flow ${flowId}` : 'New Flow'));
  const [flowStatus, setFlowStatus] = useState<string>(initialStatus || 'DRAFT');

  useEffect(() => {
    if (!flowId) {
      setFlow(blankFlow());
      setScreenIdx(0);
      return;
    }
    setLoading(true);
    (getFlowJson(flowId) as Promise<FlowResponse | null>)
      .then((data) => {
        setFlow(normalizeFlow(data));
        if (data?.name) setFlowName(data.name);
        if (data?.status) setFlowStatus(data.status);
      })
      .catch((err: unknown) => {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        showToast(e?.response?.data?.error || e?.message || 'Failed to load flow', 'error');
        setFlow(blankFlow());
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  const screen: FlowScreen | null = flow.screens[screenIdx] || null;
  const children: FlowComponent[] = screen?.layout?.children || [];

  const mutate = (fn: (next: Flow) => void) => {
    setFlow((prev) => {
      const next: Flow = {
        ...prev,
        screens: prev.screens.map((s) => ({ ...s, layout: { ...s.layout, children: [...(s.layout?.children || [])] } })),
      };
      fn(next);
      return next;
    });
  };

  const addScreen = () => {
    mutate((next) => {
      let n = next.screens.length + 1;
      let id = `SCREEN_${n}`;
      while (next.screens.some((s) => s.id === id)) { n++; id = `SCREEN_${n}`; }
      next.screens.push({ id, title: `Screen ${n}`, terminal: false, layout: { type: 'SingleColumnLayout', children: [] } });
    });
    setScreenIdx(flow.screens.length);
  };

  const removeScreen = (idx: number) => {
    if (flow.screens.length <= 1) { showToast('Cannot remove last screen', 'error'); return; }
    mutate((next) => { next.screens.splice(idx, 1); });
    setScreenIdx((i) => Math.max(0, Math.min(i, flow.screens.length - 2)));
  };

  const updateScreenProp = (prop: keyof FlowScreen | string, val: unknown) => {
    mutate((next) => {
      const cur = next.screens[screenIdx];
      if (!cur) return;
      (cur as Record<string, unknown>)[prop as string] = val;
    });
  };

  const addDataField = () => {
    mutate((next) => {
      const s = next.screens[screenIdx];
      if (!s) return;
      if (!s.data) s.data = {};
      const data = s.data;
      let n = Object.keys(data).length + 1;
      let key = `field_${n}`;
      while (data[key]) { n++; key = `field_${n}`; }
      data[key] = { type: 'string', __example__: '' };
    });
  };

  const renameDataField = (oldKey: string, newKey: string) => {
    if (!newKey || oldKey === newKey) return;
    mutate((next) => {
      const s = next.screens[screenIdx];
      if (!s?.data) return;
      s.data[newKey] = s.data[oldKey];
      delete s.data[oldKey];
    });
  };

  const updateDataFieldType = (key: string, type: string) => {
    mutate((next) => {
      const s = next.screens[screenIdx];
      if (!s?.data?.[key]) return;
      const v = s.data[key];
      if (typeof v === 'object' && v !== null) (v as Record<string, unknown>).type = type;
      else s.data[key] = { type, __example__: '' };
    });
  };

  const removeDataField = (key: string) => {
    mutate((next) => {
      const s = next.screens[screenIdx];
      if (!s?.data) return;
      delete s.data[key];
      if (!Object.keys(s.data).length) delete s.data;
    });
  };

  const addComponent = (type: string) => {
    const factory = COMP_DEFAULTS[type];
    if (!factory) { showToast(`Unknown component: ${type}`, 'error'); return; }
    mutate((next) => {
      const cur = next.screens[screenIdx];
      if (!cur) return;
      const kids = cur.layout.children;
      const comp = factory();
      if (comp.name) {
        const base = comp.name.replace(/_\d+$/, '');
        const count = kids.filter((c) => c.name && c.name.indexOf(base) === 0).length;
        if (count > 0) comp.name = `${base}_${count + 1}`;
      }
      kids.push(comp);
    });
  };

  const removeComponent = (idx: number) => {
    mutate((next) => {
      const cur = next.screens[screenIdx];
      if (!cur) return;
      cur.layout.children.splice(idx, 1);
    });
  };

  const moveComponent = (idx: number, dir: number) => {
    const tgt = idx + dir;
    if (tgt < 0 || tgt >= children.length) return;
    mutate((next) => {
      const cur = next.screens[screenIdx];
      if (!cur) return;
      const kids = cur.layout.children;
      const a = kids[idx];
      const b = kids[tgt];
      if (!a || !b) return;
      kids[idx] = b;
      kids[tgt] = a;
    });
  };

  const updateComponent = (idx: number, prop: string, val: unknown) => {
    mutate((next) => {
      const cur = next.screens[screenIdx];
      const child = cur?.layout.children[idx];
      if (!child) return;
      (child as Record<string, unknown>)[prop] = val;
    });
  };

  const addDataSource = (compIdx: number) => {
    mutate((next) => {
      const child = next.screens[screenIdx]?.layout.children[compIdx];
      const ds = child?.['data-source'];
      if (!ds) return;
      const n = ds.length + 1;
      ds.push({ id: `opt${n}`, title: `Option ${n}` });
    });
  };

  const updateDataSource = (compIdx: number, itemIdx: number, prop: 'id' | 'title', val: string) => {
    mutate((next) => {
      const child = next.screens[screenIdx]?.layout.children[compIdx];
      const ds = child?.['data-source'];
      const item = ds?.[itemIdx];
      if (item) item[prop] = val;
    });
  };

  const removeDataSource = (compIdx: number, itemIdx: number) => {
    mutate((next) => {
      const child = next.screens[screenIdx]?.layout.children[compIdx];
      const ds = child?.['data-source'];
      if (ds) ds.splice(itemIdx, 1);
    });
  };

  const updateActionProp = (compIdx: number, prop: string, val: string) => {
    mutate((next) => {
      const child = next.screens[screenIdx]?.layout.children[compIdx];
      const act = child?.['on-click-action'];
      if (!act) return;
      if (prop === 'name') {
        act.name = val;
        if (val === 'navigate' && !act.next) act.next = { type: 'screen', name: '' };
        if (val !== 'navigate') delete act.next;
      } else if (prop === 'next_screen') {
        if (!act.next) act.next = { type: 'screen', name: '' };
        act.next.name = val;
      }
    });
  };

  const addPayloadField = (compIdx: number) => {
    mutate((next) => {
      const child = next.screens[screenIdx]?.layout.children[compIdx];
      const act = child?.['on-click-action'];
      if (!act) return;
      if (!act.payload) act.payload = {};
      const n = Object.keys(act.payload).length + 1;
      act.payload[`key_${n}`] = '${form.field}';
    });
  };

  const renamePayloadField = (compIdx: number, oldKey: string, newKey: string) => {
    if (!newKey || oldKey === newKey) return;
    mutate((next) => {
      const child = next.screens[screenIdx]?.layout.children[compIdx];
      const act = child?.['on-click-action'];
      if (!act?.payload) return;
      act.payload[newKey] = act.payload[oldKey] || '';
      delete act.payload[oldKey];
    });
  };

  const updatePayloadValue = (compIdx: number, key: string, val: string) => {
    mutate((next) => {
      const child = next.screens[screenIdx]?.layout.children[compIdx];
      const act = child?.['on-click-action'];
      if (act?.payload) act.payload[key] = val;
    });
  };

  const removePayloadField = (compIdx: number, key: string) => {
    mutate((next) => {
      const child = next.screens[screenIdx]?.layout.children[compIdx];
      const act = child?.['on-click-action'];
      if (act?.payload) delete act.payload[key];
    });
  };

  const updateCondition = (compIdx: number, prop: 'field' | 'operator' | 'value', val: string) => {
    mutate((next) => {
      const c = next.screens[screenIdx]?.layout.children[compIdx];
      if (!c) return;
      if (!c.condition) c.condition = {};
      c.condition[prop] = val;
    });
  };

  const updateBranchAction = (compIdx: number, actionKey: 'then_action' | 'else_action', screenId: string) => {
    mutate((next) => {
      const c = next.screens[screenIdx]?.layout.children[compIdx];
      if (!c) return;
      c[actionKey] = {
        name: 'navigate',
        next: { type: 'screen', name: screenId },
        payload: c[actionKey]?.payload || {},
      };
    });
  };

  const syncFromJsonMode = (): Flow | null => {
    try {
      return normalizeFlow(JSON.parse(jsonText));
    } catch (err: unknown) {
      const e = err as { message?: string };
      showToast(`Invalid JSON: ${e.message || ''}`, 'error');
      return null;
    }
  };

  const handleSave = async () => {
    if (!flowId) { showToast('No flow ID to save to', 'error'); return; }
    let payload = flow;
    if (jsonMode) {
      const parsed = syncFromJsonMode();
      if (!parsed) return;
      payload = parsed;
      setFlow(parsed);
    }
    if (!payload?.screens?.length) { showToast('Cannot save empty flow', 'error'); return; }
    setSaving(true);
    try {
      await updateFlow(flowId, { ...payload });
      showToast('Flow saved', 'success');
      if (onSaved) onSaved();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const [confirmPublish, setConfirmPublish] = useState<boolean>(false);
  const handlePublish = async () => {
    if (!flowId) { showToast('No flow ID', 'error'); return; }
    if (!confirmPublish) { setConfirmPublish(true); return; }
    setConfirmPublish(false);
    setPublishing(true);
    try {
      await publishFlow(flowId);
      showToast('Flow published', 'success');
      setFlowStatus('PUBLISHED');
      if (onSaved) onSaved();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Publish failed', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const toggleJsonMode = () => {
    if (!jsonMode) {
      setJsonText(JSON.stringify(flow, null, 2));
      setJsonMode(true);
    } else {
      const parsed = syncFromJsonMode();
      if (!parsed) return;
      setFlow(parsed);
      setScreenIdx((i) => (i >= parsed.screens.length ? 0 : i));
      setJsonMode(false);
    }
  };

  const exportJson = () => {
    let json: Flow = flow;
    if (jsonMode) {
      const parsed = syncFromJsonMode();
      if (!parsed) return;
      json = parsed;
    }
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${flowId ? `flow_${flowId}` : 'flow'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('JSON exported', 'success');
  };

  const navMap = useMemo<string>(() => {
    const parts = (flow.screens || []).map((s) => {
      const edges: string[] = [];
      (s.layout?.children || []).forEach((c) => {
        const act = c['on-click-action'];
        if (act?.name === 'navigate' && act.next?.name) edges.push(act.next.name);
        if (c._gb_logic) {
          if (c.then_action?.next?.name) edges.push(`IF→${c.then_action.next.name}`);
          if (c.else_action?.next?.name) edges.push(`ELSE→${c.else_action.next.name}`);
        }
      });
      let label = s.id;
      if (s.terminal) label += ' (terminal)';
      if (edges.length) label += ` → ${edges.join(', ')}`;
      return label;
    });
    return parts.join('  |  ');
  }, [flow]);

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>Loading flow…</div>;
  }

  return (
    <div id="flow-editor-container" style={{ border: '1px solid var(--rim)', borderRadius: 8, background: 'var(--surface,#fff)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.7rem .9rem', borderBottom: '1px solid var(--rim)', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700 }} id="fe-flow-name">{flowName}</div>
        <span id="fe-flow-status" style={{ fontSize: '.7rem', padding: '.1rem .45rem', borderRadius: 99, background: flowStatus === 'PUBLISHED' ? '#22c55e15' : '#3b82f615', color: flowStatus === 'PUBLISHED' ? 'var(--gb-wa-500)' : '#3b82f6', fontWeight: 600 }}>{flowStatus}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem' }}>
          <button type="button" id="fe-mode-btn" className="btn-sm" onClick={toggleJsonMode}>
            {jsonMode ? 'Visual Mode' : 'JSON Mode'}
          </button>
          <button type="button" className="btn-sm" onClick={exportJson}>Export JSON</button>
          <button type="button" className="btn-p btn-sm" onClick={handleSave} disabled={saving || !flowId}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {confirmPublish ? (
            <>
              <button type="button" className="btn-sm" style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)', border: 'none' }} onClick={handlePublish} disabled={publishing}>
                {publishing ? '…' : 'Confirm Publish'}
              </button>
              <button type="button" className="btn-sm" onClick={() => setConfirmPublish(false)} disabled={publishing}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn-sm" style={{ color: 'var(--gb-wa-500)' }} onClick={handlePublish} disabled={publishing || !flowId}>
              Publish
            </button>
          )}
          {onClose && (
            <button type="button" className="btn-g btn-sm" onClick={onClose}>Close</button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 300px', minHeight: 500 }}>
        <div id="fe-palette" style={{ padding: '.7rem', borderRight: '1px solid var(--rim)', fontSize: '.8rem' }}>
          <div style={{ fontWeight: 700, marginBottom: '.5rem', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase' }}>Components</div>
          {PALETTE.map((g) => (
            <div key={g.cat}>
              <div style={{ fontWeight: 600, fontSize: '.7rem', color: 'var(--mute,#94a3b8)', margin: '.5rem 0 .2rem', textTransform: 'uppercase' }}>{g.cat}</div>
              {g.items.map((t) => (
                <div
                  key={t}
                  onClick={() => addComponent(t)}
                  style={{ padding: '.25rem .45rem', cursor: 'pointer', borderRadius: 4, marginBottom: 2 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ink4,#f3f4f6)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {t}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ padding: '.7rem', minWidth: 0, overflow: 'hidden' }}>
          <div id="fe-screen-tabs" style={{ display: 'flex', gap: '.2rem', borderBottom: '1px solid var(--rim)', marginBottom: '.6rem', overflowX: 'auto' }}>
            {flow.screens.map((s, i) => (
              <div
                key={s.id + '_' + i}
                onClick={() => setScreenIdx(i)}
                style={{ padding: '.4rem .8rem', cursor: 'pointer', fontSize: '.78rem', fontWeight: i === screenIdx ? 700 : 500, color: i === screenIdx ? 'var(--acc)' : 'var(--dim)', borderBottom: `2px solid ${i === screenIdx ? 'var(--acc)' : 'transparent'}`, whiteSpace: 'nowrap' }}
              >
                {s.id}
              </div>
            ))}
            <div onClick={addScreen} style={{ padding: '.4rem .6rem', cursor: 'pointer', fontWeight: 700, color: 'var(--mute,#94a3b8)' }} title="Add screen">+</div>
          </div>

          {screen && !jsonMode && (
            <div id="fe-screen-props" style={{ marginBottom: '.7rem' }}>
              <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontSize: '.7rem', color: 'var(--dim)', fontWeight: 600 }}>ID</label>
                <input
                  value={screen.id}
                  onChange={(e) => updateScreenProp('id', e.target.value)}
                  style={{ width: 120, padding: '.2rem .45rem', border: '1px solid var(--rim)', borderRadius: 4, fontFamily: 'monospace', fontSize: '.76rem' }}
                />
                <label style={{ fontSize: '.7rem', color: 'var(--dim)', fontWeight: 600, marginLeft: '.3rem' }}>Title</label>
                <input
                  value={screen.title || ''}
                  onChange={(e) => updateScreenProp('title', e.target.value)}
                  style={{ width: 150, padding: '.2rem .45rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.76rem' }}
                />
                <label style={{ fontSize: '.7rem', color: 'var(--dim)', fontWeight: 600, marginLeft: '.3rem' }}>Terminal</label>
                <input type="checkbox" checked={!!screen.terminal} onChange={(e) => updateScreenProp('terminal', e.target.checked)} />
                <label style={{ fontSize: '.7rem', color: 'var(--dim)', fontWeight: 600, marginLeft: '.3rem' }}>Success</label>
                <input type="checkbox" checked={!!screen.success} onChange={(e) => updateScreenProp('success', e.target.checked)} />
                {flow.screens.length > 1 && (
                  <button type="button" className="btn-sm" style={{ marginLeft: 'auto', color: 'var(--red,#dc2626)', fontSize: '.7rem' }} onClick={() => removeScreen(screenIdx)}>
                    Remove Screen
                  </button>
                )}
              </div>

              <div style={{ marginTop: '.5rem', padding: '.4rem', background: 'var(--ink4,#f4f4f5)', border: '1px solid var(--rim)', borderRadius: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '.25rem' }}>
                  <span style={{ fontSize: '.7rem', fontWeight: 600, color: 'var(--dim)' }}>Screen Data (input variables)</span>
                  <button type="button" className="btn-sm" style={{ marginLeft: 'auto', fontSize: '.62rem', padding: '.05rem .35rem' }} onClick={addDataField}>+ Add</button>
                </div>
                {!screen.data || !Object.keys(screen.data).length ? (
                  <div style={{ fontSize: '.68rem', color: 'var(--mute,#94a3b8)', fontStyle: 'italic' }}>
                    No data fields. Add one if this screen needs input from a previous screen.
                  </div>
                ) : Object.keys(screen.data).map((k) => {
                  const v = (screen.data as Record<string, unknown>)[k];
                  const typeVal = typeof v === 'object' && v !== null ? ((v as Record<string, unknown>).type as string || 'string') : 'string';
                  return (
                    <div key={k} style={{ display: 'flex', gap: '.25rem', alignItems: 'center', marginBottom: '.15rem' }}>
                      <input defaultValue={k} placeholder="key" onBlur={(e) => renameDataField(k, e.target.value)} style={{ width: 80, padding: '.12rem .25rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.7rem', fontFamily: 'monospace', background: 'var(--gb-neutral-0)' }} />
                      <select value={typeVal} onChange={(e) => updateDataFieldType(k, e.target.value)} style={{ padding: '.12rem .25rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.7rem', background: 'var(--gb-neutral-0)' }}>
                        {['string', 'number', 'boolean', 'array', 'object'].map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button type="button" onClick={() => removeDataField(k)} style={{ background: 'none', border: 'none', color: 'var(--red,#dc2626)', cursor: 'pointer', fontSize: '.75rem' }}>×</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {jsonMode ? (
            <div id="fe-json-area">
              <textarea
                id="fe-json-textarea"
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                rows={24}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: '.78rem', padding: '.5rem', border: '1px solid var(--rim)', borderRadius: 4 }}
              />
            </div>
          ) : (
            <div id="fe-components">
              {!children.length ? (
                <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--mute,#94a3b8)', fontSize: '.82rem' }}>
                  No components yet. Click items in the palette to add them.
                </div>
              ) : children.map((c, i) => (
                <ComponentCard
                  key={i}
                  comp={c}
                  idx={i}
                  total={children.length}
                  screens={flow.screens}
                  siblingFields={children.filter((_, ci) => ci !== i && _.name && ['TextInput', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup'].includes(_.type)).map((x) => x.name as string)}
                  onUpdate={updateComponent}
                  onRemove={removeComponent}
                  onMove={moveComponent}
                  onAddDS={addDataSource}
                  onUpdateDS={updateDataSource}
                  onRemoveDS={removeDataSource}
                  onUpdateAction={updateActionProp}
                  onAddPayload={addPayloadField}
                  onRenamePayload={renamePayloadField}
                  onUpdatePayloadValue={updatePayloadValue}
                  onRemovePayload={removePayloadField}
                  onUpdateCondition={updateCondition}
                  onUpdateBranchAction={updateBranchAction}
                />
              ))}
            </div>
          )}

          <div id="fe-nav-map" style={{ marginTop: '.7rem', padding: '.4rem .55rem', background: 'var(--ink4,#f4f4f5)', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.74rem' }}>
            <strong>Navigation:</strong> {navMap || '—'}
          </div>
        </div>

        <div id="fe-preview" style={{ padding: '.7rem', borderLeft: '1px solid var(--rim)', background: 'var(--ink4,#f4f4f5)' }}>
          <Preview screen={screen} />
        </div>
      </div>
    </div>
  );
}

interface ComponentCardProps {
  comp: FlowComponent;
  idx: number;
  total: number;
  screens: FlowScreen[];
  siblingFields: string[];
  onUpdate: (idx: number, prop: string, val: unknown) => void;
  onRemove: (idx: number) => void;
  onMove: (idx: number, dir: number) => void;
  onAddDS: (compIdx: number) => void;
  onUpdateDS: (compIdx: number, itemIdx: number, prop: 'id' | 'title', val: string) => void;
  onRemoveDS: (compIdx: number, itemIdx: number) => void;
  onUpdateAction: (compIdx: number, prop: string, val: string) => void;
  onAddPayload: (compIdx: number) => void;
  onRenamePayload: (compIdx: number, oldKey: string, newKey: string) => void;
  onUpdatePayloadValue: (compIdx: number, key: string, val: string) => void;
  onRemovePayload: (compIdx: number, key: string) => void;
  onUpdateCondition: (compIdx: number, prop: 'field' | 'operator' | 'value', val: string) => void;
  onUpdateBranchAction: (compIdx: number, key: 'then_action' | 'else_action', screenId: string) => void;
}

function ComponentCard({
  comp, idx, total, screens, siblingFields,
  onUpdate, onRemove, onMove,
  onAddDS, onUpdateDS, onRemoveDS,
  onUpdateAction, onAddPayload, onRenamePayload, onUpdatePayloadValue, onRemovePayload,
  onUpdateCondition, onUpdateBranchAction,
}: ComponentCardProps): ReactNode {
  return (
    <div style={{ background: 'var(--ink4,#f4f4f5)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.55rem', marginBottom: '.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', marginBottom: '.4rem' }}>
        <span style={{ background: 'rgba(79,70,229,.08)', color: 'var(--acc)', fontSize: '.66rem', fontWeight: 700, padding: '.1rem .4rem', borderRadius: 4 }}>{comp.type}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '.2rem' }}>
          {idx > 0 && <button type="button" className="btn-sm" style={{ padding: '.1rem .35rem', fontSize: '.7rem' }} onClick={() => onMove(idx, -1)} title="Move up">↑</button>}
          {idx < total - 1 && <button type="button" className="btn-sm" style={{ padding: '.1rem .35rem', fontSize: '.7rem' }} onClick={() => onMove(idx, 1)} title="Move down">↓</button>}
          <button type="button" className="btn-sm" style={{ padding: '.1rem .35rem', fontSize: '.7rem', color: 'var(--red,#dc2626)' }} onClick={() => onRemove(idx)} title="Remove">×</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
        {Object.keys(comp).filter((k) => !SKIP_PROPS.includes(k)).map((key) => {
          const val = (comp as Record<string, unknown>)[key];
          if (typeof val === 'boolean') {
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                <label style={{ fontSize: '.7rem', color: 'var(--dim)', fontWeight: 600, minWidth: 60 }}>{key}</label>
                <input type="checkbox" checked={val} onChange={(e) => onUpdate(idx, key, e.target.checked)} />
              </div>
            );
          }
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
              <label style={{ fontSize: '.7rem', color: 'var(--dim)', fontWeight: 600, minWidth: 60 }}>{key}</label>
              <input
                value={(val as string | number | undefined) ?? ''}
                onChange={(e) => onUpdate(idx, key, e.target.value)}
                style={{ flex: 1, padding: '.2rem .4rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.76rem', background: 'var(--gb-neutral-0)' }}
              />
            </div>
          );
        })}

        {comp['data-source'] && (
          <div style={{ marginTop: '.25rem', padding: '.4rem', background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '.3rem' }}>
              <span style={{ fontSize: '.7rem', fontWeight: 600, color: 'var(--dim)' }}>data-source</span>
              <button type="button" className="btn-sm" style={{ marginLeft: 'auto', fontSize: '.63rem', padding: '.05rem .35rem' }} onClick={() => onAddDS(idx)}>+ Add</button>
            </div>
            {comp['data-source'].map((item, ii) => (
              <div key={ii} style={{ display: 'flex', gap: '.25rem', alignItems: 'center', marginBottom: '.2rem' }}>
                <input value={item.id || ''} placeholder="id" onChange={(e) => onUpdateDS(idx, ii, 'id', e.target.value)} style={{ width: 70, padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }} />
                <input value={item.title || ''} placeholder="title" onChange={(e) => onUpdateDS(idx, ii, 'title', e.target.value)} style={{ flex: 1, padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }} />
                <button type="button" onClick={() => onRemoveDS(idx, ii)} style={{ background: 'none', border: 'none', color: 'var(--red,#dc2626)', cursor: 'pointer', fontSize: '.78rem' }}>×</button>
              </div>
            ))}
          </div>
        )}

        {comp['on-click-action'] && (
          <ActionEditor
            action={comp['on-click-action']}
            screens={screens}
            onUpdate={(prop, val) => onUpdateAction(idx, prop, val)}
            onAddPayload={() => onAddPayload(idx)}
            onRenamePayload={(oldK, newK) => onRenamePayload(idx, oldK, newK)}
            onUpdatePayloadValue={(k, v) => onUpdatePayloadValue(idx, k, v)}
            onRemovePayload={(k) => onRemovePayload(idx, k)}
          />
        )}

        {comp._gb_logic && (
          <ConditionEditor
            comp={comp}
            screens={screens}
            siblingFields={siblingFields}
            onUpdate={(prop, val) => onUpdateCondition(idx, prop, val)}
            onUpdateBranch={(key, screenId) => onUpdateBranchAction(idx, key, screenId)}
          />
        )}
      </div>
    </div>
  );
}

interface ActionEditorProps {
  action: FlowAction;
  screens: FlowScreen[];
  onUpdate: (prop: string, val: string) => void;
  onAddPayload: () => void;
  onRenamePayload: (oldK: string, newK: string) => void;
  onUpdatePayloadValue: (k: string, v: string) => void;
  onRemovePayload: (k: string) => void;
}

function ActionEditor({ action, screens, onUpdate, onAddPayload, onRenamePayload, onUpdatePayloadValue, onRemovePayload }: ActionEditorProps): ReactNode {
  return (
    <div style={{ marginTop: '.25rem', padding: '.4rem', background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 4 }}>
      <div style={{ fontSize: '.7rem', fontWeight: 600, color: 'var(--dim)', marginBottom: '.3rem' }}>on-click-action</div>

      <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center', marginBottom: '.25rem' }}>
        <label style={{ fontSize: '.68rem', color: 'var(--dim)', minWidth: 50 }}>action</label>
        <select value={action.name || ''} onChange={(e) => onUpdate('name', e.target.value)} style={{ padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}>
          {['navigate', 'complete', 'data_exchange'].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {action.name === 'navigate' && (
        <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center', marginBottom: '.25rem' }}>
          <label style={{ fontSize: '.68rem', color: 'var(--dim)', minWidth: 50 }}>next</label>
          <select value={action.next?.name || ''} onChange={(e) => onUpdate('next_screen', e.target.value)} style={{ padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}>
            <option value="">-- select --</option>
            {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', margin: '.25rem 0 .15rem' }}>
        <span style={{ fontSize: '.68rem', color: 'var(--dim)' }}>payload</span>
        <button type="button" className="btn-sm" style={{ marginLeft: 'auto', fontSize: '.62rem', padding: '.05rem .3rem' }} onClick={onAddPayload}>+ field</button>
      </div>
      {Object.keys(action.payload || {}).map((k) => (
        <div key={k} style={{ display: 'flex', gap: '.25rem', alignItems: 'center', marginBottom: '.15rem' }}>
          <input defaultValue={k} placeholder="key" onBlur={(e) => onRenamePayload(k, e.target.value)} style={{ width: 70, padding: '.12rem .25rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.7rem' }} />
          <input value={action.payload?.[k] ?? ''} placeholder="value" onChange={(e) => onUpdatePayloadValue(k, e.target.value)} style={{ flex: 1, padding: '.12rem .25rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.7rem' }} />
          <button type="button" onClick={() => onRemovePayload(k)} style={{ background: 'none', border: 'none', color: 'var(--red,#dc2626)', cursor: 'pointer', fontSize: '.75rem' }}>×</button>
        </div>
      ))}
    </div>
  );
}

interface ConditionEditorProps {
  comp: FlowComponent;
  screens: FlowScreen[];
  siblingFields: string[];
  onUpdate: (prop: 'field' | 'operator' | 'value', val: string) => void;
  onUpdateBranch: (key: 'then_action' | 'else_action', screenId: string) => void;
}

function ConditionEditor({ comp, screens, siblingFields, onUpdate, onUpdateBranch }: ConditionEditorProps): ReactNode {
  const cond = comp.condition || {};
  const thenAct = comp.then_action || {};
  const elseAct = comp.else_action || {};
  return (
    <div style={{ marginTop: '.35rem', padding: '.5rem', background: 'linear-gradient(135deg,#fef3c710,#dbeafe15)', border: '1px solid #fde68a', borderRadius: 6 }}>
      <div style={{ fontSize: '.72rem', fontWeight: 700, color: '#92400e', marginBottom: '.35rem' }}>CONDITION</div>

      <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center', marginBottom: '.25rem' }}>
        <label style={{ fontSize: '.68rem', color: 'var(--dim)', minWidth: 35 }}>IF</label>
        <select value={cond.field || ''} onChange={(e) => onUpdate('field', e.target.value)} style={{ padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}>
          <option value="">-- field --</option>
          {siblingFields.map((f) => <option key={f} value={f}>${`{form.${f}}`}</option>)}
        </select>
        <select value={cond.operator || 'equals'} onChange={(e) => onUpdate('operator', e.target.value)} style={{ padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}>
          {['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'].map((op) => <option key={op} value={op}>{op.replace(/_/g, ' ')}</option>)}
        </select>
        {cond.operator !== 'is_empty' && cond.operator !== 'is_not_empty' && (
          <input value={cond.value || ''} placeholder="value" onChange={(e) => onUpdate('value', e.target.value)} style={{ width: 80, padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }} />
        )}
      </div>

      <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center', marginBottom: '.25rem' }}>
        <label style={{ fontSize: '.68rem', color: 'var(--gb-wa-500)', fontWeight: 600, minWidth: 35 }}>THEN</label>
        <select value={thenAct.next?.name || ''} onChange={(e) => onUpdateBranch('then_action', e.target.value)} style={{ padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}>
          <option value="">-- go to screen --</option>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center' }}>
        <label style={{ fontSize: '.68rem', color: 'var(--gb-red-500)', fontWeight: 600, minWidth: 35 }}>ELSE</label>
        <select value={elseAct.next?.name || ''} onChange={(e) => onUpdateBranch('else_action', e.target.value)} style={{ padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}>
          <option value="">-- go to screen --</option>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </div>
    </div>
  );
}

interface PreviewProps { screen: FlowScreen | null }

function Preview({ screen }: PreviewProps): ReactNode {
  if (!screen) return <div style={{ color: 'var(--dim)' }}>No screen</div>;
  return (
    <div style={{ background: 'var(--gb-neutral-0)', borderRadius: 12, padding: '.8rem', maxWidth: 260, margin: '0 auto', boxShadow: '0 1px 4px rgba(0,0,0,.12)', minHeight: 200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: '.78rem', fontWeight: 700, color: '#1a1a1a', padding: '.3rem 0 .5rem', borderBottom: '1px solid #eee', marginBottom: '.5rem' }}>
        {screen.title || screen.id}
      </div>
      {(screen.layout?.children || []).map((c, i) => <PreviewComp key={i} c={c} />)}
    </div>
  );
}

interface PreviewCompProps { c: FlowComponent }

function PreviewComp({ c }: PreviewCompProps): ReactNode {
  switch (c.type) {
    case 'TextHeading':
      return <div style={{ fontSize: '.95rem', fontWeight: 700, color: '#1a1a1a', margin: '.3rem 0' }}>{c.text}</div>;
    case 'TextSubheading':
      return <div style={{ fontSize: '.82rem', fontWeight: 600, color: '#333', margin: '.25rem 0' }}>{c.text}</div>;
    case 'TextBody':
      return <div style={{ fontSize: '.78rem', color: '#444', margin: '.2rem 0' }}>{c.text}</div>;
    case 'TextCaption':
      return <div style={{ fontSize: '.68rem', color: '#888', margin: '.15rem 0' }}>{c.text}</div>;
    case 'TextInput':
      return (
        <div style={{ margin: '.35rem 0' }}>
          <div style={{ fontSize: '.68rem', color: '#666', marginBottom: '.15rem' }}>{c.label}{c.required ? ' *' : ''}</div>
          <div style={{ border: '1px solid #ccc', borderRadius: 6, padding: '.3rem .5rem', fontSize: '.72rem', color: '#aaa' }}>{c['input-type'] || 'text'}</div>
        </div>
      );
    case 'Dropdown':
      return (
        <div style={{ margin: '.35rem 0' }}>
          <div style={{ fontSize: '.68rem', color: '#666', marginBottom: '.15rem' }}>{c.label}{c.required ? ' *' : ''}</div>
          <div style={{ border: '1px solid #ccc', borderRadius: 6, padding: '.3rem .5rem', fontSize: '.72rem', color: '#888', display: 'flex', justifyContent: 'space-between' }}>
            Select <span style={{ fontSize: '.6rem' }}>▼</span>
          </div>
        </div>
      );
    case 'RadioButtonsGroup':
      return (
        <div style={{ margin: '.35rem 0' }}>
          <div style={{ fontSize: '.68rem', color: '#666', marginBottom: '.2rem' }}>{c.label}</div>
          {(c['data-source'] || []).map((o, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '.3rem', marginBottom: '.15rem' }}>
              <span style={{ width: 14, height: 14, border: '1.5px solid #999', borderRadius: '50%', display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontSize: '.72rem', color: '#444' }}>{o.title}</span>
            </div>
          ))}
        </div>
      );
    case 'CheckboxGroup':
      return (
        <div style={{ margin: '.35rem 0' }}>
          <div style={{ fontSize: '.68rem', color: '#666', marginBottom: '.2rem' }}>{c.label}</div>
          {(c['data-source'] || []).map((o, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '.3rem', marginBottom: '.15rem' }}>
              <span style={{ width: 14, height: 14, border: '1.5px solid #999', borderRadius: 3, display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontSize: '.72rem', color: '#444' }}>{o.title}</span>
            </div>
          ))}
        </div>
      );
    case 'OptIn':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '.35rem', margin: '.35rem 0' }}>
          <span style={{ width: 14, height: 14, border: '1.5px solid #999', borderRadius: 3, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: '.72rem', color: '#444' }}>{c.label}</span>
        </div>
      );
    case 'Footer':
      return (
        <div style={{ marginTop: 'auto', paddingTop: '.5rem' }}>
          <button type="button" disabled style={{ width: '100%', background: '#25D366', color: 'var(--gb-neutral-0)', border: 'none', borderRadius: 20, padding: '.45rem', fontSize: '.78rem', fontWeight: 600 }}>{c.label}</button>
        </div>
      );
    case 'NavigationList':
      return (
        <div style={{ margin: '.35rem 0', border: '1px solid #ddd', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '.35rem .5rem', fontSize: '.72rem', fontWeight: 600, color: '#444', background: '#f5f5f5' }}>{c.label}</div>
          <div style={{ padding: '.25rem .5rem', fontSize: '.68rem', color: '#888' }}>Dynamic list items</div>
        </div>
      );
    case 'If': {
      const cond = c.condition || {};
      return (
        <div style={{ margin: '.35rem 0', border: '1px dashed #fde68a', borderRadius: 6, padding: '.4rem', background: '#fefce8' }}>
          <div style={{ fontSize: '.68rem', fontWeight: 700, color: '#92400e', marginBottom: '.2rem' }}>
            IF {cond.field ? `\${form.${cond.field}}` : '?'} {(cond.operator || '').replace(/_/g, ' ')} {cond.value || ''}
          </div>
          <div style={{ fontSize: '.65rem', color: 'var(--gb-wa-500)' }}>THEN → {c.then_action?.next?.name || '?'}</div>
          <div style={{ fontSize: '.65rem', color: 'var(--gb-red-500)' }}>ELSE → {c.else_action?.next?.name || '?'}</div>
        </div>
      );
    }
    default:
      return <div style={{ margin: '.2rem 0', fontSize: '.72rem', color: '#999', fontStyle: 'italic' }}>[{c.type}]</div>;
  }
}
