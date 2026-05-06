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
    return <div className="p-8 text-center text-dim">Loading flow…</div>;
  }

  return (
    <div id="flow-editor-container" className="border border-rim rounded-lg bg-surface">
      <div className="flex items-center gap-[0.6rem] py-[0.7rem] px-[0.9rem] border-b border-rim flex-wrap">
        <div className="font-bold" id="fe-flow-name">{flowName}</div>
        <span
          id="fe-flow-status"
          className={`text-[0.7rem] py-[0.1rem] px-[0.45rem] rounded-full font-semibold ${
            flowStatus === 'PUBLISHED'
              ? 'bg-[#22c55e15] text-wa-500'
              : 'bg-[#3b82f615] text-[#3b82f6]'
          }`}
        >{flowStatus}</span>
        <div className="ml-auto flex gap-[0.4rem]">
          <button type="button" id="fe-mode-btn" className="btn-sm" onClick={toggleJsonMode}>
            {jsonMode ? 'Visual Mode' : 'JSON Mode'}
          </button>
          <button type="button" className="btn-sm" onClick={exportJson}>Export JSON</button>
          <button type="button" className="btn-p btn-sm" onClick={handleSave} disabled={saving || !flowId}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {confirmPublish ? (
            <>
              <button type="button" className="btn-sm bg-red-500 text-neutral-0 border-0" onClick={handlePublish} disabled={publishing}>
                {publishing ? '…' : 'Confirm Publish'}
              </button>
              <button type="button" className="btn-sm" onClick={() => setConfirmPublish(false)} disabled={publishing}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn-sm text-wa-500" onClick={handlePublish} disabled={publishing || !flowId}>
              Publish
            </button>
          )}
          {onClose && (
            <button type="button" className="btn-g btn-sm" onClick={onClose}>Close</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[180px_1fr_300px] min-h-[500px]">
        <div id="fe-palette" className="p-[0.7rem] border-r border-rim text-sm">
          <div className="font-bold mb-2 text-[0.74rem] text-dim uppercase">Components</div>
          {PALETTE.map((g) => (
            <div key={g.cat}>
              <div className="font-semibold text-[0.7rem] text-mute mt-2 mb-[0.2rem] uppercase">{g.cat}</div>
              {g.items.map((t) => (
                <div
                  key={t}
                  onClick={() => addComponent(t)}
                  className="py-1 px-[0.45rem] cursor-pointer rounded-[4px] mb-[2px] hover:bg-ink4"
                >
                  {t}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="p-[0.7rem] min-w-0 overflow-hidden">
          <div id="fe-screen-tabs" className="flex gap-[0.2rem] border-b border-rim mb-[0.6rem] overflow-x-auto">
            {flow.screens.map((s, i) => (
              <div
                key={s.id + '_' + i}
                onClick={() => setScreenIdx(i)}
                className={`py-[0.4rem] px-[0.8rem] cursor-pointer text-[0.78rem] whitespace-nowrap border-b-2 ${
                  i === screenIdx
                    ? 'font-bold text-acc border-acc'
                    : 'font-medium text-dim border-transparent'
                }`}
              >
                {s.id}
              </div>
            ))}
            <div onClick={addScreen} className="py-[0.4rem] px-[0.6rem] cursor-pointer font-bold text-mute" title="Add screen">+</div>
          </div>

          {screen && !jsonMode && (
            <div id="fe-screen-props" className="mb-[0.7rem]">
              <div className="flex gap-2 items-center flex-wrap">
                <label className="text-[0.7rem] text-dim font-semibold">ID</label>
                <input
                  value={screen.id}
                  onChange={(e) => updateScreenProp('id', e.target.value)}
                  className="w-[120px] py-[0.2rem] px-[0.45rem] border border-rim rounded-[4px] font-mono text-[0.76rem]"
                />
                <label className="text-[0.7rem] text-dim font-semibold ml-[0.3rem]">Title</label>
                <input
                  value={screen.title || ''}
                  onChange={(e) => updateScreenProp('title', e.target.value)}
                  className="w-[150px] py-[0.2rem] px-[0.45rem] border border-rim rounded-[4px] text-[0.76rem]"
                />
                <label className="text-[0.7rem] text-dim font-semibold ml-[0.3rem]">Terminal</label>
                <input type="checkbox" checked={!!screen.terminal} onChange={(e) => updateScreenProp('terminal', e.target.checked)} />
                <label className="text-[0.7rem] text-dim font-semibold ml-[0.3rem]">Success</label>
                <input type="checkbox" checked={!!screen.success} onChange={(e) => updateScreenProp('success', e.target.checked)} />
                {flow.screens.length > 1 && (
                  <button type="button" className="btn-sm ml-auto text-red text-[0.7rem]" onClick={() => removeScreen(screenIdx)}>
                    Remove Screen
                  </button>
                )}
              </div>

              <div className="mt-2 p-[0.4rem] bg-ink4 border border-rim rounded-[4px]">
                <div className="flex items-center mb-1">
                  <span className="text-[0.7rem] font-semibold text-dim">Screen Data (input variables)</span>
                  <button type="button" className="btn-sm ml-auto text-[0.62rem] py-[0.05rem] px-[0.35rem]" onClick={addDataField}>+ Add</button>
                </div>
                {!screen.data || !Object.keys(screen.data).length ? (
                  <div className="text-[0.68rem] text-mute italic">
                    No data fields. Add one if this screen needs input from a previous screen.
                  </div>
                ) : Object.keys(screen.data).map((k) => {
                  const v = (screen.data as Record<string, unknown>)[k];
                  const typeVal = typeof v === 'object' && v !== null ? ((v as Record<string, unknown>).type as string || 'string') : 'string';
                  return (
                    <div key={k} className="flex gap-1 items-center mb-[0.15rem]">
                      <input defaultValue={k} placeholder="key" onBlur={(e) => renameDataField(k, e.target.value)} className="w-20 py-[0.12rem] px-1 border border-rim rounded-[4px] text-[0.7rem] font-mono bg-neutral-0" />
                      <select value={typeVal} onChange={(e) => updateDataFieldType(k, e.target.value)} className="py-[0.12rem] px-1 border border-rim rounded-[4px] text-[0.7rem] bg-neutral-0">
                        {['string', 'number', 'boolean', 'array', 'object'].map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button type="button" onClick={() => removeDataField(k)} className="bg-none border-0 text-red cursor-pointer text-[0.75rem]">×</button>
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
                className="w-full font-mono text-[0.78rem] p-2 border border-rim rounded-[4px]"
              />
            </div>
          ) : (
            <div id="fe-components">
              {!children.length ? (
                <div className="p-6 text-center text-mute text-[0.82rem]">
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

          <div id="fe-nav-map" className="mt-[0.7rem] py-[0.4rem] px-[0.55rem] bg-ink4 border border-rim rounded-[4px] text-[0.74rem]">
            <strong>Navigation:</strong> {navMap || '—'}
          </div>
        </div>

        <div id="fe-preview" className="p-[0.7rem] border-l border-rim bg-ink4">
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
    <div className="bg-ink4 border border-rim rounded-md p-[0.55rem] mb-2">
      <div className="flex items-center gap-[0.4rem] mb-[0.4rem]">
        <span className="bg-[rgba(79,70,229,0.08)] text-acc text-[0.66rem] font-bold py-[0.1rem] px-[0.4rem] rounded-[4px]">{comp.type}</span>
        <div className="ml-auto flex gap-[0.2rem]">
          {idx > 0 && <button type="button" className="btn-sm py-[0.1rem] px-[0.35rem] text-[0.7rem]" onClick={() => onMove(idx, -1)} title="Move up">↑</button>}
          {idx < total - 1 && <button type="button" className="btn-sm py-[0.1rem] px-[0.35rem] text-[0.7rem]" onClick={() => onMove(idx, 1)} title="Move down">↓</button>}
          <button type="button" className="btn-sm py-[0.1rem] px-[0.35rem] text-[0.7rem] text-red" onClick={() => onRemove(idx)} title="Remove">×</button>
        </div>
      </div>

      <div className="flex flex-col gap-[0.3rem]">
        {Object.keys(comp).filter((k) => !SKIP_PROPS.includes(k)).map((key) => {
          const val = (comp as Record<string, unknown>)[key];
          if (typeof val === 'boolean') {
            return (
              <div key={key} className="flex items-center gap-[0.4rem]">
                <label className="text-[0.7rem] text-dim font-semibold min-w-[60px]">{key}</label>
                <input type="checkbox" checked={val} onChange={(e) => onUpdate(idx, key, e.target.checked)} />
              </div>
            );
          }
          return (
            <div key={key} className="flex items-center gap-[0.4rem]">
              <label className="text-[0.7rem] text-dim font-semibold min-w-[60px]">{key}</label>
              <input
                value={(val as string | number | undefined) ?? ''}
                onChange={(e) => onUpdate(idx, key, e.target.value)}
                className="flex-1 py-[0.2rem] px-[0.4rem] border border-rim rounded-[4px] text-[0.76rem] bg-neutral-0"
              />
            </div>
          );
        })}

        {comp['data-source'] && (
          <div className="mt-1 p-[0.4rem] bg-neutral-0 border border-rim rounded-[4px]">
            <div className="flex items-center mb-[0.3rem]">
              <span className="text-[0.7rem] font-semibold text-dim">data-source</span>
              <button type="button" className="btn-sm ml-auto text-[0.63rem] py-[0.05rem] px-[0.35rem]" onClick={() => onAddDS(idx)}>+ Add</button>
            </div>
            {comp['data-source'].map((item, ii) => (
              <div key={ii} className="flex gap-1 items-center mb-[0.2rem]">
                <input value={item.id || ''} placeholder="id" onChange={(e) => onUpdateDS(idx, ii, 'id', e.target.value)} className="w-[70px] py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]" />
                <input value={item.title || ''} placeholder="title" onChange={(e) => onUpdateDS(idx, ii, 'title', e.target.value)} className="flex-1 py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]" />
                <button type="button" onClick={() => onRemoveDS(idx, ii)} className="bg-none border-0 text-red cursor-pointer text-[0.78rem]">×</button>
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
    <div className="mt-1 p-[0.4rem] bg-neutral-0 border border-rim rounded-[4px]">
      <div className="text-[0.7rem] font-semibold text-dim mb-[0.3rem]">on-click-action</div>

      <div className="flex gap-[0.3rem] items-center mb-1">
        <label className="text-[0.68rem] text-dim min-w-[50px]">action</label>
        <select value={action.name || ''} onChange={(e) => onUpdate('name', e.target.value)} className="py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]">
          {['navigate', 'complete', 'data_exchange'].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {action.name === 'navigate' && (
        <div className="flex gap-[0.3rem] items-center mb-1">
          <label className="text-[0.68rem] text-dim min-w-[50px]">next</label>
          <select value={action.next?.name || ''} onChange={(e) => onUpdate('next_screen', e.target.value)} className="py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]">
            <option value="">-- select --</option>
            {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </div>
      )}

      <div className="flex items-center mt-1 mb-[0.15rem]">
        <span className="text-[0.68rem] text-dim">payload</span>
        <button type="button" className="btn-sm ml-auto text-[0.62rem] py-[0.05rem] px-[0.3rem]" onClick={onAddPayload}>+ field</button>
      </div>
      {Object.keys(action.payload || {}).map((k) => (
        <div key={k} className="flex gap-1 items-center mb-[0.15rem]">
          <input defaultValue={k} placeholder="key" onBlur={(e) => onRenamePayload(k, e.target.value)} className="w-[70px] py-[0.12rem] px-1 border border-rim rounded-[4px] text-[0.7rem]" />
          <input value={action.payload?.[k] ?? ''} placeholder="value" onChange={(e) => onUpdatePayloadValue(k, e.target.value)} className="flex-1 py-[0.12rem] px-1 border border-rim rounded-[4px] text-[0.7rem]" />
          <button type="button" onClick={() => onRemovePayload(k)} className="bg-none border-0 text-red cursor-pointer text-[0.75rem]">×</button>
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
    <div className="mt-[0.35rem] p-2 bg-[linear-gradient(135deg,#fef3c710,#dbeafe15)] border border-amber-200 rounded-md">
      <div className="text-[0.72rem] font-bold text-amber-800 mb-[0.35rem]">CONDITION</div>

      <div className="flex gap-[0.3rem] items-center mb-1">
        <label className="text-[0.68rem] text-dim min-w-[35px]">IF</label>
        <select value={cond.field || ''} onChange={(e) => onUpdate('field', e.target.value)} className="py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]">
          <option value="">-- field --</option>
          {siblingFields.map((f) => <option key={f} value={f}>${`{form.${f}}`}</option>)}
        </select>
        <select value={cond.operator || 'equals'} onChange={(e) => onUpdate('operator', e.target.value)} className="py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]">
          {['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'].map((op) => <option key={op} value={op}>{op.replace(/_/g, ' ')}</option>)}
        </select>
        {cond.operator !== 'is_empty' && cond.operator !== 'is_not_empty' && (
          <input value={cond.value || ''} placeholder="value" onChange={(e) => onUpdate('value', e.target.value)} className="w-20 py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]" />
        )}
      </div>

      <div className="flex gap-[0.3rem] items-center mb-1">
        <label className="text-[0.68rem] text-wa-500 font-semibold min-w-[35px]">THEN</label>
        <select value={thenAct.next?.name || ''} onChange={(e) => onUpdateBranch('then_action', e.target.value)} className="py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]">
          <option value="">-- go to screen --</option>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </div>

      <div className="flex gap-[0.3rem] items-center">
        <label className="text-[0.68rem] text-red-500 font-semibold min-w-[35px]">ELSE</label>
        <select value={elseAct.next?.name || ''} onChange={(e) => onUpdateBranch('else_action', e.target.value)} className="py-[0.13rem] px-[0.3rem] border border-rim rounded-[4px] text-[0.72rem]">
          <option value="">-- go to screen --</option>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </div>
    </div>
  );
}

interface PreviewProps { screen: FlowScreen | null }

function Preview({ screen }: PreviewProps): ReactNode {
  if (!screen) return <div className="text-dim">No screen</div>;
  return (
    <div className="bg-neutral-0 rounded-xl p-[0.8rem] max-w-[260px] mx-auto shadow-[0_1px_4px_rgba(0,0,0,0.12)] min-h-[200px] flex flex-col">
      <div className="text-[0.78rem] font-bold text-[#1a1a1a] pt-[0.3rem] pb-2 border-b border-[#eee] mb-2">
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
      return <div className="text-[0.95rem] font-bold text-[#1a1a1a] my-[0.3rem]">{c.text}</div>;
    case 'TextSubheading':
      return <div className="text-[0.82rem] font-semibold text-[#333] my-1">{c.text}</div>;
    case 'TextBody':
      return <div className="text-[0.78rem] text-[#444] my-[0.2rem]">{c.text}</div>;
    case 'TextCaption':
      return <div className="text-[0.68rem] text-[#888] my-[0.15rem]">{c.text}</div>;
    case 'TextInput':
      return (
        <div className="my-[0.35rem]">
          <div className="text-[0.68rem] text-[#666] mb-[0.15rem]">{c.label}{c.required ? ' *' : ''}</div>
          <div className="border border-[#ccc] rounded-md py-[0.3rem] px-2 text-[0.72rem] text-[#aaa]">{c['input-type'] || 'text'}</div>
        </div>
      );
    case 'Dropdown':
      return (
        <div className="my-[0.35rem]">
          <div className="text-[0.68rem] text-[#666] mb-[0.15rem]">{c.label}{c.required ? ' *' : ''}</div>
          <div className="border border-[#ccc] rounded-md py-[0.3rem] px-2 text-[0.72rem] text-[#888] flex justify-between">
            Select <span className="text-[0.6rem]">▼</span>
          </div>
        </div>
      );
    case 'RadioButtonsGroup':
      return (
        <div className="my-[0.35rem]">
          <div className="text-[0.68rem] text-[#666] mb-[0.2rem]">{c.label}</div>
          {(c['data-source'] || []).map((o, i) => (
            <div key={i} className="flex items-center gap-[0.3rem] mb-[0.15rem]">
              <span className="w-[14px] h-[14px] border-[1.5px] border-[#999] rounded-full inline-block shrink-0" />
              <span className="text-[0.72rem] text-[#444]">{o.title}</span>
            </div>
          ))}
        </div>
      );
    case 'CheckboxGroup':
      return (
        <div className="my-[0.35rem]">
          <div className="text-[0.68rem] text-[#666] mb-[0.2rem]">{c.label}</div>
          {(c['data-source'] || []).map((o, i) => (
            <div key={i} className="flex items-center gap-[0.3rem] mb-[0.15rem]">
              <span className="w-[14px] h-[14px] border-[1.5px] border-[#999] rounded-[3px] inline-block shrink-0" />
              <span className="text-[0.72rem] text-[#444]">{o.title}</span>
            </div>
          ))}
        </div>
      );
    case 'OptIn':
      return (
        <div className="flex items-center gap-[0.35rem] my-[0.35rem]">
          <span className="w-[14px] h-[14px] border-[1.5px] border-[#999] rounded-[3px] inline-block shrink-0" />
          <span className="text-[0.72rem] text-[#444]">{c.label}</span>
        </div>
      );
    case 'Footer':
      return (
        <div className="mt-auto pt-2">
          <button type="button" disabled className="w-full bg-[#25D366] text-neutral-0 border-0 rounded-[20px] p-[0.45rem] text-[0.78rem] font-semibold">{c.label}</button>
        </div>
      );
    case 'NavigationList':
      return (
        <div className="my-[0.35rem] border border-[#ddd] rounded-lg overflow-hidden">
          <div className="py-[0.35rem] px-2 text-[0.72rem] font-semibold text-[#444] bg-[#f5f5f5]">{c.label}</div>
          <div className="py-1 px-2 text-[0.68rem] text-[#888]">Dynamic list items</div>
        </div>
      );
    case 'If': {
      const cond = c.condition || {};
      return (
        <div className="my-[0.35rem] border border-dashed border-amber-200 rounded-md p-[0.4rem] bg-yellow-50">
          <div className="text-[0.68rem] font-bold text-amber-800 mb-[0.2rem]">
            IF {cond.field ? `\${form.${cond.field}}` : '?'} {(cond.operator || '').replace(/_/g, ' ')} {cond.value || ''}
          </div>
          <div className="text-[0.65rem] text-wa-500">THEN → {c.then_action?.next?.name || '?'}</div>
          <div className="text-[0.65rem] text-red-500">ELSE → {c.else_action?.next?.name || '?'}</div>
        </div>
      );
    }
    default:
      return <div className="my-[0.2rem] text-[0.72rem] text-[#999] italic">[{c.type}]</div>;
  }
}
