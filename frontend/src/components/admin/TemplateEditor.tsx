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
  'customer.name', 'customer.wa_phone', 'order.order_number', 'order.display_order_id', 'order.total_rs',
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
    return <div className="p-8 text-center text-dim">Loading template…</div>;
  }

  return (
    <div id="template-editor-container" className="border border-rim rounded-lg bg-surface">
      <div className="flex items-center gap-[0.6rem] py-[0.7rem] px-[0.9rem] border-b border-rim">
        <h3 className="m-0">{metaId ? 'Edit Template' : 'New Template'}</h3>
        <div className="ml-auto flex gap-[0.4rem]">
          <button type="button" className="btn-sm" onClick={() => setGalleryOpen((v) => !v)}>
            {galleryOpen ? 'Close Gallery' : 'Load from Gallery'}
          </button>
          {onClose && <button type="button" className="btn-g btn-sm" onClick={onClose}>Close</button>}
        </div>
      </div>

      {galleryOpen && <GalleryPicker onPick={loadFromGallery} />}

      <div className="grid grid-cols-[1fr_340px] min-h-[480px]">
        <div id="te-builder" className="p-[0.9rem] border-r border-rim overflow-y-auto">
          <Field label="Template Name">
            <input
              className={`te-input ${INP_CLS} w-full`}
              value={data.name}
              placeholder="e.g. order_confirmation"
              onChange={(e) => set({ name: slugify(e.target.value) })}
            />
          </Field>

          <Field label="Category">
            <select value={data.category} onChange={(e) => set({ category: e.target.value })} className={`${INP_CLS} w-full`}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>

          <Field label="Language">
            <select value={data.language} onChange={(e) => set({ language: e.target.value })} className={`${INP_CLS} w-full`}>
              {LANGUAGES.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}
            </select>
          </Field>

          <Section title="HEADER">
            <select value={data.header.type} onChange={(e) => setHeaderType(e.target.value)} className={`${INP_CLS} w-[150px]`}>
              {['none', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].map((t) => (
                <option key={t} value={t}>{t === 'none' ? 'None' : t}</option>
              ))}
            </select>
            {data.header.type === 'TEXT' && (
              <input
                value={data.header.text}
                placeholder="Header text"
                onChange={(e) => set({ header: { ...data.header, text: e.target.value } })}
                className={`${INP_CLS} w-full mt-[0.35rem]`}
              />
            )}
            {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(data.header.type) && (
              <input
                value={data.header.url}
                placeholder="Media URL"
                onChange={(e) => set({ header: { ...data.header, url: e.target.value } })}
                className={`${INP_CLS} w-full mt-[0.35rem]`}
              />
            )}
          </Section>

          <Section title="BODY" extra={
            <>
              <span className="text-[0.72rem] text-dim mr-2">
                {(data.body.text || '').length}/1024
              </span>
              <button type="button" className="btn-sm text-[0.7rem]" onClick={insertVariable}>
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
              className={`${INP_CLS} w-full font-[inherit] resize-y`}
            />
          </Section>

          <Section title="FOOTER" extra={
            <label className="text-[0.76rem] inline-flex items-center gap-[0.3rem]">
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
              className={`${INP_CLS} w-full`}
            />
            <span className="text-[0.7rem] text-dim">{(data.footer.text || '').length}/60</span>
          </Section>

          <Section title="BUTTONS" extra={
            <button type="button" className="btn-sm text-[0.7rem]" onClick={addButton} disabled={data.buttons.length >= 3}>
              + Button
            </button>
          }>
            {data.buttons.map((b, i) => (
              <div key={i} className="flex gap-[0.3rem] items-center mb-[0.35rem]">
                <select value={b.type} onChange={(e) => updateButton(i, 'type', e.target.value)} className={`${INP_CLS} w-[130px]`}>
                  {['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].map((t) => (
                    <option key={t} value={t}>{t.replace('_', ' ')}</option>
                  ))}
                </select>
                <input value={b.text} placeholder="Label" onChange={(e) => updateButton(i, 'text', e.target.value)} className={`${INP_CLS} flex-1`} />
                {b.type !== 'QUICK_REPLY' && (
                  <input
                    value={b.value}
                    placeholder={b.type === 'URL' ? 'https://...' : 'Phone'}
                    onChange={(e) => updateButton(i, 'value', e.target.value)}
                    className={`${INP_CLS} flex-1`}
                  />
                )}
                <button type="button" className="btn-sm text-red text-[0.75rem]" onClick={() => removeButton(i)}>✕</button>
              </div>
            ))}
          </Section>

          {data.variables.length > 0 && (
            <Section title="VARIABLES">
              <table className="w-full border-collapse text-[0.76rem]">
                <thead>
                  <tr className="text-left text-dim">
                    <th className="p-1 w-[60px]">Var</th>
                    <th className="p-1">Source</th>
                    <th className="p-1">Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {data.variables.map((v, i) => (
                    <tr key={i}>
                      <td className="p-[0.2rem] font-mono">{`{{${v.index}}}`}</td>
                      <td className="p-[0.2rem]">
                        <select value={v.source} onChange={(e) => updateVariable(i, 'source', e.target.value)} className={`${INP_SM_CLS} w-full`}>
                          <option value="">-- select --</option>
                          {VARIABLE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="p-[0.2rem]">
                        <input value={v.sample} placeholder="Sample" onChange={(e) => updateVariable(i, 'sample', e.target.value)} className={`${INP_SM_CLS} w-full`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          <div className="flex gap-2 mt-4">
            <button type="button" className="btn-p" onClick={doSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Template'}
            </button>
            {metaId && (
              confirmDelete ? (
                <>
                  <button type="button" className="btn-sm bg-red-500 text-neutral-0 border-0 rounded-md py-[0.4rem] px-[0.8rem]" onClick={doDelete} disabled={deleting}>
                    {deleting ? '…' : `Confirm delete "${data.name}"`}
                  </button>
                  <button type="button" className="btn-g" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
                </>
              ) : (
                <button type="button" className="btn-g text-red" onClick={doDelete}>
                  Delete
                </button>
              )
            )}
            {onClose && <button type="button" className="btn-g" onClick={onClose}>Cancel</button>}
          </div>
        </div>

        <div id="te-preview" className="p-4 bg-[#e5ddd5] min-h-[480px]">
          <div className={`te-wa-bubble ${BUBBLE_CLS}`}>
            {data.header.type === 'TEXT' && data.header.text && (
              <div className="te-wa-header font-bold mb-[0.35rem]" dangerouslySetInnerHTML={{ __html: fmtWa(data.header.text) }} />
            )}
            {data.header.type === 'IMAGE' && (
              <div className="te-wa-img mb-[0.35rem]">
                {data.header.url ? <img src={data.header.url} alt="header" className="w-full rounded-md" /> : <div className={PLACEHOLDER_CLS}>IMAGE</div>}
              </div>
            )}
            {data.header.type === 'VIDEO' && (
              <div className="te-wa-img mb-[0.35rem]"><div className={PLACEHOLDER_CLS}>VIDEO</div></div>
            )}
            {data.header.type === 'DOCUMENT' && (
              <div className="te-wa-img mb-[0.35rem]"><div className={PLACEHOLDER_CLS}>DOCUMENT</div></div>
            )}
            {previewBody && (
              <div className="te-wa-body text-[0.85rem] text-[#111] whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: fmtWa(previewBody) }} />
            )}
            {data.footer.text && (
              <div className="te-wa-footer text-[0.72rem] text-[#667781] mt-[0.35rem]">{data.footer.text}</div>
            )}
            <div className="te-wa-time text-[0.68rem] text-[#667781] text-right mt-[0.35rem]">
              12:30 <span className="te-wa-checks">✓✓</span>
            </div>
          </div>
          {data.buttons.map((b, i) => (
            <div
              key={i}
              className="te-wa-btn bg-neutral-0 rounded-lg py-2 px-[0.6rem] mt-[0.35rem] text-center text-[#1f7ee3] font-semibold text-[0.82rem] shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
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
    <div className="mb-[0.6rem]">
      <label className="block text-[0.74rem] text-dim font-semibold mb-[0.2rem]">{label}</label>
      {children}
    </div>
  );
}

interface SectionProps { title: string; extra?: ReactNode; children: ReactNode }

function Section({ title, extra, children }: SectionProps): ReactNode {
  return (
    <div className="mt-[0.9rem] p-[0.6rem] bg-ink4 border border-rim rounded-md">
      <div className="flex items-center gap-[0.4rem] mb-[0.45rem]">
        <b className="text-[0.76rem]">{title}</b>
        <div className="ml-auto">{extra}</div>
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
    <div className="py-[0.7rem] px-[0.9rem] border-b border-rim bg-ink4">
      {loading ? (
        <span className="text-dim text-[0.82rem]">Loading gallery…</span>
      ) : !items.length ? (
        <span className="text-dim text-[0.82rem]">No gallery templates available.</span>
      ) : (
        <div className="flex flex-wrap gap-[0.4rem]">
          {items.map((t) => (
            <button
              key={t.id}
              type="button"
              className="btn-sm text-[0.72rem]"
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

// Composable className constants. Default-size input has its own variant
// because the variables-table cells need a smaller font/padding override
// and Tailwind utilities at the same specificity can't be reordered to
// "win" — so we just publish two sizes instead of using `!important`.
const INP_CLS = 'border border-rim rounded-md text-[0.82rem] py-[0.4rem] px-[0.55rem] bg-neutral-0';
const INP_SM_CLS = 'border border-rim rounded-md text-[0.72rem] py-[0.2rem] px-[0.3rem] bg-neutral-0';

const BUBBLE_CLS = 'bg-[#d9fdd3] rounded-lg py-[0.6rem] px-[0.7rem] max-w-[300px] shadow-[0_1px_2px_rgba(0,0,0,0.08)]';
const PLACEHOLDER_CLS = 'bg-[#c7e8c1] text-[#3d5f3a] p-4 rounded-md text-center text-[0.76rem] font-semibold';
