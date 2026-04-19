import { useEffect, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import FlowEditor from '../../components/admin/FlowEditor.jsx';
import {
  getFlows,
  getFlowAssignments,
  publishFlow,
  deprecateFlow,
  deleteFlow,
  assignFlowAs,
  getFlowTemplates,
  createFlow,
} from '../../api/admin.js';

// Mirrors the "Flows" section in admin.html (4782-4900ish):
//   #flow-library + #flow-assignments + "Create New Flow" form and
//   the visual editor opened via openFlowEditor(flowId).
// Destructive confirms (publish / deprecate / delete / assign) are now
// inline two-click rows — no window.confirm().

const STATUS_COLORS = {
  DRAFT: '#3b82f6',
  PUBLISHED: '#22c55e',
  DEPRECATED: '#94a3b8',
  BLOCKED: '#dc2626',
};

function formatUpdated(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export default function AdminFlows() {
  const { showToast } = useToast();
  const [flows, setFlows] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { id, name, status } | 'new' | null
  const [rowBusy, setRowBusy] = useState(null);
  const [pendingAction, setPendingAction] = useState(null); // { kind, id, name }

  // Create-flow form
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('OTHER');
  const [newJson, setNewJson] = useState('');
  const [newResult, setNewResult] = useState(null);
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [fl, as] = await Promise.all([
        getFlows(),
        getFlowAssignments().catch(() => ({})),
      ]);
      setFlows(Array.isArray(fl?.flows) ? fl.flows : []);
      setAssignments(as || {});
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load flows', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const doPublish = async (id) => {
    setRowBusy(id);
    try {
      await publishFlow(id);
      showToast('Flow published', 'success');
      setPendingAction(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Publish failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doDeprecate = async (id) => {
    setRowBusy(id);
    try {
      await deprecateFlow(id);
      showToast('Flow deprecated', 'success');
      setPendingAction(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Deprecate failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doDelete = async (id) => {
    setRowBusy(id);
    try {
      await deleteFlow(id);
      showToast('Flow deleted', 'success');
      setPendingAction(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Delete failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doAssign = async (type, id, name) => {
    setRowBusy(id);
    try {
      await assignFlowAs(type, id, name);
      showToast(`${type} Flow assigned`, 'success');
      setPendingAction(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Assign failed', 'error');
    } finally { setRowBusy(null); }
  };

  const loadTemplate = async (tplId) => {
    if (!tplId) return;
    let list = templates;
    if (!templatesLoaded) {
      try {
        const r = await getFlowTemplates();
        list = r?.templates || [];
        setTemplates(list);
        setTemplatesLoaded(true);
      } catch (err) {
        showToast('Failed to load templates: ' + err.message, 'error');
        return;
      }
    }
    const tpl = list.find((t) => t.id === tplId);
    if (tpl) setNewJson(JSON.stringify(tpl.json, null, 2));
  };

  const validateJson = () => {
    try {
      const parsed = JSON.parse(newJson);
      if (!parsed.version) throw new Error('Missing "version" field');
      if (!parsed.screens?.length) throw new Error('Missing or empty "screens" array');
      setNewResult({ ok: true, msg: `✅ Valid JSON — ${parsed.screens.length} screen(s), version ${parsed.version}` });
    } catch (err) {
      setNewResult({ ok: false, msg: `❌ ${err.message}` });
    }
  };

  const doCreate = async () => {
    const name = newName.trim();
    if (!name) return showToast('Flow name is required', 'error');
    const body = { name, categories: [newCategory] };
    if (newJson.trim()) {
      try { JSON.parse(newJson); body.flow_json = newJson; }
      catch (err) { return showToast('Invalid JSON: ' + err.message, 'error'); }
    }
    setCreating(true);
    try {
      const r = await createFlow(body);
      setNewResult({
        ok: true,
        msg: `✅ Flow created: ${r.flow_id}${r.validation_errors?.length ? ` (${r.validation_errors.length} warnings)` : ''}`,
      });
      setNewName('');
      setNewJson('');
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Create failed', 'error');
    } finally {
      setCreating(false);
    }
  };

  if (editing) {
    return (
      <FlowEditor
        flowId={editing === 'new' ? null : editing.id}
        flowName={editing === 'new' ? 'New Flow' : editing.name}
        flowStatus={editing === 'new' ? 'DRAFT' : editing.status}
        onClose={() => setEditing(null)}
        onSaved={load}
      />
    );
  }

  return (
    <div>
      {/* Assignments card */}
      <div className="card">
        <div className="ch"><h3>🔗 Flow Assignments</h3></div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading…</p>
          ) : (
            <>
              <AssignmentRow label="Delivery Address" a={assignments.delivery || {}} />
              <AssignmentRow label="Order Feedback" a={assignments.feedback || {}} />
            </>
          )}
        </div>
      </div>

      {/* Library card */}
      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>📚 Flow Library</h3>
          <button type="button" className="btn-p btn-sm" onClick={() => setEditing('new')}>+ New Flow</button>
        </div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading from Meta…</p>
          ) : !flows.length ? (
            <p style={{ color: 'var(--dim)' }}>No Flows found on this WABA.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase' }}>
                    <th style={{ padding: '.45rem' }}>Name</th>
                    <th style={{ padding: '.45rem' }}>Flow ID</th>
                    <th style={{ padding: '.45rem' }}>Status</th>
                    <th style={{ padding: '.45rem' }}>Version</th>
                    <th style={{ padding: '.45rem' }}>Updated</th>
                    <th style={{ padding: '.45rem', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {flows.map((f) => {
                    const color = STATUS_COLORS[f.status] || '#6b7280';
                    const busy = rowBusy === f.id;
                    const pending = pendingAction && pendingAction.id === f.id ? pendingAction : null;
                    return (
                      <tr key={f.id} style={{ borderBottom: '1px solid var(--rim)' }}>
                        <td style={{ padding: '.45rem', fontSize: '.84rem', fontWeight: 500 }}>{f.name || '—'}</td>
                        <td style={{ padding: '.45rem', fontSize: '.72rem', color: 'var(--dim)', fontFamily: 'monospace' }}>{f.id}</td>
                        <td style={{ padding: '.45rem' }}>
                          <span style={{ display: 'inline-block', padding: '.15rem .45rem', borderRadius: 99, fontSize: '.68rem', fontWeight: 600, background: `${color}15`, color, border: `1px solid ${color}30` }}>
                            {f.status}
                          </span>
                        </td>
                        <td style={{ padding: '.45rem', fontSize: '.76rem' }}>{f.json_version || '—'}</td>
                        <td style={{ padding: '.45rem', fontSize: '.76rem', color: 'var(--dim)' }}>{formatUpdated(f.updated_at)}</td>
                        <td style={{ padding: '.45rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {pending ? (
                            <InlineConfirm
                              pending={pending}
                              busy={busy}
                              onCancel={() => setPendingAction(null)}
                              onConfirm={() => {
                                if (pending.kind === 'publish') doPublish(f.id);
                                else if (pending.kind === 'deprecate') doDeprecate(f.id);
                                else if (pending.kind === 'delete') doDelete(f.id);
                                else if (pending.kind === 'assign') doAssign(pending.assignType, f.id, f.name);
                              }}
                            />
                          ) : (
                            <RowActions
                              flow={f}
                              busy={busy}
                              onEdit={() => setEditing({ id: f.id, name: f.name, status: f.status })}
                              onAsk={(kind, extra = {}) => setPendingAction({ id: f.id, name: f.name, kind, ...extra })}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Create-new card */}
      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch"><h3>✨ Create New Flow</h3></div>
        <div className="cb">
          <div className="fgrid">
            <div className="fg">
              <label>Flow Name ★</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. feedback_v2" />
            </div>
            <div className="fg">
              <label>Category</label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                style={{ padding: '.45rem', border: '1px solid var(--rim)', borderRadius: 6, width: '100%' }}
              >
                {['OTHER', 'SIGN_UP', 'SIGN_IN', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION', 'SHOPPING', 'SURVEY', 'CONTACT_US', 'CUSTOMER_SUPPORT'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="fg span2">
              <label>Starter Template</label>
              <select
                onChange={(e) => loadTemplate(e.target.value)}
                style={{ padding: '.45rem', border: '1px solid var(--rim)', borderRadius: 6, width: '100%' }}
                defaultValue=""
              >
                <option value="">-- Blank --</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
              </select>
            </div>
            <div className="fg span2">
              <label>Flow JSON <small style={{ color: 'var(--dim)' }}>(optional)</small></label>
              <textarea
                value={newJson}
                onChange={(e) => setNewJson(e.target.value)}
                rows={8}
                placeholder='{ "version": "6.2", "screens": [ ... ] }'
                style={{ width: '100%', fontFamily: 'monospace', fontSize: '.78rem', padding: '.5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '.5rem', marginTop: '.7rem' }}>
            <button type="button" className="btn-p" onClick={doCreate} disabled={creating}>
              {creating ? 'Creating…' : '+ Create Flow'}
            </button>
            <button type="button" className="btn-g" onClick={validateJson} disabled={!newJson.trim()}>
              Validate JSON
            </button>
          </div>

          {newResult && (
            <div
              style={{
                marginTop: '.6rem', padding: '.5rem .7rem', borderRadius: 6,
                background: newResult.ok ? '#f0fdf4' : '#fff1f2',
                color: newResult.ok ? '#15803d' : '#dc2626',
                fontSize: '.82rem',
              }}
            >
              {newResult.msg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AssignmentRow({ label, a }) {
  const color = { PUBLISHED: '#22c55e', DRAFT: '#3b82f6' }[a.flow_status] || '#6b7280';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.5rem 0', borderBottom: '1px solid var(--rim)' }}>
      <span style={{ fontWeight: 600, minWidth: 140 }}>{label}</span>
      <span>
        {a.flow_id ? (
          <>
            <span style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>{a.flow_id}</span>
            {a.flow_name && <span style={{ fontSize: '.78rem' }}> ({a.flow_name})</span>}
            {a.flow_status && (
              <span style={{ fontSize: '.66rem', padding: '.1rem .35rem', borderRadius: 99, background: `${color}15`, color, marginLeft: '.4rem' }}>
                {a.flow_status}
              </span>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--mute,#94a3b8)', fontStyle: 'italic' }}>Not assigned</span>
        )}
      </span>
    </div>
  );
}

function RowActions({ flow, busy, onEdit, onAsk }) {
  return (
    <>
      <button type="button" className="btn-sm" style={{ fontSize: '.7rem' }} onClick={onEdit} disabled={busy}>Edit</button>
      {flow.status === 'DRAFT' && (
        <>
          <button type="button" className="btn-sm" style={{ fontSize: '.7rem', color: '#16a34a', marginLeft: '.25rem' }} onClick={() => onAsk('publish')} disabled={busy}>Publish</button>
          <button type="button" className="btn-sm" style={{ fontSize: '.7rem', color: 'var(--red,#dc2626)', marginLeft: '.25rem' }} onClick={() => onAsk('delete')} disabled={busy}>Delete</button>
        </>
      )}
      {flow.status === 'PUBLISHED' && (
        <>
          <button type="button" className="btn-sm" style={{ fontSize: '.7rem', marginLeft: '.25rem' }} onClick={() => onAsk('assign', { assignType: 'delivery' })} disabled={busy}>Assign Delivery</button>
          <button type="button" className="btn-sm" style={{ fontSize: '.7rem', marginLeft: '.25rem' }} onClick={() => onAsk('assign', { assignType: 'feedback' })} disabled={busy}>Assign Feedback</button>
          <button type="button" className="btn-sm" style={{ fontSize: '.7rem', color: 'var(--dim)', marginLeft: '.25rem' }} onClick={() => onAsk('deprecate')} disabled={busy}>Deprecate</button>
        </>
      )}
      {flow.status === 'DEPRECATED' && (
        <button type="button" className="btn-sm" style={{ fontSize: '.7rem', color: 'var(--red,#dc2626)', marginLeft: '.25rem' }} onClick={() => onAsk('delete')} disabled={busy}>Delete</button>
      )}
    </>
  );
}

function InlineConfirm({ pending, busy, onConfirm, onCancel }) {
  let label = pending.kind;
  let bg = '#dc2626';
  if (pending.kind === 'publish') { label = 'Confirm publish?'; bg = '#16a34a'; }
  else if (pending.kind === 'deprecate') { label = 'Confirm deprecate?'; bg = '#6b7280'; }
  else if (pending.kind === 'delete') { label = `Delete "${pending.name || pending.id}"?`; bg = '#dc2626'; }
  else if (pending.kind === 'assign') { label = `Assign as ${pending.assignType}?`; bg = '#4f46e5'; }
  return (
    <span style={{ display: 'inline-flex', gap: '.25rem', alignItems: 'center' }}>
      <span style={{ fontSize: '.7rem', color: 'var(--dim)', marginRight: '.2rem' }}>{label}</span>
      <button type="button" className="btn-sm" style={{ fontSize: '.7rem', background: bg, color: '#fff', border: 'none', borderRadius: 4, padding: '.15rem .5rem' }} onClick={onConfirm} disabled={busy}>
        {busy ? '…' : 'Confirm'}
      </button>
      <button type="button" className="btn-g btn-sm" style={{ fontSize: '.7rem' }} onClick={onCancel} disabled={busy}>Cancel</button>
    </span>
  );
}
