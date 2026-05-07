'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import TemplateEditor from '../../../components/admin/TemplateEditor';
import {
  getTemplates,
  getTemplateMappings,
  getTemplateNotifications,
  syncTemplates,
  seedTemplates,
  deleteTemplate,
} from '../../../api/admin';

const STATUS_COLORS: Record<string, string> = {
  APPROVED: 'var(--gb-wa-500)',
  PENDING: 'var(--gb-amber-500)',
  REJECTED: 'var(--gb-red-500)',
  DELETED: 'var(--gb-slate-400)',
};

const QUALITY_COLORS: Record<string, string> = { HIGH: 'var(--gb-wa-500)', MEDIUM: 'var(--gb-amber-500)', LOW: 'var(--gb-red-500)' };

interface TemplateComponentLite { type: string }

interface TemplateRow {
  id?: string;
  meta_id?: string;
  name: string;
  category?: string;
  language?: string;
  status?: string;
  quality_score?: string;
  rejected_reason?: string;
  components?: TemplateComponentLite[];
}

interface TemplatesEnvelope { templates?: TemplateRow[]; data?: TemplateRow[] }

interface MappingVariable { position?: number; source?: string }

interface MappingRow {
  event: string;
  template_name: string;
  description?: string;
  variables?: MappingVariable[];
  is_active?: boolean;
}

interface NotificationRow {
  order_id?: string;
  event?: string;
  template_name?: string;
  status?: string;
  sent_at?: string;
}

interface SyncResult { total?: number }

type EditingState = 'new' | { metaId: string } | null;

