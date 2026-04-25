'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useToast } from '../Toast';
import { createTemplate, deleteTemplate, getTemplates, getTemplateGallery } from '../../api/admin';

const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
const LANGUAGES: ReadonlyArray<{ v: string; l: string }> = [
  { v: 'en', l: 'English' }, { v: 'hi', l: 'Hindi' }, { v: 'te', l: 'Telugu' },
  { v: 'ta', l: 'Tamil' }, { v: 'kn', l: 'Kannada' }, { v: 'ml', l: 'Malayalam' },
  { v: 'bn', l: 'Bengali' }, { v: 'mr', l: 'Marathi' }, { v: 'gu', l: 'Gujarati' },
  { v: 'pa', l: 'Punjabi' }, { v: 'ur', l: 'Urdu' },
];
const VARIABLE_SOURCES: ReadonlyArray<string> = [
  'customer.name', 'customer.wa_phone', 'order.order_number', 'order.total_rs',
  'order.items_summary', 'order.item_count', 'order.eta_text', 'order.status',
  'order.cancellation_reason', 'order.refund_amount_rs', 'order.tracking_url',
  'branch.name', 'restaurant.business_name', 'rider.name', 'rider.phone',
  'delivery_otp', 'item_count', 'cart_total',
];

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

const esc = (s: string | undefined | null): string => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtWa = (s: string | undefined | null): string => esc(s)
  .replace(/\*([^*]+)\*/g, '<b>$1</b>')
  .replace(/_([^_]+)_/g, '<i>$1</i>')
  .replace(/~([^~]+)~/g, '<s>$1</s>')
  .replace(/\n/g, '<br>');

interface HeaderField { type: string; text: string; url: string }
interface BodyField { text: string }
interface FooterField { text: string }
interface ButtonField { type: string; text: string; value: string }
interface VariableField { index: number; source: string; sample: string }

interface TemplateData {
  name: string;
  category: string;
  language: string;
  header: HeaderField;
  body: BodyField;
  footer: FooterField;
  buttons: ButtonField[];
  variables: VariableField[];
}

interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  example?: { header_handle?: string[]; body_text?: string[][] };
  buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
}

interface TemplateRecord {
  id?: string;
  meta_id?: string;
  name?: string;
  category?: string;
  language?: string;
  components?: TemplateComponent[];
  description?: string;
  status?: string;
}

interface TemplatesListEnvelope {
  templates?: TemplateRecord[];
  data?: TemplateRecord[];
}

function blankData(): TemplateData {
  return {
    name: '', category: 'MARKETING', language: 'en',
    header: { type: 'none', text: '', url: '' },
    body: { text: '' },
    footer: { text: '' },
    buttons: [], variables: [],
  };
}

function parseTemplate(tpl: TemplateRecord): TemplateData {
  const data = blankData();
  data.name = tpl.name || '';
  data.category = tpl.category || 'MARKETING';
  data.language = tpl.language || 'en';
  (tpl.components || []).forEach((c) => {
    if (c.type === 'HEADER') {
      data.header.type = c.format || 'TEXT';
      if (c.format === 'TEXT') data.header.text = c.text || '';
      else if (c.example?.header_handle) data.header.url = c.example.header_handle[0] || '';
    }
    if (c.type === 'BODY') {
      data.body.text = c.text || '';
      const sample = c.example?.body_text?.[0];
      if (sample) {
        sample.forEach((s, i) => {
          data.variables.push({ index: i + 1, source: '', sample: s });
        });
      }
    }
    if (c.type === 'FOOTER') data.footer.text = c.text || '';
    if (c.type === 'BUTTONS' && c.buttons) {
      data.buttons = c.buttons.map((b) => ({
        type: b.type || 'QUICK_REPLY',
        text: b.text || '',
        value: b.url || b.phone_number || '',
      }));
    }
  });
  const m = (data.body.text || '').match(/\{\{\d+\}\}/g);
  if (m && !data.variables.length) {
    m.forEach((_, i) => { data.variables.push({ index: i + 1, source: '', sample: '' }); });
  }
  return data;
}

interface BuiltComponent {
  type: string;
  format?: string;
  text?: string;
  example?: { header_handle?: string[]; body_text?: string[][] };
  buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
}

