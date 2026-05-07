'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import FlowEditor from '../../../components/admin/FlowEditor';
import {
  getFlows,
  getFlowAssignments,
  publishFlow,
  deprecateFlow,
  deleteFlow,
  assignFlowAs,
  getFlowTemplates,
  createFlow,
} from '../../../api/admin';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#3b82f6',
  PUBLISHED: '#22c55e',
  DEPRECATED: 'var(--gb-slate-400)',
  BLOCKED: 'var(--gb-red-500)',
};

interface FlowRow {
  id: string;
  name?: string;
  status?: string;
  json_version?: string;
  updated_at?: string;
}

interface FlowsResponse { flows?: FlowRow[] }

interface AssignmentEntry {
  flow_id?: string;
  flow_name?: string;
  flow_status?: string;
}

interface AssignmentsMap {
  delivery?: AssignmentEntry;
  feedback?: AssignmentEntry;
}

interface FlowTemplate {
  id: string;
  name?: string;
  json?: unknown;
}

interface FlowTemplatesResponse { templates?: FlowTemplate[] }

interface CreateResult { flow_id?: string; validation_errors?: unknown[] }

type EditingState = 'new' | { id: string; name?: string; status?: string } | null;

interface PendingAction {
  id: string;
  name?: string;
  kind: 'publish' | 'deprecate' | 'delete' | 'assign';
  assignType?: string;
}

interface NewResult { ok: boolean; msg: string }

