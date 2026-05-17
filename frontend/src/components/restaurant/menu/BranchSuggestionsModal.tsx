'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useToast } from '../../Toast';
import { assignProductToBranch, getBranchSuggestions } from '../../../api/restaurant';
import type { Branch, MenuItem } from '../../../types';

const REASON_LABEL: Record<string, string> = {
  name_match: 'name match',
  category_cluster: 'category cluster',
  all_active_fallback: 'fallback (all active)',
};

interface SuggestionRowApi {
  product_id: string;
  suggested_branch_ids?: string[];
  reason?: string;
}

interface SuggestionsResponse {
  suggestions?: SuggestionRowApi[];
}

interface SuggestionRow {
  product_id: string;
  suggested_branch_ids: string[];
  reason: string;
  name: string;
}

type SuggestMenuItem = MenuItem & { _id?: string };

interface BranchSuggestionsModalProps {
  branches: Branch[];
  menuItems: SuggestMenuItem[];
  onClose: () => void;
  onApplied?: () => void;
}

export default function BranchSuggestionsModal({ branches, menuItems, onClose, onApplied }: BranchSuggestionsModalProps) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState<boolean>(true);
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});
  const [applying, setApplying] = useState<boolean>(false);
  const [banner, setBanner] = useState<string>('Loading suggestions…');
  // Per-row failures from the last apply attempt, keyed by product_id →
  // list of branch ids that failed to assign. Populated on partial/total
  // failure; the modal stays open so the operator can see what to retry.
  const [rowErrors, setRowErrors] = useState<Record<string, string[]>>({});
  const modalRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Esc closes — never applies (mirrors CostConfirmCard's window keydown
  // pattern: e.key === 'Escape', cleanup on unmount). Esc is intentionally
  // left out of the Tab trap so it always escapes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus management + manual Tab trap. Capture pre-mount focus owner,
  // focus the first focusable element, restore on unmount; Tab/Shift+Tab
  // wrap within the modal container.
  useEffect(() => {
    const active = document.activeElement;
    prevFocusRef.current = active instanceof HTMLElement ? active : null;
    const SEL = 'button,input,select,textarea,[tabindex]:not([tabindex="-1"]),a[href]';
    const focusables = (): HTMLElement[] =>
      Array.from(modalRef.current?.querySelectorAll<HTMLElement>(SEL) || [])
        .filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const act = document.activeElement;
      if (e.shiftKey && act === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first?.focus(); }
    };
    const node = modalRef.current;
    node?.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener('keydown', onKey);
      prevFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = (await getBranchSuggestions()) as SuggestionsResponse | null | undefined;
        const list = (r && r.suggestions) || [];
        const nameById = new Map<string, string>();
        (menuItems || []).forEach((it) => {
          const key = String(it._id || it.id);
          nameById.set(key, it.name);
        });
        const mapped: SuggestionRow[] = list.map((s) => ({
          product_id: s.product_id,
          suggested_branch_ids: s.suggested_branch_ids || [],
          reason: s.reason || '',
          name: nameById.get(String(s.product_id)) || s.product_id,
        }));
        const sel: Record<string, Set<string>> = {};
        mapped.forEach((row) => { sel[row.product_id] = new Set(row.suggested_branch_ids); });
        setRows(mapped);
        setSelection(sel);
        if (!mapped.length) setBanner('No suggestions — every product is already assigned.');
        else setBanner(`Suggested mapping available for ${mapped.length} product${mapped.length === 1 ? '' : 's'}. Edit selections below or accept all.`);
      } catch (err: unknown) {
        const e = err as { message?: string };
        setBanner('Failed: ' + (e?.message || 'load error'));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (pid: string, bid: string) => {
    setSelection((s) => {
      const next: Record<string, Set<string>> = { ...s };
      const cur = new Set(next[pid] || []);
      if (cur.has(bid)) cur.delete(bid); else cur.add(bid);
      next[pid] = cur;
      return next;
    });
  };

  const acceptAll = () => {
    const next: Record<string, Set<string>> = {};
    rows.forEach((r) => { next[r.product_id] = new Set(r.suggested_branch_ids); });
    setSelection(next);
  };

  const apply = async () => {
    setApplying(true);
    setRowErrors({});
    let ok = 0; let fail = 0;
    const failed: Record<string, string[]> = {};
    for (const row of rows) {
      const picks = [...(selection[row.product_id] || [])];
      for (const bid of picks) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await assignProductToBranch(row.product_id, { branch_id: bid, price: 0, availability: true });
          ok += 1;
        } catch {
          fail += 1;
          (failed[row.product_id] ||= []).push(bid);
        }
      }
    }
    setApplying(false);
    showToast(`Applied ${ok} assignment${ok === 1 ? '' : 's'}${fail ? ` · ${fail} failed` : ''}`, fail ? 'error' : 'success');
    // Refresh the parent regardless — some rows may have been assigned —
    // but only auto-close on a clean run. On any failure keep the modal
    // open and surface the failed rows inline so they can be retried.
    if (onApplied) onApplied();
    if (fail > 0) {
      setRowErrors(failed);
      setBanner(`${fail} assignment${fail === 1 ? '' : 's'} failed${ok ? ` (${ok} succeeded)` : ''}. Review the highlighted products and retry.`);
      return;
    }
    setRowErrors({});
    if (onClose) onClose();
  };

  type LooseBranch = Branch & { _id?: string };
  const branchOpts = (branches || []).map((b) => {
    const lb = b as LooseBranch;
    return { id: String(lb._id || lb.id), name: lb.name || lb.id };
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 z-100 flex items-start justify-center py-8 px-4 overflow-y-auto"
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={modalRef} role="dialog" aria-modal="true" className="card max-w-[680px] w-full bg-surface">
        <div className="ch justify-between">
          <h3>🪄 Branch Suggestions</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={applying}>✕</button>
        </div>
        <div className="cb">
          <p className="text-sm text-dim mb-3">{banner}</p>
          {loading ? (
            <p className="text-dim">Loading…</p>
          ) : (
            <div className="max-h-[400px] overflow-y-auto border border-rim rounded-lg">
              {rows.map((row) => {
                const sel = selection[row.product_id] || new Set<string>();
                const failedBids = rowErrors[row.product_id] || [];
                const failedNames = failedBids
                  .map((bid) => branchOpts.find((b) => b.id === bid)?.name || bid)
                  .join(', ');
                return (
                  <div
                    key={row.product_id}
                    className={`py-2.5 px-3 border-b border-slate-100 ${
                      failedBids.length ? 'bg-red-50 border-l-2 border-l-red-500' : ''
                    }`}
                  >
                    <div className="flex justify-between items-center mb-1.5">
                      <div className="font-semibold text-base">{row.name}</div>
                      <div className="text-xs text-dim">{REASON_LABEL[row.reason] || row.reason}</div>
                    </div>
                    {failedBids.length > 0 && (
                      <div className="text-xs text-red-600 mb-1.5">
                        Failed to assign: {failedNames}. Adjust and retry.
                      </div>
                    )}
                    {/* Equal-width chip grid. minmax(110px, 1fr) keeps every
                        chip in a row at the same width while letting the
                        browser auto-pick column count by viewport width —
                        approximates the spec's 3 / 4 / 6 breakpoints
                        without needing a CSS-module media query. */}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-1.5">
                      {branchOpts.length ? branchOpts.map((b) => {
                        const on = sel.has(b.id);
                        return (
                          <label
                            key={b.id}
                            // width:100% via grid-cell stretch;
                            // min-h ≈ two lines of .78rem text (1.2 leading) + padding
                            // so single-word and two-word chips align top + bottom.
                            className={`inline-flex items-center justify-center gap-1 w-full min-h-10 box-border text-sm leading-[1.2] py-1 px-2 text-center wrap-break-word border rounded-xl cursor-pointer ${
                              on ? 'border-indigo-600 bg-indigo-100' : 'border-rim bg-white'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggle(row.product_id, b.id)}
                              className="m-0 shrink-0"
                            />
                            <span>{b.name}</span>
                          </label>
                        );
                      }) : <span className="text-sm text-dim">No branches yet</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex gap-2 mt-4 justify-end">
            <button type="button" className="btn-g" onClick={acceptAll} disabled={applying || loading || !rows.length}>Accept suggested</button>
            <button type="button" className="btn-p" onClick={apply} disabled={applying || loading || !rows.length}>
              {applying ? 'Applying…' : 'Apply selected'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
