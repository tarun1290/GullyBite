import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../Toast.jsx';
import { getFlowJson, updateFlow, publishFlow } from '../../api/admin.js';

// Mirrors frontend/js/flow-editor.js — a 3-panel visual editor for
// WhatsApp Flow JSON (palette / screens + components / preview).
// Features kept 1:1 with legacy: component palette, per-screen props with
// data-schema editor, component property editor incl. data-source +
// on-click-action + If/Else conditional gates, JSON mode toggle, Save,
// Publish, Export JSON, live preview bubble.

const COMP_DEFAULTS = {
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

const PALETTE = [
  { cat: 'Text', items: ['TextHeading', 'TextSubheading', 'TextBody', 'TextCaption'] },
  { cat: 'Input', items: ['TextInput', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'OptIn'] },
  { cat: 'Navigation', items: ['Footer', 'NavigationList'] },
  { cat: 'Logic', items: ['If'] },
];

const SKIP_PROPS = ['type', 'data-source', 'on-click-action', 'list-items', 'condition', 'then_action', 'else_action', '_gb_logic'];

function blankFlow() {
  return { version: '6.2', screens: [{ id: 'SCREEN_1', title: 'Screen 1', terminal: true, layout: { type: 'SingleColumnLayout', children: [] } }] };
}

// Handles wrapper shapes (flow_json, json) + fills in missing structural keys.
function normalizeFlow(input) {
  let raw = input;
  if (raw && typeof raw === 'object') {
    if (raw.flow_json && typeof raw.flow_json === 'object') raw = raw.flow_json;
    else if (raw.json && typeof raw.json === 'object') raw = raw.json;
  }
  if (!raw || typeof raw !== 'object') return blankFlow();

  const out = { version: raw.version || '6.2', screens: [] };
  Object.keys(raw).forEach((k) => { if (k !== 'version' && k !== 'screens') out[k] = raw[k]; });

  const screens = Array.isArray(raw.screens) ? raw.screens : [];
  if (!screens.length) return { ...out, screens: blankFlow().screens };

  out.screens = screens.map((s, i) => {
    if (!s || typeof s !== 'object') s = {};
    const screen = {
      id: s.id || `SCREEN_${i + 1}`,
      title: s.title || `Screen ${i + 1}`,
      terminal: !!s.terminal,
    };
    if (s.success !== undefined) screen.success = !!s.success;
    if (s.data && typeof s.data === 'object') screen.data = s.data;
    const layout = s.layout || {};
    screen.layout = {
      type: layout.type || 'SingleColumnLayout',
      children: Array.isArray(layout.children) ? layout.children : [],
    };
    Object.keys(s).forEach((k) => {
      if (!['id', 'title', 'terminal', 'success', 'data', 'layout'].includes(k)) screen[k] = s[k];
    });
    return screen;
  });
  return out;
}

export default function FlowEditor({ flowId, flowName: initialName, flowStatus: initialStatus, onClose, onSaved }) {
  const { showToast } = useToast();
  const [flow, setFlow] = useState(blankFlow());
  const [screenIdx, setScreenIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [flowName, setFlowName] = useState(initialName || (flowId ? `Flow ${flowId}` : 'New Flow'));
  const [flowStatus, setFlowStatus] = useState(initialStatus || 'DRAFT');

  useEffect(() => {
    if (!flowId) {
      setFlow(blankFlow());
      setScreenIdx(0);
      return;
    }
    setLoading(true);
    getFlowJson(flowId)
      .then((data) => {
        setFlow(normalizeFlow(data));
        if (data?.name) setFlowName(data.name);
        if (data?.status) setFlowStatus(data.status);
      })
      .catch((err) => {
        showToast(err?.response?.data?.error || err.message || 'Failed to load flow', 'error');
        setFlow(blankFlow());
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  const screen = flow.screens[screenIdx] || null;
  const children = screen?.layout?.children || [];

  // Mutator helper — shallow clones down to the active screen so React picks up changes.
  const mutate = (fn) => {
    setFlow((prev) => {
      const next = { ...prev, screens: prev.screens.map((s) => ({ ...s, layout: { ...s.layout, children: [...(s.layout?.children || [])] } })) };
      fn(next);
      return next;
    });
  };

  // ─── Screen ops ─────────────────────────────────────────────────
  const addScreen = () => {
    mutate((next) => {
      let n = next.screens.length + 1;
      let id = `SCREEN_${n}`;
      while (next.screens.some((s) => s.id === id)) { n++; id = `SCREEN_${n}`; }
      next.screens.push({ id, title: `Screen ${n}`, terminal: false, layout: { type: 'SingleColumnLayout', children: [] } });
    });
    setScreenIdx(flow.screens.length);
  };

  const removeScreen = (idx) => {
    if (flow.screens.length <= 1) return showToast('Cannot remove last screen', 'error');
    mutate((next) => { next.screens.splice(idx, 1); });
    setScreenIdx((i) => Math.max(0, Math.min(i, flow.screens.length - 2)));
  };

  const updateScreenProp = (prop, val) => {
    mutate((next) => { next.screens[screenIdx][prop] = val; });
  };

  const addDataField = () => {
    mutate((next) => {
      const s = next.screens[screenIdx];
      if (!s.data) s.data = {};
      let n = Object.keys(s.data).length + 1;
      let key = `field_${n}`;
      while (s.data[key]) { n++; key = `field_${n}`; }
      s.data[key] = { type: 'string', __example__: '' };
    });
  };

  const renameDataField = (oldKey, newKey) => {
    if (!newKey || oldKey === newKey) return;
    mutate((next) => {
      const s = next.screens[screenIdx];
      if (!s.data) return;
      s.data[newKey] = s.data[oldKey];
      delete s.data[oldKey];
    });
  };

  const updateDataFieldType = (key, type) => {
    mutate((next) => {
      const s = next.screens[screenIdx];
      if (!s.data?.[key]) return;
      if (typeof s.data[key] === 'object') s.data[key].type = type;
      else s.data[key] = { type, __example__: '' };
    });
  };

  const removeDataField = (key) => {
    mutate((next) => {
      const s = next.screens[screenIdx];
      if (!s.data) return;
      delete s.data[key];
      if (!Object.keys(s.data).length) delete s.data;
    });
  };

  // ─── Component ops ──────────────────────────────────────────────
  const addComponent = (type) => {
    const factory = COMP_DEFAULTS[type];
    if (!factory) return showToast(`Unknown component: ${type}`, 'error');
    mutate((next) => {
      const kids = next.screens[screenIdx].layout.children;
      const comp = factory();
      if (comp.name) {
        const base = comp.name.replace(/_\d+$/, '');
        const count = kids.filter((c) => c.name && c.name.indexOf(base) === 0).length;
        if (count > 0) comp.name = `${base}_${count + 1}`;
      }
      kids.push(comp);
    });
  };

  const removeComponent = (idx) => {
    mutate((next) => { next.screens[screenIdx].layout.children.splice(idx, 1); });
  };

  const moveComponent = (idx, dir) => {
    const tgt = idx + dir;
    if (tgt < 0 || tgt >= children.length) return;
    mutate((next) => {
      const kids = next.screens[screenIdx].layout.children;
      [kids[idx], kids[tgt]] = [kids[tgt], kids[idx]];
    });
  };

  const updateComponent = (idx, prop, val) => {
    mutate((next) => { next.screens[screenIdx].layout.children[idx][prop] = val; });
  };

  // ─── Data-source ops ────────────────────────────────────────────
  const addDataSource = (compIdx) => {
    mutate((next) => {
      const ds = next.screens[screenIdx].layout.children[compIdx]['data-source'];
      if (!ds) return;
      const n = ds.length + 1;
      ds.push({ id: `opt${n}`, title: `Option ${n}` });
    });
  };

  const updateDataSource = (compIdx, itemIdx, prop, val) => {
    mutate((next) => {
      const ds = next.screens[screenIdx].layout.children[compIdx]['data-source'];
      if (ds?.[itemIdx]) ds[itemIdx][prop] = val;
    });
  };

  const removeDataSource = (compIdx, itemIdx) => {
    mutate((next) => {
      const ds = next.screens[screenIdx].layout.children[compIdx]['data-source'];
      if (ds) ds.splice(itemIdx, 1);
    });
  };

  // ─── Action ops ─────────────────────────────────────────────────
  const updateActionProp = (compIdx, prop, val) => {
    mutate((next) => {
      const act = next.screens[screenIdx].layout.children[compIdx]['on-click-action'];
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

  const addPayloadField = (compIdx) => {
    mutate((next) => {
      const act = next.screens[screenIdx].layout.children[compIdx]['on-click-action'];
      if (!act) return;
      if (!act.payload) act.payload = {};
      const n = Object.keys(act.payload).length + 1;
      act.payload[`key_${n}`] = '${form.field}';
    });
  };

  const renamePayloadField = (compIdx, oldKey, newKey) => {
    if (!newKey || oldKey === newKey) return;
    mutate((next) => {
      const act = next.screens[screenIdx].layout.children[compIdx]['on-click-action'];
      if (!act?.payload) return;
      act.payload[newKey] = act.payload[oldKey];
      delete act.payload[oldKey];
    });
  };

  const updatePayloadValue = (compIdx, key, val) => {
    mutate((next) => {
      const act = next.screens[screenIdx].layout.children[compIdx]['on-click-action'];
      if (act?.payload) act.payload[key] = val;
    });
  };

  const removePayloadField = (compIdx, key) => {
    mutate((next) => {
      const act = next.screens[screenIdx].layout.children[compIdx]['on-click-action'];
      if (act?.payload) delete act.payload[key];
    });
  };

  // ─── Conditional ops ────────────────────────────────────────────
  const updateCondition = (compIdx, prop, val) => {
    mutate((next) => {
      const c = next.screens[screenIdx].layout.children[compIdx];
      if (!c.condition) c.condition = {};
      c.condition[prop] = val;
    });
  };

  const updateBranchAction = (compIdx, actionKey, screenId) => {
    mutate((next) => {
      const c = next.screens[screenIdx].layout.children[compIdx];
      c[actionKey] = {
        name: 'navigate',
        next: { type: 'screen', name: screenId },
        payload: c[actionKey]?.payload || {},
      };
    });
  };

  // ─── Save / Publish / JSON / Export ─────────────────────────────
  const syncFromJsonMode = () => {
    try {
      return normalizeFlow(JSON.parse(jsonText));
    } catch (err) {
      showToast(`Invalid JSON: ${err.message}`, 'error');
      return null;
    }
  };

  const handleSave = async () => {
    if (!flowId) return showToast('No flow ID to save to', 'error');
    let payload = flow;
    if (jsonMode) {
      const parsed = syncFromJsonMode();
      if (!parsed) return;
      payload = parsed;
      setFlow(parsed);
    }
    if (!payload?.screens?.length) return showToast('Cannot save empty flow', 'error');
    setSaving(true);
    try {
      await updateFlow(flowId, payload);
      showToast('Flow saved', 'success');
      if (onSaved) onSaved();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const [confirmPublish, setConfirmPublish] = useState(false);
  const handlePublish = async () => {
    if (!flowId) return showToast('No flow ID', 'error');
    if (!confirmPublish) { setConfirmPublish(true); return; }
    setConfirmPublish(false);
    setPublishing(true);
    try {
      await publishFlow(flowId);
      showToast('Flow published', 'success');
      setFlowStatus('PUBLISHED');
      if (onSaved) onSaved();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Publish failed', 'error');
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
    let json = flow;
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

  // ─── Nav map ────────────────────────────────────────────────────
  const navMap = useMemo(() => {
    const parts = (flow.screens || []).map((s) => {
      const edges = [];
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
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.7rem .9rem', borderBottom: '1px solid var(--rim)', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700 }} id="fe-flow-name">{flowName}</div>
        <span id="fe-flow-status" style={{ fontSize: '.7rem', padding: '.1rem .45rem', borderRadius: 99, background: flowStatus === 'PUBLISHED' ? '#22c55e15' : '#3b82f615', color: flowStatus === 'PUBLISHED' ? '#16a34a' : '#3b82f6', fontWeight: 600 }}>{flowStatus}</span>
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
              <button type="button" className="btn-sm" style={{ background: '#dc2626', color: '#fff', border: 'none' }} onClick={handlePublish} disabled={publishing}>
                {publishing ? '…' : 'Confirm Publish'}
              </button>
              <button type="button" className="btn-sm" onClick={() => setConfirmPublish(false)} disabled={publishing}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn-sm" style={{ color: '#16a34a' }} onClick={handlePublish} disabled={publishing || !flowId}>
              Publish
            </button>
          )}
          {onClose && (
            <button type="button" className="btn-g btn-sm" onClick={onClose}>Close</button>
          )}
        </div>
      </div>

      {/* 3-panel body */}
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 300px', minHeight: 500 }}>
        {/* Palette */}
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

        {/* Middle — screens + components / JSON */}
        <div style={{ padding: '.7rem', minWidth: 0, overflow: 'hidden' }}>
          {/* Screen tabs */}
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

          {/* Screen props */}
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

              {/* Data schema */}
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
                  const v = screen.data[k];
                  const typeVal = typeof v === 'object' ? (v.type || 'string') : 'string';
                  return (
                    <div key={k} style={{ display: 'flex', gap: '.25rem', alignItems: 'center', marginBottom: '.15rem' }}>
                      <input defaultValue={k} placeholder="key" onBlur={(e) => renameDataField(k, e.target.value)} style={{ width: 80, padding: '.12rem .25rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.7rem', fontFamily: 'monospace', background: '#fff' }} />
                      <select value={typeVal} onChange={(e) => updateDataFieldType(k, e.target.value)} style={{ padding: '.12rem .25rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.7rem', background: '#fff' }}>
                        {['string', 'number', 'boolean', 'array', 'object'].map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button type="button" onClick={() => removeDataField(k)} style={{ background: 'none', border: 'none', color: 'var(--red,#dc2626)', cursor: 'pointer', fontSize: '.75rem' }}>×</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Components or JSON area */}
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
                  siblingFields={children.filter((_, ci) => ci !== i && _.name && ['TextInput', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup'].includes(_.type)).map((_) => _.name)}
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

          {/* Nav map */}
          <div id="fe-nav-map" style={{ marginTop: '.7rem', padding: '.4rem .55rem', background: 'var(--ink4,#f4f4f5)', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.74rem' }}>
            <strong>Navigation:</strong> {navMap || '—'}
          </div>
        </div>

        {/* Preview */}
        <div id="fe-preview" style={{ padding: '.7rem', borderLeft: '1px solid var(--rim)', background: 'var(--ink4,#f4f4f5)' }}>
          <Preview screen={screen} />
        </div>
      </div>
    </div>
  );
}

// ── Component card ────────────────────────────────────────────────
function ComponentCard({
  comp, idx, total, screens, siblingFields,
  onUpdate, onRemove, onMove,
  onAddDS, onUpdateDS, onRemoveDS,
  onUpdateAction, onAddPayload, onRenamePayload, onUpdatePayloadValue, onRemovePayload,
  onUpdateCondition, onUpdateBranchAction,
}) {
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
          const val = comp[key];
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
                value={val ?? ''}
                onChange={(e) => onUpdate(idx, key, e.target.value)}
                style={{ flex: 1, padding: '.2rem .4rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.76rem', background: '#fff' }}
              />
            </div>
          );
        })}

        {/* data-source editor */}
        {comp['data-source'] && (
          <div style={{ marginTop: '.25rem', padding: '.4rem', background: '#fff', border: '1px solid var(--rim)', borderRadius: 4 }}>
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

        {/* on-click-action editor */}
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

        {/* If/Else editor */}
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

function ActionEditor({ action, screens, onUpdate, onAddPayload, onRenamePayload, onUpdatePayloadValue, onRemovePayload }) {
  return (
    <div style={{ marginTop: '.25rem', padding: '.4rem', background: '#fff', border: '1px solid var(--rim)', borderRadius: 4 }}>
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
          <input value={action.payload[k] ?? ''} placeholder="value" onChange={(e) => onUpdatePayloadValue(k, e.target.value)} style={{ flex: 1, padding: '.12rem .25rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.7rem' }} />
          <button type="button" onClick={() => onRemovePayload(k)} style={{ background: 'none', border: 'none', color: 'var(--red,#dc2626)', cursor: 'pointer', fontSize: '.75rem' }}>×</button>
        </div>
      ))}
    </div>
  );
}

function ConditionEditor({ comp, screens, siblingFields, onUpdate, onUpdateBranch }) {
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
        <label style={{ fontSize: '.68rem', color: '#16a34a', fontWeight: 600, minWidth: 35 }}>THEN</label>
        <select value={thenAct.next?.name || ''} onChange={(e) => onUpdateBranch('then_action', e.target.value)} style={{ padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}>
          <option value="">-- go to screen --</option>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center' }}>
        <label style={{ fontSize: '.68rem', color: '#dc2626', fontWeight: 600, minWidth: 35 }}>ELSE</label>
        <select value={elseAct.next?.name || ''} onChange={(e) => onUpdateBranch('else_action', e.target.value)} style={{ padding: '.13rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}>
          <option value="">-- go to screen --</option>
          {screens.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </div>
    </div>
  );
}

function Preview({ screen }) {
  if (!screen) return <div style={{ color: 'var(--dim)' }}>No screen</div>;
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '.8rem', maxWidth: 260, margin: '0 auto', boxShadow: '0 1px 4px rgba(0,0,0,.12)', minHeight: 200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: '.78rem', fontWeight: 700, color: '#1a1a1a', padding: '.3rem 0 .5rem', borderBottom: '1px solid #eee', marginBottom: '.5rem' }}>
        {screen.title || screen.id}
      </div>
      {(screen.layout?.children || []).map((c, i) => <PreviewComp key={i} c={c} />)}
    </div>
  );
}

function PreviewComp({ c }) {
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
          <button type="button" disabled style={{ width: '100%', background: '#25D366', color: '#fff', border: 'none', borderRadius: 20, padding: '.45rem', fontSize: '.78rem', fontWeight: 600 }}>{c.label}</button>
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
          <div style={{ fontSize: '.65rem', color: '#16a34a' }}>THEN → {c.then_action?.next?.name || '?'}</div>
          <div style={{ fontSize: '.65rem', color: '#dc2626' }}>ELSE → {c.else_action?.next?.name || '?'}</div>
        </div>
      );
    }
    default:
      return <div style={{ margin: '.2rem 0', fontSize: '.72rem', color: '#999', fontStyle: 'italic' }}>[{c.type}]</div>;
  }
}