function buildComponents(d: TemplateData): BuiltComponent[] {
  const comps: BuiltComponent[] = [];
  if (d.header.type !== 'none') {
    if (d.header.type === 'TEXT') {
      comps.push({ type: 'HEADER', format: 'TEXT', text: d.header.text });
    } else {
      const hdr: BuiltComponent = { type: 'HEADER', format: d.header.type };
      if (d.header.url) hdr.example = { header_handle: [d.header.url] };
      comps.push(hdr);
    }
  }
  if (d.body.text) {
    const bc: BuiltComponent = { type: 'BODY', text: d.body.text };
    if (d.variables.length) {
      bc.example = { body_text: [d.variables.map((v) => v.sample || '')] };
    }
    comps.push(bc);
  }
  if (d.footer.text) comps.push({ type: 'FOOTER', text: d.footer.text });
  if (d.buttons.length) {
    const btns = d.buttons.map((b) => {
      const obj: { type: string; text: string; url?: string; phone_number?: string } = { type: b.type, text: b.text };
      if (b.type === 'URL') obj.url = b.value;
      if (b.type === 'PHONE_NUMBER') obj.phone_number = b.value;
      return obj;
    });
    comps.push({ type: 'BUTTONS', buttons: btns });
  }
  return comps;
}

interface TemplateEditorProps {
  metaId?: string | null;
  onClose?: () => void;
  onSaved?: () => void;
}

