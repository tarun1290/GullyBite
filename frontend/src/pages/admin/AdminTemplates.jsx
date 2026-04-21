import { useEffect, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import TemplateEditor from '../../components/admin/TemplateEditor.jsx';
import {
  getTemplates,
  getTemplateMappings,
  getTemplateNotifications,
  syncTemplates,
  seedTemplates,
  deleteTemplate,
} from '../../api/admin.js';

// Mirrors the "Templates" section in admin.html (3330-3460ish):
//   WABA-id input + Sync + Seed Defaults + Create
//   Template list (name / category / lang / status / components / actions)
//   Event-to-template mapping list
//   Recent notifications log
// Edit opens the in-page TemplateEditor; legacy confirm()s become inline.

const STATUS_COLORS = {
  APPROVED: 'var(--gb-wa-500)',
  PENDING: 'var(--gb-amber-500)',
  REJECTED: 'var(--gb-red-500)',
  DELETED: 'var(--gb-slate-400)',
};

const QUALITY_COLORS = { HIGH: 'var(--gb-wa-500)', MEDIUM: 'var(--gb-amber-500)', LOW: 'var(--gb-red-500)' };

export default function AdminTemplates() {
  const { showToast } = useToast();
  const [wabaId, setWabaId] = useState('');
  const [templates, setTemplates] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [editing, setEditing] = useState(null); // { metaId } | 'new' | null
  const [pendingDelete, setPendingDelete] = useState(null); // template name
  const [rowBusy, setRowBusy] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = wabaId ? { waba_id: wabaId } : undefined;
      const [tpls, maps, notifs] = await Promise.all([
        getTemplates(params).catch(() => []),
        getTemplateMappings().catch(() => []),
        getTemplateNotifications(30).catch(() => []),
      ]);
      setTemplates(Array.isArray(tpls) ? tpls : (tpls?.templates || tpls?.data || []));
      setMappings(Array.isArray(maps) ? maps : []);
      setNotifications(Array.isArray(notifs) ? notifs : []);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Load failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const doSync = async () => {
    if (!wabaId.trim()) return showToast('Enter a WABA ID first', 'error');
    setSyncing(true);
    try {
      const r = await syncTemplates(wabaId.trim());
      showToast(`Synced ${r?.total ?? 0} templates`, 'success');
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Sync failed', 'error');
    } finally { setSyncing(false); }
  };

  const doSeed = async () => {
    setSeeding(true);
    try {
      await seedTemplates();
      showToast('Default mappings seeded', 'success');
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Seed failed', 'error');
    } finally { setSeeding(false); }
  };

  const doDelete = async (name) => {
    setRowBusy(name);
    try {
      const body = { name };
      if (wabaId.trim()) body.waba_id = wabaId.trim();
      await deleteTemplate(body);
      showToast('Template deleted', 'success');
      setPendingDelete(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Delete failed', 'error');
    } finally { setRowBusy(null); }
  };

  if (editing) {
    return (
      <TemplateEditor
        metaId={editing === 'new' ? null : editing.metaId}
        wabaId={wabaId.trim() || undefined}
        onClose={() => setEditing(null)}
        onSaved={load}
      />
    );
  }

  return (
    <div>
      {/* Header / WABA-id control bar */}
      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.4rem' }}>
          <h3>📄 WhatsApp Templates</h3>
          <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value)}
              placeholder="WABA ID (optional)"
              style={{ padding: '.3rem .55rem', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.8rem', width: 200 }}
            />
            <button type="button" className="btn-sm" onClick={doSync} disabled={syncing}>
              {syncing ? 'Syncing…' : '🔄 Sync from Meta'}
            </button>
            <button type="button" className="btn-sm" onClick={doSeed} disabled={seeding}>
              {seeding ? 'Seeding…' : '🌱 Seed Defaults'}
            </button>
            <button type="button" className="btn-p btn-sm" onClick={() => setEditing('new')}>
              + New Template
            </button>
          </div>
        </div>
      </div>

      {/* Templates list */}
      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch"><h3>Templates <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>({templates.length})</span></h3></div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading…</p>
          ) : !templates.length ? (
            <p style={{ color: 'var(--dim)' }}>No templates synced. Enter a WABA ID and click "Sync from Meta".</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase' }}>
                    <th style={{ padding: '.45rem' }}>Name</th>
                    <th style={{ padding: '.45rem' }}>Category</th>
                    <th style={{ padding: '.45rem' }}>Lang</th>
                    <th style={{ padding: '.45rem' }}>Status</th>
                    <th style={{ padding: '.45rem' }}>Components</th>
                    <th style={{ padding: '.45rem', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => {
                    const clr = STATUS_COLORS[t.status] || 'var(--gb-neutral-500)';
                    const qclr = QUALITY_COLORS[t.quality_score];
                    const pending = pendingDelete === t.name;
                    const busy = rowBusy === t.name;
                    return (
                      <tr key={t.id || t.meta_id || t.name} style={{ borderBottom: '1px solid var(--rim)' }}>
                        <td style={{ padding: '.45rem', fontSize: '.84rem', fontWeight: 500 }}>
                          {t.name}
                          {t.status === 'REJECTED' && t.rejected_reason && (
                            <div style={{ fontSize: '.7rem', color: 'var(--gb-red-500)', marginTop: '.2rem' }}>
                              {t.rejected_reason}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '.45rem', fontSize: '.78rem' }}>{t.category}</td>
                        <td style={{ padding: '.45rem', fontSize: '.78rem' }}>{t.language}</td>
                        <td style={{ padding: '.45rem', fontSize: '.78rem' }}>
                          <span style={{ color: clr, fontWeight: 600 }}>{t.status}</span>
                          {qclr && <span style={{ color: qclr, marginLeft: '.35rem', fontSize: '.7rem' }}>{t.quality_score}</span>}
                        </td>
                        <td style={{ padding: '.45rem', fontSize: '.72rem', color: 'var(--dim)' }}>
                          {(t.components || []).map((c) => c.type).join(', ')}
                        </td>
                        <td style={{ padding: '.45rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {pending ? (
                            <span style={{ display: 'inline-flex', gap: '.25rem', alignItems: 'center' }}>
                              <span style={{ fontSize: '.72rem', color: 'var(--dim)', marginRight: '.2rem' }}>Delete "{t.name}"?</span>
                              <button type="button" style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)', border: 'none', borderRadius: 4, padding: '.15rem .5rem', fontSize: '.72rem' }} onClick={() => doDelete(t.name)} disabled={busy}>
                                {busy ? '…' : 'Confirm'}
                              </button>
                              <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem' }} onClick={() => setPendingDelete(null)} disabled={busy}>Cancel</button>
                            </span>
                          ) : (
                            <>
                              <button type="button" className="btn-sm" style={{ fontSize: '.72rem' }} onClick={() => setEditing({ metaId: t.meta_id || t.id })}>
                                Edit
                              </button>
                              <button type="button" className="btn-sm" style={{ fontSize: '.72rem', marginLeft: '.25rem', color: 'var(--red,#dc2626)' }} onClick={() => setPendingDelete(t.name)}>
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

      {/* Mappings */}
      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch"><h3>📌 Event → Template Mappings</h3></div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading…</p>
          ) : !mappings.length ? (
            <p style={{ color: 'var(--dim)' }}>No mappings yet. Click "Seed Defaults" to create.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase' }}>
                    <th style={{ padding: '.45rem' }}>Event</th>
                    <th style={{ padding: '.45rem' }}>Template</th>
                    <th style={{ padding: '.45rem' }}>Description</th>
                    <th style={{ padding: '.45rem' }}>Variables</th>
                    <th style={{ padding: '.45rem' }}>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m) => (
                    <tr key={m.event} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={{ padding: '.45rem', fontWeight: 600, fontSize: '.82rem' }}>{m.event}</td>
                      <td style={{ padding: '.45rem' }}>
                        <code style={{ fontSize: '.78rem', background: 'var(--ink4,#f4f4f5)', padding: '.1rem .4rem', borderRadius: 4 }}>
                          {m.template_name}
                        </code>
                      </td>
                      <td style={{ padding: '.45rem', color: 'var(--dim)', fontSize: '.78rem' }}>{m.description || '—'}</td>
                      <td style={{ padding: '.45rem', fontSize: '.72rem' }}>
                        {(m.variables || []).map((v, i) => (
                          <span key={i} style={{ background: 'var(--ink4,#f4f4f5)', padding: '.1rem .3rem', borderRadius: 3, marginRight: '.2rem' }}>
                            {`{{${v.position}}}`} → {v.source}
                          </span>
                        ))}
                      </td>
                      <td style={{ padding: '.45rem', fontSize: '.78rem' }}>
                        {m.is_active
                          ? <span style={{ color: 'var(--gb-wa-500)' }}>Active</span>
                          : <span style={{ color: 'var(--dim)' }}>Off</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Notifications / send log */}
      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch"><h3>🔔 Recent Template Sends</h3></div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading…</p>
          ) : !notifications.length ? (
            <p style={{ color: 'var(--dim)' }}>No template sends yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase' }}>
                    <th style={{ padding: '.45rem' }}>Order</th>
                    <th style={{ padding: '.45rem' }}>Event</th>
                    <th style={{ padding: '.45rem' }}>Template</th>
                    <th style={{ padding: '.45rem' }}>Status</th>
                    <th style={{ padding: '.45rem' }}>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {notifications.map((l, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={{ padding: '.45rem', fontFamily: 'monospace', fontSize: '.76rem' }}>
                        {String(l.order_id || '').slice(-8) || '—'}
                      </td>
                      <td style={{ padding: '.45rem', fontSize: '.78rem' }}>{l.event}</td>
                      <td style={{ padding: '.45rem', fontSize: '.76rem' }}><code>{l.template_name}</code></td>
                      <td style={{ padding: '.45rem', fontSize: '.78rem', color: l.status === 'sent' ? 'var(--gb-wa-500)' : 'var(--gb-red-500)' }}>
                        {l.status}
                      </td>
                      <td style={{ padding: '.45rem', fontSize: '.78rem', color: 'var(--dim)' }}>
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