function formatUpdated(ts?: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export default function AdminFlowsPage() {
  const { showToast } = useToast();
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentsMap>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [editing, setEditing] = useState<EditingState>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const [newName, setNewName] = useState<string>('');
  const [newCategory, setNewCategory] = useState<string>('OTHER');
  const [newJson, setNewJson] = useState<string>('');
  const [newResult, setNewResult] = useState<NewResult | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [templates, setTemplates] = useState<FlowTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState<boolean>(false);

  const load = async () => {
    setLoading(true);
    try {
      const [fl, as] = await Promise.all([
        getFlows() as Promise<FlowsResponse | null>,
        (getFlowAssignments() as Promise<AssignmentsMap | null>).catch(() => ({} as AssignmentsMap)),
      ]);
      setFlows(Array.isArray(fl?.flows) ? fl.flows : []);
      setAssignments(as || {});
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load flows', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // No backend cache for flows — GET /api/admin/flows already calls Meta
  // directly, so this button just re-fetches and refreshes React state.
  // Labelled "Sync from Meta" to match the Templates page Sync button.
  const handleSyncFromMeta = async () => {
    setSyncing(true);
    try {
      const fl = (await getFlows()) as FlowsResponse | null;
      setFlows(Array.isArray(fl?.flows) ? fl.flows : []);
      showToast('Flows refreshed from Meta', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'error');
    } finally { setSyncing(false); }
  };

  const doPublish = async (id: string) => {
    setRowBusy(id);
    try {
      await publishFlow(id);
      showToast('Flow published', 'success');
      setPendingAction(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Publish failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doDeprecate = async (id: string) => {
    setRowBusy(id);
    try {
      await deprecateFlow(id);
      showToast('Flow deprecated', 'success');
      setPendingAction(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Deprecate failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doDelete = async (id: string) => {
    setRowBusy(id);
    try {
      await deleteFlow(id);
      showToast('Flow deleted', 'success');
      setPendingAction(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doAssign = async (type: string, id: string, name: string) => {
    setRowBusy(id);
    try {
      await assignFlowAs(type, id, name);
      showToast(`${type} Flow assigned`, 'success');
      setPendingAction(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Assign failed', 'error');
    } finally { setRowBusy(null); }
  };

  const loadTemplate = async (tplId: string) => {
    if (!tplId) return;
    let list = templates;
    if (!templatesLoaded) {
      try {
        const r = (await getFlowTemplates()) as FlowTemplatesResponse | null;
        list = r?.templates || [];
        setTemplates(list);
        setTemplatesLoaded(true);
      } catch (err: unknown) {
        const e = err as { message?: string };
        showToast('Failed to load templates: ' + (e.message || ''), 'error');
        return;
      }
    }
    const tpl = list.find((t) => t.id === tplId);
    if (tpl) setNewJson(JSON.stringify(tpl.json, null, 2));
  };

  const validateJson = () => {
    try {
      const parsed = JSON.parse(newJson) as { version?: string; screens?: unknown[] };
      if (!parsed.version) throw new Error('Missing "version" field');
      if (!parsed.screens?.length) throw new Error('Missing or empty "screens" array');
      setNewResult({ ok: true, msg: `✅ Valid JSON — ${parsed.screens.length} screen(s), version ${parsed.version}` });
    } catch (err: unknown) {
      const e = err as { message?: string };
      setNewResult({ ok: false, msg: `❌ ${e.message || 'Parse failed'}` });
    }
  };

  const doCreate = async () => {
    const name = newName.trim();
    if (!name) { showToast('Flow name is required', 'error'); return; }
    const body: Record<string, unknown> = { name, categories: [newCategory] };
    if (newJson.trim()) {
      try { JSON.parse(newJson); body.flow_json = newJson; }
      catch (err: unknown) {
        const e = err as { message?: string };
        showToast('Invalid JSON: ' + (e.message || ''), 'error');
        return;
      }
    }
    setCreating(true);
    try {
      const r = (await createFlow(body)) as CreateResult | null;
      setNewResult({
        ok: true,
        msg: `✅ Flow created: ${r?.flow_id}${r?.validation_errors?.length ? ` (${r.validation_errors.length} warnings)` : ''}`,
      });
      setNewName('');
      setNewJson('');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Create failed', 'error');
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
      <div className="card">
        <div className="ch"><h3>🔗 Flow Assignments</h3></div>
        <div className="cb">
          {loading ? (
            <p className="text-dim">Loading…</p>
          ) : (
            <>
              <AssignmentRow label="Delivery Address" a={assignments.delivery || {}} />
              <AssignmentRow label="Order Feedback" a={assignments.feedback || {}} />
            </>
          )}
        </div>
      </div>

      <div className="card mt-4">
        <div className="ch justify-between">
          <h3>📚 Flow Library</h3>
          <div className="flex gap-[0.4rem] items-center">
            <button type="button" className="btn-g btn-sm" onClick={handleSyncFromMeta} disabled={syncing}>
              {syncing ? 'Syncing…' : '🔄 Sync from Meta'}
            </button>
            <button type="button" className="btn-p btn-sm" onClick={() => setEditing('new')}>+ New Flow</button>
          </div>
        </div>
        <div className="cb">
          {loading ? (
            <p className="text-dim">Loading from Meta…</p>
          ) : !flows.length ? (
            <p className="text-dim">No Flows found on this WABA.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[0.72rem] text-dim uppercase">
                    <th className="p-[0.45rem]">Name</th>
                    <th className="p-[0.45rem]">Flow ID</th>
                    <th className="p-[0.45rem]">Status</th>
                    <th className="p-[0.45rem]">Version</th>
                    <th className="p-[0.45rem]">Updated</th>
                    <th className="p-[0.45rem] text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {flows.map((f) => {
                    const color = STATUS_COLORS[f.status || ''] || 'var(--gb-neutral-500)';
                    const busy = rowBusy === f.id;
                    const pending = pendingAction && pendingAction.id === f.id ? pendingAction : null;
                    return (
                      <tr key={f.id} className="border-b border-rim">
                        <td className="p-[0.45rem] text-[0.84rem] font-medium">{f.name || '—'}</td>
                        <td className="p-[0.45rem] text-[0.72rem] text-dim font-mono">{f.id}</td>
                        <td className="p-[0.45rem]">
                          <span
                            // background, color and border tint computed at runtime from STATUS_COLORS by f.status
                            style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}
                            className="inline-block py-[0.15rem] px-[0.45rem] rounded-full text-[0.68rem] font-semibold"
                          >
                            {f.status}
                          </span>
                        </td>
                        <td className="p-[0.45rem] text-[0.76rem]">{f.json_version || '—'}</td>
                        <td className="p-[0.45rem] text-[0.76rem] text-dim">{formatUpdated(f.updated_at)}</td>
                        <td className="p-[0.45rem] text-right whitespace-nowrap">
                          {pending ? (
                            <InlineConfirm
                              pending={pending}
                              busy={busy}
                              onCancel={() => setPendingAction(null)}
                              onConfirm={() => {
                                if (pending.kind === 'publish') doPublish(f.id);
                                else if (pending.kind === 'deprecate') doDeprecate(f.id);
                                else if (pending.kind === 'delete') doDelete(f.id);
                                else if (pending.kind === 'assign' && pending.assignType) doAssign(pending.assignType, f.id, f.name || '');
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

      <div className="card mt-4">
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
                className="p-[0.45rem] border border-rim rounded-md w-full"
              >
                {['OTHER', 'SIGN_UP', 'SIGN_IN', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION', 'SHOPPING', 'SURVEY', 'CONTACT_US', 'CUSTOMER_SUPPORT'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="fg span2">
              <label>Starter Template</label>
              <select
                onChange={(e) => loadTemplate(e.target.value)}
                className="p-[0.45rem] border border-rim rounded-md w-full"
                defaultValue=""
              >
                <option value="">-- Blank --</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
              </select>
            </div>
            <div className="fg span2">
              <label>Flow JSON <small className="text-dim">(optional)</small></label>
              <textarea
                value={newJson}
                onChange={(e) => setNewJson(e.target.value)}
                rows={8}
                placeholder='{ "version": "6.2", "screens": [ ... ] }'
                className="w-full font-mono text-[0.78rem] p-2 border border-rim rounded-md"
              />
            </div>
          </div>

          <div className="flex gap-2 mt-[0.7rem]">
            <button type="button" className="btn-p" onClick={doCreate} disabled={creating}>
              {creating ? 'Creating…' : '+ Create Flow'}
            </button>
            <button type="button" className="btn-g" onClick={validateJson} disabled={!newJson.trim()}>
              Validate JSON
            </button>
          </div>

          {newResult && (
            <div
              // background and color depend on newResult.ok at runtime (success vs error tints)
              style={{
                background: newResult.ok ? '#f0fdf4' : '#fff1f2',
                color: newResult.ok ? 'var(--gb-wa-600)' : 'var(--gb-red-500)',
              }}
              className="mt-[0.6rem] py-2 px-[0.7rem] rounded-md text-[0.82rem]"
            >
              {newResult.msg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface AssignmentRowProps { label: string; a: AssignmentEntry }

function AssignmentRow({ label, a }: AssignmentRowProps): ReactNode {
  const colorMap: Record<string, string> = { PUBLISHED: '#22c55e', DRAFT: '#3b82f6' };
  const color = colorMap[a.flow_status || ''] || 'var(--gb-neutral-500)';
  return (
    <div className="flex justify-between items-center py-2 border-b border-rim">
      <span className="font-semibold min-w-[140px]">{label}</span>
      <span>
        {a.flow_id ? (
          <>
            <span className="font-mono text-[0.78rem]">{a.flow_id}</span>
            {a.flow_name && <span className="text-[0.78rem]"> ({a.flow_name})</span>}
            {a.flow_status && (
              <span
                // background and color tint computed at runtime from colorMap by flow_status
                style={{ background: `${color}15`, color }}
                className="text-[0.66rem] py-[0.1rem] px-[0.35rem] rounded-full ml-[0.4rem]"
              >
                {a.flow_status}
              </span>
            )}
          </>
        ) : (
          <span className="text-mute italic">Not assigned</span>
        )}
      </span>
    </div>
  );
}

interface RowActionsProps {
  flow: FlowRow;
  busy: boolean;
  onEdit: () => void;
  onAsk: (kind: PendingAction['kind'], extra?: Partial<PendingAction>) => void;
}

function RowActions({ flow, busy, onEdit, onAsk }: RowActionsProps): ReactNode {
  return (
    <>
      <button type="button" className="btn-g btn-sm" onClick={onEdit} disabled={busy}>Edit</button>
      {flow.status === 'DRAFT' && (
        <>
          <button type="button" className="btn-p btn-sm ml-1" onClick={() => onAsk('publish')} disabled={busy}>Publish</button>
          <button type="button" className="btn-del btn-sm ml-1" onClick={() => onAsk('delete')} disabled={busy}>Delete</button>
        </>
      )}
      {flow.status === 'PUBLISHED' && (
        <>
          <button type="button" className="btn-g btn-sm ml-1" onClick={() => onAsk('assign', { assignType: 'delivery' })} disabled={busy}>Assign Delivery</button>
          <button type="button" className="btn-g btn-sm ml-1" onClick={() => onAsk('assign', { assignType: 'feedback' })} disabled={busy}>Assign Feedback</button>
          <button type="button" className="btn-g btn-sm ml-1" onClick={() => onAsk('deprecate')} disabled={busy}>Deprecate</button>
        </>
      )}
      {flow.status === 'DEPRECATED' && (
        <button type="button" className="btn-del btn-sm ml-1" onClick={() => onAsk('delete')} disabled={busy}>Delete</button>
      )}
    </>
  );
}

interface InlineConfirmProps {
  pending: PendingAction;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function InlineConfirm({ pending, busy, onConfirm, onCancel }: InlineConfirmProps): ReactNode {
  let label: string = pending.kind;
  let bg = 'var(--gb-red-500)';
  if (pending.kind === 'publish') { label = 'Confirm publish?'; bg = 'var(--gb-wa-500)'; }
  else if (pending.kind === 'deprecate') { label = 'Confirm deprecate?'; bg = 'var(--gb-neutral-500)'; }
  else if (pending.kind === 'delete') { label = `Delete "${pending.name || pending.id}"?`; bg = 'var(--gb-red-500)'; }
  else if (pending.kind === 'assign') { label = `Assign as ${pending.assignType}?`; bg = 'var(--gb-indigo-600)'; }
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="text-[0.7rem] text-dim mr-[0.2rem]">{label}</span>
      <button
        type="button"
        className="btn-p btn-sm"
        // bg colour computed above at runtime from pending.kind
        style={{ background: bg }}
        onClick={onConfirm}
        disabled={busy}
      >
        {busy ? '…' : 'Confirm'}
      </button>
      <button type="button" className="btn-g btn-sm text-[0.7rem]" onClick={onCancel} disabled={busy}>Cancel</button>
    </span>
  );
}
