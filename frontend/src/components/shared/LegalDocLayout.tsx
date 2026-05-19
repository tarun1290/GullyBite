import type { ReactNode } from 'react';

/**
 * Shared chrome + typography primitives for the public legal documents
 * (/terms, /privacy). Server component — no client interactivity. Both
 * pages compose the same building blocks so heading hierarchy, spacing,
 * and muted-text treatment stay identical between documents.
 */

interface LegalDocLayoutProps {
  title: string;
  lastUpdated: string;
  version: string;
  children: ReactNode;
}

export default function LegalDocLayout({
  title,
  lastUpdated,
  version,
  children,
}: LegalDocLayoutProps) {
  return (
    <main className="min-h-screen bg-bg">
      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <header className="border-b border-rim pb-6">
          <h1 className="text-3xl font-bold tracking-tight text-tx sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 inline-block rounded-full border border-rim px-3 py-1 text-sm font-semibold text-acc">
            Last updated: {lastUpdated}
          </p>
        </header>

        <div className="mt-10 space-y-10">{children}</div>

        <footer className="mt-16 border-t border-rim pt-6">
          <p className="text-xs text-mute">Version: {version}</p>
        </footer>
      </article>
    </main>
  );
}

/** Lead-in paragraphs that appear before the first numbered section. */
export function LegalIntro({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4 text-base leading-7 text-dim">{children}</div>
  );
}

/** A top-level numbered section — renders an <h2>. */
export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight text-tx">
        {heading}
      </h2>
      {children}
    </section>
  );
}

/** A sub-clause within a section — renders an <h3>. */
export function LegalSubsection({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-tx">{heading}</h3>
      {children}
    </div>
  );
}

/** Body prose paragraph. */
export function LegalParagraph({ children }: { children: ReactNode }) {
  return <p className="text-base leading-7 text-tx">{children}</p>;
}

/** Bulleted list (used for the dash-prefixed lists in the source text). */
export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-6 text-base leading-7 text-tx marker:text-mute">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * Lettered / roman clause list — preserves the literal "(a)", "(i)"
 * markers from the legal text. `body` may itself contain a nested
 * LegalClauseList for the (a) → (i) sub-numbering.
 */
export function LegalClauseList({
  items,
}: {
  items: { label: string; body: ReactNode }[];
}) {
  return (
    <ul className="list-none space-y-3 text-base leading-7 text-tx">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span className="shrink-0 font-semibold text-tx">{item.label}</span>
          <div className="space-y-3">{item.body}</div>
        </li>
      ))}
    </ul>
  );
}
