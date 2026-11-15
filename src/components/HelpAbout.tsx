'use client';

import { BookOpen, Download, ExternalLink, ShieldCheck } from 'lucide-react';
import { HELP_RESOURCES, type HelpResources } from '../application/help-resources';
import styles from './HelpAbout.module.css';

/** Links are opened only by the user's normal anchor activation. */
export default function HelpAbout({
  onVerification,
  resources = HELP_RESOURCES,
}: {
  onVerification?: () => void;
  resources?: HelpResources;
}) {
  const { app, manual, vendors } = resources;
  return (
    <div className={`page-panel ${styles.panel}`}>
      <div className="eyebrow">REFERENCE & SUPPORT</div>
      <h1>Help & About</h1>
      <p className="description">The HFD manual, official resources and implementation evidence.</p>
      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="help-manual-heading">
          <div className={styles.heading}>
            <BookOpen size={20} aria-hidden="true" />
            <h2 id="help-manual-heading">HFD manual</h2>
          </div>
          <p>{manual.title}</p>
          <p className={styles.muted}>
            Reference: {manual.pageCount} pages · HFD {manual.nativeSoftwareVersion}
          </p>
          {manual.bundled ? (
            <div className={styles.actions}>
              <a href={manual.url} target="_blank" rel="noopener noreferrer">
                <BookOpen size={14} aria-hidden="true" /> Open manual
              </a>
              <a href={manual.downloadUrl} download={manual.fileName}>
                <Download size={14} aria-hidden="true" /> Download PDF
              </a>
              <a href={manual.generalUrl} target="_blank" rel="noopener noreferrer">
                General · page {manual.resolvedGeneralPage}
              </a>
            </div>
          ) : (
            <>
              <p>
                The optional HFD PDF is not included in this build. Obtain HFD and its manual from
                the official Hypex website.
              </p>
              <div className={styles.actions}>
                <a href={manual.fallbackUrl} target="_blank" rel="noopener noreferrer">
                  Official Hypex resources <ExternalLink size={14} aria-hidden="true" />
                </a>
              </div>
            </>
          )}
          <details className={styles.source}>
            <summary>Manual source</summary>
            <p>{manual.provenance}</p>
            <p>{manual.fallbackReason}</p>
          </details>
        </section>
        <section className={styles.card} aria-labelledby="help-about-heading">
          <h2 id="help-about-heading">About {app.name}</h2>
          <dl className={styles.facts}>
            <div>
              <dt>App version</dt>
              <dd>{app.version}</dd>
            </div>
          </dl>
          <p className={styles.muted}>An independent Hypex FusionAmp interoperability project.</p>
          <div className={styles.vendors} aria-label="Official vendor websites">
            {vendors.map((vendor) => (
              <a key={vendor.id} href={vendor.url} target="_blank" rel="noopener noreferrer">
                {vendor.title} <ExternalLink size={12} aria-hidden="true" />
              </a>
            ))}
          </div>
        </section>
        <section
          className={`${styles.card} ${styles.verification}`}
          aria-labelledby="help-evidence-heading"
        >
          <div>
            <div className={styles.heading}>
              <ShieldCheck size={19} aria-hidden="true" />
              <h2 id="help-evidence-heading">Verification ledger</h2>
            </div>
            <p className={styles.muted}>
              Review implemented behavior and remaining hardware acceptance.
            </p>
          </div>
          <button type="button" onClick={() => onVerification?.()} disabled={!onVerification}>
            View verification
          </button>
        </section>
      </div>
    </div>
  );
}