export default function TemplateEditor({ metaId, onClose, onSaved }: TemplateEditorProps) {
  const { showToast } = useToast();
  const [data, setData] = useState<TemplateData>(blankData());
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [galleryOpen, setGalleryOpen] = useState<boolean>(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!metaId) return;
    setLoading(true);
    (getTemplates() as Promise<TemplateRecord[] | TemplatesListEnvelope | null>)
      .then((list) => {
        const arr: TemplateRecord[] = Array.isArray(list)
          ? list
          : (list?.templates || list?.data || []);
        const tpl = arr.find?.((t) => t.id === metaId || t.meta_id === metaId);
        if (tpl) setData(parseTemplate(tpl));
        else showToast('Template not found', 'error');
      })
      .catch((err: unknown) => {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        showToast(e?.response?.data?.error || e?.message || 'Load failed', 'error');
      })
      .finally(() => setLoading(false));
  }, [metaId, showToast]);

  const set = (patch: Partial<TemplateData>) => setData((d) => ({ ...d, ...patch }));

  const setHeaderType = (type: string) => set({ header: { type, text: '', url: '' } });

  const addButton = () => {
    if (data.buttons.length >= 3) return;
    setData((d) => ({ ...d, buttons: [...d.buttons, { type: 'QUICK_REPLY', text: '', value: '' }] }));
  };

  const removeButton = (i: number) =>
    setData((d) => ({ ...d, buttons: d.buttons.filter((_, idx) => idx !== i) }));

  const updateButton = (i: number, prop: keyof ButtonField, val: string) =>
    setData((d) => ({ ...d, buttons: d.buttons.map((b, idx) => idx === i ? { ...b, [prop]: val } : b) }));

  const updateVariable = (i: number, prop: keyof VariableField, val: string) =>
    setData((d) => ({ ...d, variables: d.variables.map((v, idx) => idx === i ? { ...v, [prop]: val } : v) }));

  const insertVariable = () => {
    const ta = bodyRef.current;
    const nextIdx = data.variables.length + 1;
    const tag = `{{${nextIdx}}}`;
    let newBody: string;
    let caret: number;
    if (ta) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      newBody = data.body.text.substring(0, start) + tag + data.body.text.substring(end);
      caret = start + tag.length;
    } else {
      newBody = data.body.text + tag;
      caret = newBody.length;
    }
    setData((d) => ({
      ...d,
      body: { text: newBody },
      variables: [...d.variables, { index: nextIdx, source: '', sample: '' }],
    }));
    setTimeout(() => {
      if (bodyRef.current) {
        bodyRef.current.focus();
        bodyRef.current.setSelectionRange(caret, caret);
      }
    }, 0);
  };

  const loadFromGallery = async (templateId: string) => {
    try {
      const list = (await getTemplateGallery()) as TemplateRecord[] | TemplatesListEnvelope | null;
      const arr: TemplateRecord[] = Array.isArray(list)
        ? list
        : (list?.templates || list?.data || []);
      const tpl = arr.find?.((t) => t.id === templateId);
      if (!tpl) { showToast('Gallery template not found', 'error'); return; }
      setData(parseTemplate(tpl));
      setGalleryOpen(false);
      showToast('Template loaded from gallery', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Gallery load failed', 'error');
    }
  };

  const doSave = async () => {
    if (!data.name) { showToast('Template name is required', 'error'); return; }
    if (!data.body.text) { showToast('Body text is required', 'error'); return; }
    const payload: Record<string, unknown> = {
      name: data.name,
      category: data.category,
      language: data.language,
      components: buildComponents(data),
    };
    setSaving(true);
    try {
      await createTemplate(payload);
      showToast('Template saved', 'success');
      if (onSaved) onSaved();
      if (onClose) onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await deleteTemplate({ name: data.name });
      showToast('Template deleted', 'success');
      if (onSaved) onSaved();
      if (onClose) onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const previewBody = useMemo(() => {
    let b = data.body.text;
    data.variables.forEach((v) => {
      const display = v.sample || (v.source ? `[${v.source}]` : `{{${v.index}}}`);
      b = b.split(`{{${v.index}}}`).join(display);
    });
    return b;
  }, [data.body.text, data.variables]);

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>Loading template…</div>;
  }

  return (
    <div id="template-editor-container" style={{ border: '1px solid var(--rim)', borderRadius: 8, background: 'var(--surface,#fff)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.7rem .9rem', borderBottom: '1px solid var(--rim)' }}>
        <h3 style={{ margin: 0 }}>{metaId ? 'Edit Template' : 'New Template'}</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem' }}>
          <button type="button" className="btn-sm" onClick={() => setGalleryOpen((v) => !v)}>
            {galleryOpen ? 'Close Gallery' : 'Load from Gallery'}
          </button>
          {onClose && <button type="button" className="btn-g btn-sm" onClick={onClose}>Close</button>}
        </div>
      </div>

      {galleryOpen && <GalleryPicker onPick={loadFromGallery} />}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', minHeight: 480 }}>
        <div id="te-builder" style={{ padding: '.9rem', borderRight: '1px solid var(--rim)', overflowY: 'auto' }}>
          <Field label="Template Name">
            <input
              className="te-input"
              value={data.name}
              placeholder="e.g. order_confirmation"
              onChange={(e) => set({ name: slugify(e.target.value) })}
              style={inp}
            />
          </Field>

          <Field label="Category">
            <select value={data.category} onChange={(e) => set({ category: e.target.value })} style={inp}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>

          <Field label="Language">
            <select value={data.language} onChange={(e) => set({ language: e.target.value })} style={inp}>
              {LANGUAGES.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}
            </select>
          </Field>

          <Section title="HEADER">
            <select value={data.header.type} onChange={(e) => setHeaderType(e.target.value)} style={{ ...inp, width: 150 }}>
              {['none', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].map((t) => (
                <option key={t} value={t}>{t === 'none' ? 'None' : t}</option>
              ))}
            </select>
            {data.header.type === 'TEXT' && (
              <input
                value={data.header.text}
                placeholder="Header text"
                onChange={(e) => set({ header: { ...data.header, text: e.target.value } })}
                style={{ ...inp, marginTop: '.35rem' }}
              />
            )}
            {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(data.header.type) && (
              <input
                value={data.header.url}
                placeholder="Media URL"
                onChange={(e) => set({ header: { ...data.header, url: e.target.value } })}
                style={{ ...inp, marginTop: '.35rem' }}
              />
            )}
          </Section>

          <Section title="BODY" extra={
            <>
              <span style={{ fontSize: '.72rem', color: 'var(--dim)', marginRight: '.5rem' }}>
                {(data.body.text || '').length}/1024
              </span>
              <button type="button" className="btn-sm" style={{ fontSize: '.7rem' }} onClick={insertVariable}>
                + Variable
              </button>
            </>
          }>
            <textarea
              ref={bodyRef}
              value={data.body.text}
              maxLength={1024}
              rows={5}
              onChange={(e) => set({ body: { text: e.target.value } })}
              style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Section>

          <Section title="FOOTER" extra={
            <label style={{ fontSize: '.76rem', display: 'inline-flex', alignItems: 'center', gap: '.3rem' }}>
              <input
                type="checkbox"
                checked={!!data.footer.text || data.footer.text === ''}
                onChange={(e) => set({ footer: { text: e.target.checked ? (data.footer.text || '') : '' } })}
              />
              Enable
            </label>
          }>
            <input
              value={data.footer.text}
              maxLength={60}
              placeholder="Footer text (60 chars)"
              onChange={(e) => set({ footer: { text: e.target.value } })}
              style={inp}
            />
            <span style={{ fontSize: '.7rem', color: 'var(--dim)' }}>{(data.footer.text || '').length}/60</span>
          </Section>

          <Section title="BUTTONS" extra={
            <button type="button" className="btn-sm" style={{ fontSize: '.7rem' }} onClick={addButton} disabled={data.buttons.length >= 3}>
              + Button
            </button>
          }>
            {data.buttons.map((b, i) => (
              <div key={i} style={{ display: 'flex', gap: '.3rem', alignItems: 'center', marginBottom: '.35rem' }}>
                <select value={b.type} onChange={(e) => updateButton(i, 'type', e.target.value)} style={{ ...inp, width: 130 }}>
                  {['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].map((t) => (
                    <option key={t} value={t}>{t.replace('_', ' ')}</option>
                  ))}
                </select>
                <input value={b.text} placeholder="Label" onChange={(e) => updateButton(i, 'text', e.target.value)} style={{ ...inp, flex: 1 }} />
                {b.type !== 'QUICK_REPLY' && (
                  <input
                    value={b.value}
                    placeholder={b.type === 'URL' ? 'https://...' : 'Phone'}
                    onChange={(e) => updateButton(i, 'value', e.target.value)}
                    style={{ ...inp, flex: 1 }}
                  />
                )}
                <button type="button" className="btn-sm" style={{ color: 'var(--red,#dc2626)', fontSize: '.75rem' }} onClick={() => removeButton(i)}>✕</button>
              </div>
            ))}
          </Section>

          {data.variables.length > 0 && (
            <Section title="VARIABLES">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.76rem' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--dim)' }}>
                    <th style={{ padding: '.25rem', width: 60 }}>Var</th>
                    <th style={{ padding: '.25rem' }}>Source</th>
                    <th style={{ padding: '.25rem' }}>Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {data.variables.map((v, i) => (
                    <tr key={i}>
                      <td style={{ padding: '.2rem', fontFamily: 'monospace' }}>{`{{${v.index}}}`}</td>
                      <td style={{ padding: '.2rem' }}>
                        <select value={v.source} onChange={(e) => updateVariable(i, 'source', e.target.value)} style={{ ...inp, fontSize: '.72rem', padding: '.2rem .3rem' }}>
                          <option value="">-- select --</option>
                          {VARIABLE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '.2rem' }}>
                        <input value={v.sample} placeholder="Sample" onChange={(e) => updateVariable(i, 'sample', e.target.value)} style={{ ...inp, fontSize: '.72rem', padding: '.2rem .3rem' }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          <div style={{ display: 'flex', gap: '.5rem', marginTop: '1rem' }}>
            <button type="button" className="btn-p" onClick={doSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Template'}
            </button>
            {metaId && (
              confirmDelete ? (
                <>
                  <button type="button" className="btn-sm" style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)', border: 'none', borderRadius: 6, padding: '.4rem .8rem' }} onClick={doDelete} disabled={deleting}>
                    {deleting ? '…' : `Confirm delete "${data.name}"`}
                  </button>
                  <button type="button" className="btn-g" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
                </>
              ) : (
                <button type="button" className="btn-g" style={{ color: 'var(--red,#dc2626)' }} onClick={doDelete}>
                  Delete
                </button>
              )
            )}
            {onClose && <button type="button" className="btn-g" onClick={onClose}>Cancel</button>}
          </div>
        </div>

        <div id="te-preview" style={{ padding: '1rem', background: '#e5ddd5', minHeight: 480 }}>
          <div className="te-wa-bubble" style={bubble}>
            {data.header.type === 'TEXT' && data.header.text && (
              <div className="te-wa-header" style={{ fontWeight: 700, marginBottom: '.35rem' }} dangerouslySetInnerHTML={{ __html: fmtWa(data.header.text) }} />
            )}
            {data.header.type === 'IMAGE' && (
              <div className="te-wa-img" style={imgBox}>
                {data.header.url ? <img src={data.header.url} alt="header" style={{ width: '100%', borderRadius: 6 }} /> : <div style={placeholderPh}>IMAGE</div>}
              </div>
            )}
            {data.header.type === 'VIDEO' && (
              <div className="te-wa-img" style={imgBox}><div style={placeholderPh}>VIDEO</div></div>
            )}
            {data.header.type === 'DOCUMENT' && (
              <div className="te-wa-img" style={imgBox}><div style={placeholderPh}>DOCUMENT</div></div>
            )}
            {previewBody && (
              <div className="te-wa-body" style={{ fontSize: '.85rem', color: '#111', whiteSpace: 'pre-wrap' }} dangerouslySetInnerHTML={{ __html: fmtWa(previewBody) }} />
            )}
            {data.footer.text && (
              <div className="te-wa-footer" style={{ fontSize: '.72rem', color: '#667781', marginTop: '.35rem' }}>{data.footer.text}</div>
            )}
            <div className="te-wa-time" style={{ fontSize: '.68rem', color: '#667781', textAlign: 'right', marginTop: '.35rem' }}>
              12:30 <span className="te-wa-checks">✓✓</span>
            </div>
          </div>
          {data.buttons.map((b, i) => (
            <div
              key={i}
              className="te-wa-btn"
              style={{
                background: 'var(--gb-neutral-0)', borderRadius: 8, padding: '.5rem .6rem',
                marginTop: '.35rem', textAlign: 'center', color: '#1f7ee3',
                fontWeight: 600, fontSize: '.82rem', boxShadow: '0 1px 2px rgba(0,0,0,.08)',
              }}
            >
              {b.text || 'Button'}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface FieldProps { label: string; children: ReactNode }

function Field({ label, children }: FieldProps): ReactNode {
  return (
    <div style={{ marginBottom: '.6rem' }}>
      <label style={{ display: 'block', fontSize: '.74rem', color: 'var(--dim)', fontWeight: 600, marginBottom: '.2rem' }}>{label}</label>
      {children}
    </div>
  );
}

interface SectionProps { title: string; extra?: ReactNode; children: ReactNode }

function Section({ title, extra, children }: SectionProps): ReactNode {
  return (
    <div style={{ marginTop: '.9rem', padding: '.6rem', background: 'var(--ink4,#f4f4f5)', border: '1px solid var(--rim)', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', marginBottom: '.45rem' }}>
        <b style={{ fontSize: '.76rem' }}>{title}</b>
        <div style={{ marginLeft: 'auto' }}>{extra}</div>
      </div>
      {children}
    </div>
  );
}

interface GalleryItem { id: string; name?: string; description?: string }

interface GalleryPickerProps { onPick: (id: string) => void }

function GalleryPicker({ onPick }: GalleryPickerProps): ReactNode {
  const { showToast } = useToast();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    (getTemplateGallery() as Promise<GalleryItem[] | { templates?: GalleryItem[]; data?: GalleryItem[] } | null>)
      .then((list) => {
        const arr: GalleryItem[] = Array.isArray(list)
          ? list
          : (list?.templates || list?.data || []);
        setItems(arr);
      })
      .catch((err: unknown) => {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        showToast(e?.response?.data?.error || e?.message || 'Gallery failed', 'error');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: '.7rem .9rem', borderBottom: '1px solid var(--rim)', background: 'var(--ink4,#f4f4f5)' }}>
      {loading ? (
        <span style={{ color: 'var(--dim)', fontSize: '.82rem' }}>Loading gallery…</span>
      ) : !items.length ? (
        <span style={{ color: 'var(--dim)', fontSize: '.82rem' }}>No gallery templates available.</span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem' }}>
          {items.map((t) => (
            <button
              key={t.id}
              type="button"
              className="btn-sm"
              style={{ fontSize: '.72rem' }}
              onClick={() => onPick(t.id)}
              title={t.description || t.name}
            >
              {t.name || t.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const inp: React.CSSProperties = {
  width: '100%', padding: '.4rem .55rem', border: '1px solid var(--rim)',
  borderRadius: 6, fontSize: '.82rem', background: 'var(--gb-neutral-0)',
};

const bubble: React.CSSProperties = {
  background: '#d9fdd3', borderRadius: 8, padding: '.6rem .7rem',
  maxWidth: 300, boxShadow: '0 1px 2px rgba(0,0,0,.08)',
};

const imgBox: React.CSSProperties = { marginBottom: '.35rem' };
const placeholderPh: React.CSSProperties = {
  background: '#c7e8c1', color: '#3d5f3a', padding: '1rem', borderRadius: 6,
  textAlign: 'center', fontSize: '.76rem', fontWeight: 600,
};
