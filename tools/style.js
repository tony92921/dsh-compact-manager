/**
 * Stylesheet for the plugin.
 *
 * Two independent sheets are combined rather than one being rewritten into the
 * other's prefix. The vendored sheet is scoped under `.dsh-cs-` and is copied
 * verbatim (the ring/satellite animation depends on exact rules); the sheet below
 * is scoped under `.dsh-ledger-` and covers the popup footer rows and the
 * settings page.
 *
 * The prefixes already differ, so nothing had to be renamed — but the ledger half
 * gained a few rules the original did not need: the second popup button, the
 * select/wide input controls the page uses, and a tabpane that holds form
 * rows instead of a card list.
 */

export const LEDGER_CSS = [
  // --- second popup button (mechanical fold) --------------------------------
  // Sits directly under the model button, same width and rhythm, but visually
  // secondary: it is the cheaper action, not the default one.
  ".dsh-cs-ledger{color:var(--dsw-alias-label-secondary);background:transparent;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4);gap:5px;display:inline-flex;align-items:center;justify-content:center}",
  ".dsh-cs-ledger:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);filter:none}",
  ".dsh-cs-ledger .dsh-cs-button-status{justify-content:center}",
  // An armed confirmation has to read as different from the idle button, or the
  // second click looks like it was ignored.
  ".dsh-cs-ledger[data-armed='1']{color:var(--dsw-alias-state-warning-primary,#f59e0b);box-shadow:inset 0 0 0 1px currentColor;background:color-mix(in srgb,currentColor 8%,transparent)}",
  // The footer is a column of buttons; the second one must not stretch under the
  // status rows that follow it.
  ".dsh-cs-content>.dsh-cs-ledger{align-self:stretch}",

  // --- settings page --------------------------------------------------------
  ".dsh-ledger-root{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;max-width:640px;flex-direction:column;display:flex;gap:10px}",
  ".dsh-ledger-title{align-items:center;gap:8px;display:flex;margin:0}",
  ".dsh-ledger-title h2{margin:0;font-size:20px;line-height:28px}",
  ".dsh-ledger-title-icon{width:16px;height:16px;color:var(--dsw-alias-label-secondary);flex:none;display:inline-grid;place-items:center}",
  ".dsh-ledger-title-icon svg{width:16px;height:16px}",
  ".dsh-ledger-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}",
  ".dsh-ledger-tabs{align-items:center;gap:2px;display:inline-flex;padding:2px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 9%,transparent);margin:2px 0}",
  ".dsh-ledger-tab{align-items:center;gap:5px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:1;padding:5px 10px;border-radius:7px;display:inline-flex}",
  ".dsh-ledger-tab:hover{color:var(--dsw-alias-label-primary)}",
  ".dsh-ledger-tab[data-active='1']{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}",
  ".dsh-ledger-tab-badge{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}",
  ".dsh-ledger-tabpane{display:flex;flex-direction:column;gap:0;min-width:0}",
  ".dsh-ledger-row{flex-direction:column;gap:3px;padding:7px 0;display:flex;min-width:0}",
  ".dsh-ledger-row+.dsh-ledger-row{border-top:.5px solid var(--dsw-alias-border-l2)}",
  ".dsh-ledger-row-head{align-items:center;gap:8px;display:flex;min-height:24px;min-width:0}",
  ".dsh-ledger-row-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:12.5px;font-weight:500;line-height:1.4}",
  ".dsh-ledger-row-icon{flex:none;width:22px;height:22px;border-radius:6px;display:inline-grid;place-items:center;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 10%,transparent)}",
  ".dsh-ledger-hint{color:var(--dsw-alias-label-tertiary);margin:0 0 0 30px;font-size:11.5px;line-height:1.45}",
  ".dsh-ledger-check{margin:0;accent-color:var(--dsw-alias-brand-primary);flex:none}",
  ".dsh-ledger-input{box-sizing:border-box;width:104px;max-width:100%;height:28px;border:.5px solid var(--dsw-alias-border-l4);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-variant-numeric:tabular-nums;padding:0 9px}",
  ".dsh-ledger-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
  ".dsh-ledger-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".dsh-ledger-select{box-sizing:border-box;height:28px;max-width:190px;border:.5px solid var(--dsw-alias-border-l4);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:0 6px}",
  ".dsh-ledger-select-wide{max-width:280px}",
  ".dsh-ledger-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
  ".dsh-ledger-num{align-items:center;gap:6px;display:inline-flex}",
  ".dsh-ledger-suffix{color:var(--dsw-alias-label-caption);font-size:11px;min-width:22px}",
  ".dsh-ledger-seg{align-items:center;gap:2px;display:inline-flex;padding:2px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 10%,transparent)}",
  ".dsh-ledger-seg-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11.5px;line-height:1;padding:5px 9px;border-radius:6px}",
  ".dsh-ledger-seg-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
  ".dsh-ledger-seg-btn[data-active='1']{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}",
  ".dsh-ledger-seg-btn:disabled{opacity:.55;cursor:default}",
  ".dsh-ledger-note{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:pre-wrap}",
  ".dsh-ledger-note[data-error]{color:var(--dsw-alias-state-error-primary)}",
  ".dsh-ledger-save{align-self:flex-start;margin-top:10px}",
  ".dsh-ledger-btn{align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l4);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;padding:4px 10px;display:inline-flex}",
  ".dsh-ledger-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsh-ledger-btn:disabled{opacity:.55;cursor:default}",
  ".dsh-ledger-ver{color:var(--dsw-alias-label-caption);font-size:11px;font-variant-numeric:tabular-nums}",

  // --- trigger result -------------------------------------------------------
  ".dsh-ledger-result{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 60%,transparent);padding:8px 10px 10px;margin:10px 0 2px;display:flex;flex-direction:column;gap:4px}",
  ".dsh-ledger-result-head{align-items:center;gap:8px;display:flex;justify-content:space-between}",
  ".dsh-ledger-result-title{align-items:center;gap:5px;color:var(--dsw-alias-label-caption);font-size:11px;display:inline-flex}",
  ".dsh-ledger-big{align-items:baseline;gap:6px;display:flex;flex-wrap:baseline;padding:2px 0}",
  ".dsh-ledger-big-num{color:var(--dsw-alias-label-primary);font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}",
  ".dsh-ledger-big-unit{color:var(--dsw-alias-label-caption);font-size:12px}",
  ".dsh-ledger-big-pct{color:var(--dsw-alias-label-secondary);font-size:13px;font-variant-numeric:tabular-nums;margin-left:auto}",
  ".dsh-ledger-bar{height:8px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);overflow:hidden;margin:4px 0 2px}",
  ".dsh-ledger-bar-fill{height:100%;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent);display:flex;align-items:stretch;transition:width .18s ease}",
  ".dsh-ledger-bar-retain{height:100%;background:color-mix(in srgb,var(--dsw-alias-label-primary) 78%,transparent)}",
  ".dsh-ledger-bar-legend{align-items:center;gap:14px;color:var(--dsw-alias-label-caption);font-size:11px;display:flex;flex-wrap:wrap;padding:2px 0 4px}",
  ".dsh-ledger-bar-legend>span{align-items:center;gap:5px;display:inline-flex}",
  ".dsh-ledger-swatch{width:9px;height:9px;border-radius:2px;flex:none}",
  ".dsh-ledger-swatch[data-kind='retain']{background:color-mix(in srgb,var(--dsw-alias-label-primary) 78%,transparent)}",
  ".dsh-ledger-swatch[data-kind='foldable']{background:color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent)}",
  ".dsh-ledger-calc{display:flex;flex-direction:column;gap:2px;padding:4px 0 2px;font-variant-numeric:tabular-nums}",
  ".dsh-ledger-calc-row{align-items:baseline;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;display:flex;flex-wrap:wrap;padding:2px 0}",
  ".dsh-ledger-calc-row code{color:var(--dsw-alias-label-caption);font-family:inherit;font-size:11.5px}",
  ".dsh-ledger-calc-row[data-win='1']{color:var(--dsw-alias-label-secondary)}",
  ".dsh-ledger-calc-row[data-win='1'] code{color:var(--dsw-alias-label-primary);font-weight:600}",
  ".dsh-ledger-calc-row em{margin-left:auto;color:var(--dsw-alias-label-primary);font-size:11px;font-style:normal}",
  ".dsh-ledger-calc-note{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;padding:2px 0 0}",

  // --- connectivity probe ---------------------------------------------------
  ".dsh-ledger-probe{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px 9px;margin:10px 0 2px;display:flex;flex-direction:column;gap:6px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 45%,transparent)}",
  ".dsh-ledger-probe-head{align-items:center;gap:6px;display:flex;flex-wrap:wrap}",
  ".dsh-ledger-probe-title{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}",
  ".dsh-ledger-probe-note{color:var(--dsw-alias-label-caption);font-size:11px;margin-left:auto}",
  ".dsh-ledger-probe-controls{align-items:center;gap:6px;display:flex}",
  ".dsh-ledger-probe-label{color:var(--dsw-alias-label-caption);font-size:11px}",
  ".dsh-ledger-probe-buttons{display:flex;gap:6px;flex-wrap:wrap}",
  ".dsh-ledger-probe-btn{flex:1 1 140px;min-width:0;justify-content:center;align-items:center;display:inline-flex;gap:4px}",
  ".dsh-ledger-probe-btn[data-running='1']{opacity:.75}",
  ".dsh-ledger-probe-sub{color:var(--dsw-alias-label-caption);font-size:10.5px;font-style:normal;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:9em;display:inline-block;vertical-align:bottom}",
  ".dsh-ledger-probe-result{border-radius:6px;padding:5px 8px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 6%,transparent);display:flex;flex-direction:column;gap:2px}",
  ".dsh-ledger-probe-result[data-ok='1']{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e9e5b) 10%,transparent)}",
  ".dsh-ledger-probe-result[data-ok='0']{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}",
  ".dsh-ledger-probe-line{align-items:baseline;gap:8px;display:flex;flex-wrap:wrap}",
  ".dsh-ledger-probe-verdict{font-size:11.5px;font-weight:600}",
  ".dsh-ledger-probe-result[data-ok='1'] .dsh-ledger-probe-verdict{color:var(--dsw-alias-state-success-primary,#2e9e5b)}",
  ".dsh-ledger-probe-result[data-ok='0'] .dsh-ledger-probe-verdict{color:var(--dsw-alias-state-error-primary)}",
  ".dsh-ledger-probe-ms{color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;font-weight:600}",
  ".dsh-ledger-probe-dim{color:var(--dsw-alias-label-caption);font-size:11px;margin-left:auto}",
  ".dsh-ledger-probe-detail{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-word}",
  ".dsh-ledger-probe-preview{color:var(--dsw-alias-label-caption);font-size:10.5px;line-height:15px;white-space:pre-wrap;max-height:44px;overflow:hidden;border-left:2px solid color-mix(in srgb,var(--dsw-alias-label-caption) 30%,transparent);padding-left:6px;margin-top:1px}",

  // --- diagnostics ----------------------------------------------------------
  ".dsh-ledger-diag-head{align-items:center;gap:8px;display:flex;padding:6px 0 2px}",
  ".dsh-ledger-diag-groups{display:flex;flex-direction:column;gap:10px;margin:2px 0}",
  ".dsh-ledger-diag-group{display:flex;flex-direction:column;gap:2px;min-width:0}",
  ".dsh-ledger-diag-group-head{align-items:baseline;gap:8px;display:flex;flex-wrap:wrap;padding:2px 0 1px}",
  ".dsh-ledger-diag-group-title{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}",
  ".dsh-ledger-diag-group-note{color:var(--dsw-alias-label-caption);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dsh-ledger-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 8px;margin:4px 0 2px}",
  ".dsh-ledger-cell{align-items:baseline;gap:6px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 6%,transparent);padding:5px 8px;display:flex;min-width:0}",
  ".dsh-ledger-cell-key{color:var(--dsw-alias-label-caption);font-size:11px;flex:none}",
  ".dsh-ledger-cell-val{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".dsh-ledger-cell[data-bad='1'] .dsh-ledger-cell-val{color:var(--dsw-alias-state-error-primary)}",
  ".dsh-ledger-last-model{align-items:baseline;gap:6px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 6%,transparent);padding:5px 8px;display:flex;flex-wrap:wrap;min-width:0;margin-top:2px}",
  ".dsh-ledger-last-model-key{color:var(--dsw-alias-label-caption);font-size:11px;flex:none}",
  ".dsh-ledger-last-model-val{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}",
  ".dsh-ledger-last-model-at{color:var(--dsw-alias-label-caption);font-size:10.5px;flex:none;font-variant-numeric:tabular-nums}",
  ".dsh-ledger-last-model-note{flex-basis:100%;color:var(--dsw-alias-state-warning-primary,#b07d1a);font-size:10.5px;line-height:15px}",
  ".dsh-ledger-last-model[data-fellback='1']{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b07d1a) 10%,transparent)}"
].join("");