export default function AdminTemplatesPage() {
  const { showToast } = useToast();
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [seeding, setSeeding] = useState<boolean>(false);
  const [editing, setEditing] = useState<EditingState>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [tpls, maps, notifs] = await Promise.all([
        (getTemplates() as Promise<TemplateRow[] | TemplatesEnvelope | null>).catch(() => null),
        (getTemplateMappings() as Promise<MappingRow[] | null>).catch(() => null),
        (getTemplateNotifications(30) as Promise<NotificationRow[] | null>).catch(() => null),
      ]);
      const tplsList: TemplateRow[] = Array.isArray(tpls)
        ? tpls
        : (tpls?.templates || tpls?.data || []);
      setTemplates(tplsList);
      setMappings(Array.isArray(maps) ? maps : []);
      setNotifications(Array.isArray(notifs) ? notifs : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Load failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const doSync = async () => {
    setSyncing(true);
    try {
      const r = (await syncTemplates()) as SyncResult | null;
      showToast(`Synced ${r?.total ?? 0} templates`, 'success');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'error');
    } finally { setSyncing(false); }
  };

  const doSeed = async () => {
    setSeeding(true);
    try {
      const r = (await seedTemplates()) as { templates?: { created?: { name: string }[]; skipped?: { name: string }[] } } | null;
      const created = r?.templates?.created?.length ?? 0;
      const skipped = r?.templates?.skipped?.length ?? 0;
      const tail = created
        ? ` + ${created} template(s) submitted to Meta${skipped ? ` (${skipped} skipped)` : ''}`
        : skipped ? ` (${skipped} template(s) already exist)` : '';
      showToast(`Default mappings seeded${tail}`, 'success');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Seed failed', 'error');
    } finally { setSeeding(false); }
  };

  const doDelete = async (name: string) => {
    setRowBusy(name);
    try {
      await deleteTemplate({ name });
      showToast('Template deleted', 'success');
      setPendingDelete(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    } finally { setRowBusy(null); }
  };

  if (editing) {
    return (
      <TemplateEditor
        metaId={editing === 'new' ? null : editing.metaId}
        onClose={() => setEditing(null)}
        onSaved={load}
      />
    );
  }

  return (
    <div>
      <div className="card">
        <div className="ch justify-between flex-wrap gap-[0.4rem]">
          <h3>📄 WhatsApp Templates</h3>
          <div className="flex gap-[0.4rem] items-center flex-wrap">
            <button type="button" className="btn-g btn-sm" onClick={doSync} disabled={syncing}>
              {syncing ? 'Syncing…' : '🔄 Sync from Meta'}
            </button>
            <button type="button" className="btn-g btn-sm" onClick={doSeed} disabled={seeding}>
              {seeding ? 'Seeding…' : '🌱 Seed Defaults'}
            </button>
            <button type="button" className="btn-p btn-sm" onClick={() => setEditing('new')}>
              + New Template
            </button>
          </div>
        </div>
      </div>

      <div className="card mt-4">
        <div className="ch"><h3>Templates <span className="text-[0.72rem] text-dim">({templates.length})</span></h3></div>
        <div className="cb">
          {loading ? (
            <p className="text-dim">Loading…</p>
          ) : !templates.length ? (
            <p className="text-dim">No templates synced. Enter a WABA ID and click &quot;Sync from Meta&quot;.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[0.72rem] text-dim uppercase">
                    <th className="p-[0.45rem]">Name</th>
                    <th className="p-[0.45rem]">Category</th>
                    <th className="p-[0.45rem]">Lang</th>
                    <th className="p-[0.45rem]">Status</th>
                    <th className="p-[0.45rem]">Components</th>
                    <th className="p-[0.45rem] text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => {
                    const clr = STATUS_COLORS[t.status || ''] || 'var(--gb-neutral-500)';
                    const qclr = QUALITY_COLORS[t.quality_score || ''];
                    const pending = pendingDelete === t.name;
                    const busy = rowBusy === t.name;
                    return (
                      <tr key={t.id || t.meta_id || t.name} className="border-b border-rim">
                        <td className="p-[0.45rem] text-[0.84rem] font-medium">
                          {t.name}
                          {t.status === 'REJECTED' && t.rejected_reason && (
                            <div className="text-[0.7rem] text-red-500 mt-[0.2rem]">
                              {t.rejected_reason}
                            </div>
                          )}
                        </td>
                        <td className="p-[0.45rem] text-[0.78rem]">{t.category}</td>
                        <td className="p-[0.45rem] text-[0.78rem]">{t.language}</td>
                        <td className="p-[0.45rem] text-[0.78rem]">
                          {/* dynamic color: STATUS_COLORS palette keyed by t.status at runtime */}
                          <span style={{ color: clr }} className="font-semibold">{t.status}</span>
                          {/* dynamic color: QUALITY_COLORS palette keyed by t.quality_score at runtime */}
                          {qclr && <span style={{ color: qclr }} className="ml-[0.35rem] text-[0.7rem]">{t.quality_score}</span>}
                        </td>
                        <td className="p-[0.45rem] text-[0.72rem] text-dim">
                          {(t.components || []).map((c) => c.type).join(', ')}
                        </td>
                        <td className="p-[0.45rem] text-right whitespace-nowrap">
                          {pending ? (
                            <span className="inline-flex gap-1 items-center">
                              <span className="text-[0.72rem] text-dim mr-[0.2rem]">Delete &quot;{t.name}&quot;?</span>
                              <button type="button" className="bg-red-500 text-neutral-0 border-0 rounded-sm py-[0.15rem] px-2 text-[0.72rem]" onClick={() => doDelete(t.name)} disabled={busy}>
                                {busy ? '…' : 'Confirm'}
                              </button>
                              <button type="button" className="btn-g btn-sm text-[0.72rem]" onClick={() => setPendingDelete(null)} disabled={busy}>Cancel</button>
                            </span>
                          ) : (
                            <>
                              <button type="button" className="btn-g btn-sm" onClick={() => setEditing({ metaId: (t.meta_id || t.id) || '' })}>
                                Edit
                              </button>
                              <button type="button" className="btn-del btn-sm ml-1" onClick={() => setPendingDelete(t.name)}>
                                Delete
                              </button>
                            </>
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
        <div className="ch"><h3>📌 Event → Template Mappings</h3></div>
        <div className="cb">
          {loading ? (
            <p className="text-dim">Loading…</p>
          ) : !mappings.length ? (
            <p className="text-dim">No mappings yet. Click &quot;Seed Defaults&quot; to create.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[0.72rem] text-dim uppercase">
                    <th className="p-[0.45rem]">Event</th>
                    <th className="p-[0.45rem]">Template</th>
                    <th className="p-[0.45rem]">Description</th>
                    <th className="p-[0.45rem]">Variables</th>
                    <th className="p-[0.45rem]">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m) => (
                    <tr key={m.event} className="border-b border-rim">
                      <td className="p-[0.45rem] font-semibold text-[0.82rem]">{m.event}</td>
                      <td className="p-[0.45rem]">
                        <code className="text-[0.78rem] bg-ink4 py-[0.1rem] px-[0.4rem] rounded-sm">
                          {m.template_name}
                        </code>
                      </td>
                      <td className="p-[0.45rem] text-dim text-[0.78rem]">{m.description || '—'}</td>
                      <td className="p-[0.45rem] text-[0.72rem]">
                        {(m.variables || []).map((v, i) => (
                          <span key={i} className="bg-ink4 py-[0.1rem] px-[0.3rem] rounded-[3px] mr-[0.2rem]">
                            {`{{${v.position}}}`} → {v.source}
                          </span>
                        ))}
                      </td>
                      <td className="p-[0.45rem] text-[0.78rem]">
                        {m.is_active
                          ? <span className="text-wa-500">Active</span>
                          : <span className="text-dim">Off</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card mt-4">
        <div className="ch"><h3>🔔 Recent Template Sends</h3></div>
        <div className="cb">
          {loading ? (
            <p className="text-dim">Loading…</p>
          ) : !notifications.length ? (
            <p className="text-dim">No template sends yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[0.72rem] text-dim uppercase">
                    <th className="p-[0.45rem]">Order</th>
                    <th className="p-[0.45rem]">Event</th>
                    <th className="p-[0.45rem]">Template</th>
                    <th className="p-[0.45rem]">Status</th>
                    <th className="p-[0.45rem]">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {notifications.map((l, i) => (
                    <tr key={i} className="border-b border-rim">
                      <td className="p-[0.45rem] font-mono text-[0.76rem]">
                        {String(l.order_id || '').slice(-8) || '—'}
                      </td>
                      <td className="p-[0.45rem] text-[0.78rem]">{l.event}</td>
                      <td className="p-[0.45rem] text-[0.76rem]"><code>{l.template_name}</code></td>
                      <td className={`p-[0.45rem] text-[0.78rem] ${l.status === 'sent' ? 'text-wa-500' : 'text-red-500'}`}>
                        {l.status}
                      </td>
                      <td className="p-[0.45rem] text-[0.78rem] text-dim">
                        {l.sent_at ? new Date(l.sent_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
