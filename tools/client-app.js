/**
 * Merged conversation popup: one anchor, two manual buttons.
 *
 * The saviour plugin attached a footer to the native context popup and put one
 * "手动压缩" button in it. The ledger plugin attached a separate lightning chip to
 * the composer's left side for its mechanical fold. Keeping two controls for one
 * concern was the main thing the merge was supposed to fix, so this file replaces
 * both with the saviour popup plus a second button directly beneath the first:
 *
 *   [ 手动压缩 ]        ← model path (existing behaviour, unchanged)
 *   [ 手动非模型压缩 ]   ← local fold: no model, no tokens
 *
 * The lighting chip on the left stays (it is the pressure gauge and the
 * long-press shortcut, and it is referenced from the settings preview), but it is
 * registered from here rather than from a second plugin.
 */

const PACKAGE = "dsh-compact-manager";
const ENDPOINT = "/api/dsh-compact-manager/v1";
/** Lightning outline shared by the composer bolt and the settings title. */
const BOLT_PATH = "M13 2 4 14h7l-1 8 10-12h-7l1-8z";
/** How long an armed confirmation stays armed before it decays back to idle. */
const ARM_MS = 4000;

const h = React.createElement;

/** JSON helper over the plugin's own HTTP route. */
async function api(params = "", data, signal) {
  const response = await fetch(ENDPOINT + params, {
    credentials: "same-origin",
    signal,
    ...(data ? {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    } : {})
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`压缩服务暂未就绪（HTTP ${response.status}），请稍后重试。`);
  }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

// ---------------------------------------------------------------------------
// Conversation popup
// ---------------------------------------------------------------------------

/**
 * Zero-layout anchor that scopes the native ring gesture, its status animation
 * and the popup footer. The ring, the meter and the footer are all owned by the
 * harness DOM, so this component keeps a portal target instead of rendering the
 * popup itself.
 */
function PopupBridge({ sessionId }) {
  const anchor = React.useRef(null);
  const [footer, setFooter] = React.useState(null);
  const [state, setState] = React.useState(undefined);
  const [error, setError] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const posting = React.useRef(false);
  const act = React.useRef(async () => {});
  const latest = React.useRef(undefined);
  const syncMeter = React.useRef(() => {});

  React.useEffect(() => {
    const abort = new AbortController();
    let timer;
    let revision = 0;
    let connectionError = "";
    setState(undefined);
    latest.current = undefined;
    setError("");
    setSending(false);
    posting.current = false;
    const update = (value) => {
      latest.current = value;
      setState(value);
      syncMeter.current();
    };
    act.current = async (action) => {
      if (posting.current || abort.signal.aborted) return;
      posting.current = true;
      revision++;
      setSending(true);
      setError("");
      syncMeter.current();
      try {
        const value = await api("", { action, sessionId }, abort.signal);
        // POST acknowledges a job without remeasuring context. Keep the last
        // same-session reading until GET replaces it, avoiding an 8M flash.
        if (!abort.signal.aborted) update({ ...value, context: value.context ?? latest.current?.context });
      } catch (error) {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!abort.signal.aborted) {
          posting.current = false;
          revision++;
          setSending(false);
          syncMeter.current();
        }
      }
    };
    const poll = async () => {
      const started = revision;
      try {
        const value = await api(`?sessionId=${encodeURIComponent(sessionId)}`, undefined, abort.signal);
        if (!abort.signal.aborted && started === revision && !posting.current) {
          update(value);
          const previous = connectionError;
          setError((current) => (current === previous ? "" : current));
          connectionError = "";
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          connectionError = error instanceof Error ? error.message : String(error);
          setError(connectionError);
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      act.current = async () => {};
    };
  }, [sessionId]);

  React.useEffect(() => {
    const root = anchor.current && contextRoot(anchor.current);
    if (!root) return;
    let owned = null;
    let observedPanel;
    const meter = new MeterBridge();
    let control;
    const observeOptions = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "aria-label", "aria-describedby", "stroke-dasharray", "style"]
    };
    const sync = () => {
      const ring = contextRing(root);
      const panel = contextPanel(ring);
      if (panel !== observedPanel) {
        panelObserver.disconnect();
        observedPanel = panel;
        if (panel) panelObserver.observe(panel, observeOptions);
      }
      meter.apply(ring, latest.current?.context);
      if (control?.button !== ring) {
        control?.destroy();
        control = ring ? new RingControl(ring, () => { void act.current("configured"); }) : undefined;
      }
      control?.update(posting.current ? "sending" : latest.current?.job.phase ?? "idle", Boolean(latest.current?.available));
      if (owned && owned.parentElement === panel) {
        // The optional breakdown can arrive after the portal footer. React
        // appends its new rows last; keep our action beneath those native rows.
        if (panel && panel.lastElementChild !== owned) panel.append(owned);
        return;
      }
      owned?.remove();
      owned = null;
      if (panel && !panel.querySelector("[data-compact-saviour]")) {
        owned = document.createElement("div");
        owned.dataset.compactSaviour = "footer";
        owned.className = "dsh-cs-footer";
        panel.append(owned);
      }
      setFooter(owned);
    };
    const observer = new MutationObserver(sync);
    const panelObserver = new MutationObserver(sync);
    const portals = new MutationObserver(sync);
    observer.observe(root, observeOptions);
    // Only direct body children, not the streaming transcript subtree.
    portals.observe(root.ownerDocument.body, { childList: true });
    syncMeter.current = sync;
    sync();
    return () => {
      syncMeter.current = () => {};
      observer.disconnect();
      portals.disconnect();
      panelObserver.disconnect();
      control?.destroy();
      meter.restore();
      owned?.remove();
    };
  }, [sessionId]);

  return h(React.Fragment, null,
    h("span", { ref: anchor, style: { display: "none" }, "aria-hidden": "true" }),
    footer ? react_dom.createPortal(
      h(CompactFooter, { state, sending, error, act: (action) => act.current(action) }),
      footer
    ) : null
  );
}

/**
 * The two manual buttons and the job status.
 *
 * Both buttons read the same `job` shape from the Host; they differ only in the
 * action they post and the copy they show, so one component renders both instead
 * of duplicating the progress/error/label logic.
 */
function CompactFooter({ state, sending, error, act }) {
  const job = state?.job;
  const active = job?.phase === "queued" || job?.phase === "running";
  const current = job?.current;
  const busy = sending || active;
  const running = !sending && job?.phase === "running";
  const stage = job?.message.includes("合并摘要") ? "merge" : "compress";
  const mechanical = typeof job?.message === "string" && job.message.includes("折页");
  const engine = state?.engine;
  const label = sending
    ? "正在提交"
    : job?.phase === "queued"
      ? "等待当前步骤结束"
      : job?.phase === "running"
        ? mechanical
          ? "正在折页"
          : stage === "merge" ? "正在合并摘要" : "正在压缩"
        : "手动压缩";
  const progress = !sending && job?.phase === "running" && Number.isInteger(job.completed) && Number.isInteger(job.total)
    && job.total > 1 && job.completed >= 0 && job.completed <= job.total
    ? `${job.completed}/${job.total}`
    : "";
  const noModel = state && !state.config?.model;

  // The fold discards detail irreversibly, so it can require a second click. The
  // arming resets on its own: an armed button left alone must not stay primed for
  // a click the user has forgotten about.
  const [armed, setArmed] = React.useState(false);
  const confirmFold = state?.config?.confirmFold !== false;
  const armedAt = React.useRef(0);
  React.useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  // A new job (or a different session's state) disarms the pending confirmation.
  React.useEffect(() => { setArmed(false); }, [job?.phase]);
  const foldLabel = armed ? "再点一次确认折页" : busy && mechanical ? "正在折页" : "手动非模型压缩";
  const onFold = () => {
    if (sending || active) return;
    if (confirmFold && !armed) {
      armedAt.current = Date.now();
      setArmed(true);
      return;
    }
    setArmed(false);
    void act("mechanical");
  };

  return h("div", { className: "dsh-cs-content", "data-phase": sending ? "sending" : job?.phase ?? "idle" },
    h("button", {
      className: "dsh-cs-button dsh-cs-primary dsh-cs-compact",
      type: "button",
      "aria-label": progress ? `${label} ${progress}` : label,
      disabled: sending || !state?.available || active,
      onClick: () => void act("configured")
    },
      h("span", { className: "dsh-cs-button-status", "aria-hidden": "true" },
        running ? h(WaitingCopy, { key: stage, stage }) : h("span", { className: "dsh-cs-label" }, label + (busy ? "…" : "")),
        progress ? h("span", { className: "dsh-cs-progress" }, " " + progress) : null
      ),
      h("span", { className: "dsh-cs-sr-status", role: "status", "aria-live": "polite", "aria-atomic": "true" },
        label + (progress ? ` ${progress}` : ""))
    ),
    !active && !sending ? h("div", { className: "dsh-cs-hint" }, "也可以长按圆环直接压缩") : null,

    // Second manual action: local mechanical fold. It is deliberately available
    // even when no model is configured, because that is exactly the case where a
    // local fold is the only way to shrink history at all.
    h("button", {
      className: "dsh-cs-button dsh-cs-compact dsh-cs-ledger",
      type: "button",
      "aria-label": foldLabel,
      disabled: sending || active,
      "data-armed": armed ? "1" : undefined,
      title: armed
        ? "再点一次把旧历史换成短卡，不可恢复"
        : "机械折页：把旧历史换成短卡，不调模型，不花 token" + (confirmFold ? "（需再点一次确认）" : ""),
      onClick: onFold
    },
      h("span", { className: "dsh-cs-button-status", "aria-hidden": "true" },
        h("span", { className: "dsh-cs-label" }, foldLabel)
      ),
      h("span", { className: "dsh-cs-sr-status", role: "status", "aria-live": "polite" }, foldLabel)
    ),
    armed ? h("div", { className: "dsh-cs-status", role: "status" }, "这会把旧历史换成短卡，不可恢复。再点一次确认。") : null,

    !busy && job?.message ? h("div", { className: "dsh-cs-status dsh-cs-job-status", role: "status" },
      h("span", null, job.message,
        job.phase === "done" && job.beforeTokens !== undefined && job.afterTokens !== undefined
          ? ` ${Math.round(job.beforeTokens / 1000)}K → ${Math.round(job.afterTokens / 1000)}K`
          : "")) : null,
    state?.context?.corrected ? h("div", { className: "dsh-cs-status" },
      state.context.reason === "invalid-usage"
        ? "已排除异常历史用量，当前按消息和工具估算。"
        : "已按新模型的上下文容量重新估算。") : null,
    error ? h("div", { className: "dsh-cs-error", role: "alert" }, error) : null,
    state && noModel && engine !== "ledger"
      ? h("div", { className: "dsh-cs-status" }, "先在设置 → 压缩管理 中选择压缩模型；或直接用「手动非模型压缩」。")
      : null,
    state && !state.available ? h("div", { className: "dsh-cs-status" }, "当前会话的 Compact 后端尚未就绪。") : null,
    job?.phase === "failed" ? h("div", { className: "dsh-cs-actions" },
      h("button", { className: "dsh-cs-button", disabled: sending, onClick: () => void act("configured") }, "重试压缩模型"),
      current ? h("button", { className: "dsh-cs-button", disabled: sending, onClick: () => void act("current") },
        `本次使用 ${current.model} · ${current.reasoningEffort || "默认推理"}`) : null
    ) : null,
    active || job?.phase === "failed"
      ? h("button", { className: "dsh-cs-button", disabled: sending, onClick: () => void act("cancel") }, "取消")
      : null
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** The bolt outline, filled from the bottom to `fill`. */
function FoldBoltIcon({ fill = 0 }) {
  const uid = React.useId ? React.useId() : "bolt";
  const clipId = "dsh-ledger-clip-" + String(uid).replace(/[^a-zA-Z0-9_-]/g, "");
  const clamped = Math.min(1, Math.max(0, Number(fill) || 0));
  return h("svg", { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": "true" },
    h("defs", null, h("clipPath", { id: clipId }, h("path", { d: BOLT_PATH }))),
    h("path", {
      d: BOLT_PATH,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinejoin: "round",
      strokeLinecap: "round",
      opacity: 0.42
    }),
    h("g", { clipPath: `url(#${clipId})` },
      h("rect", { x: 0, y: 24 * (1 - clamped), width: 24, height: 24 * clamped + 0.01, fill: "currentColor" })
    )
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * One page for both halves.
 *
 * Tabs rather than a single long form: the two subsystems are independent (a
 * user may care only about the model, or only about ingress shaping), and the
 * saviour page was already a single screen that people learned. Splitting by
 * subsystem keeps both recognisable instead of interleaving thirteen fields.
 */
function SettingsPanel() {
  const [tab, setTab] = React.useState("model");
  const [state, setState] = React.useState(undefined);
  const [models, setModels] = React.useState([]);
  const [efforts, setEfforts] = React.useState([]);
  const [fallbackEfforts, setFallbackEfforts] = React.useState([]);
  // Live-probe state. `probing` holds the model number currently running so the two
  // buttons can disable each other: two simultaneous probes on the same provider
  // would fight over the same rate limit and make both timings meaningless.
  const [probeSize, setProbeSize] = React.useState("tiny");
  const [sizes, setSizes] = React.useState([]);
  const [probing, setProbing] = React.useState("");
  const [probeResults, setProbeResults] = React.useState({});
  const [message, setMessage] = React.useState("");
  // Whether the status line reports a rejected write rather than an acknowledgement.
  const [messageFailed, setMessageFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [health, setHealth] = React.useState(undefined);
  const [healthBusy, setHealthBusy] = React.useState(false);
  const [healthError, setHealthError] = React.useState("");
  const [preview, setPreview] = React.useState(undefined);
  const [previewBusy, setPreviewBusy] = React.useState(false);

  React.useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      api("", undefined, abort.signal),
      api("?models=1", undefined, abort.signal)
    ]).then(([value, modelList]) => {
      if (abort.signal.aborted) return;
      setState(value);
      setModels(modelList.models ?? []);
      // The Host owns the length options; the page only renders them.
      setSizes(modelList.sizes ?? []);
    }).catch((error) => {
      if (!abort.signal.aborted) setMessage(error.message);
    });
    return () => abort.abort();
  }, []);

  const config = state?.config;

  React.useEffect(() => {
    const abort = new AbortController();
    setEfforts([]);
    if (config?.provider && config.model) {
      api(`?provider=${encodeURIComponent(config.provider)}&model=${encodeURIComponent(config.model)}`, undefined, abort.signal)
        .then((value) => { if (!abort.signal.aborted) setEfforts(value.efforts ?? []); })
        .catch((error) => { if (!abort.signal.aborted) setMessage(error.message); });
    }
    return () => abort.abort();
  }, [config?.provider, config?.model]);

  // Reasoning levels come per model. The fallback model can support a different set
  // than model 1, so its options are fetched separately rather than reused.
  React.useEffect(() => {
    const abort = new AbortController();
    setFallbackEfforts([]);
    if (config?.fallbackProvider && config?.fallbackModel) {
      api(`?provider=${encodeURIComponent(config.fallbackProvider)}&model=${encodeURIComponent(config.fallbackModel)}`, undefined, abort.signal)
        .then((value) => { if (!abort.signal.aborted) setFallbackEfforts(value.efforts ?? []); })
        .catch(() => { if (!abort.signal.aborted) setFallbackEfforts([]); });
    }
    return () => abort.abort();
  }, [config?.fallbackProvider, config?.fallbackModel]);

  // Every mutation goes through `patch`, which both updates the on-screen value and
  // queues the write. Keeping the two together is what makes autosave complete: a
  // control that forgot to call `queueSave` would look saved and silently not be.
  //
  // `patch` must be called with a *complete* value for whatever it changes. The Host
  // rejects half-configured model pairs, and with no Save button there is no moment
  // where "provider chosen, model not yet" could be a legitimate intermediate state —
  // so the pickers hand over provider + model + reasoning level in one call.
  const patch = (next) => {
    setState((value) => ({ ...value, config: { ...value.config, ...next } }));
    queueSave();
  };

  // --- autosave --------------------------------------------------------------
  // There is no Save button: every edit persists on its own. Four things make that
  // safe rather than sloppy:
  //
  // 1. The write is debounced. Dragging a number field or flipping three switches
  //    would otherwise fire one request per keystroke, and the Host's settings
  //    service would race its own writes. 250ms coalesces a burst and still feels
  //    immediate.
  // 2. The config is read from a ref at send time, not captured in the closure. A
  //    debounced callback closing over an old `config` would write a stale copy and
  //    silently revert whatever changed during the wait.
  // 3. Writes are serialized. The Host resolves model metadata on every save, so two
  //    overlapping requests can finish out of order and leave the older config stored.
  // 4. An edit that lands *during* a round trip must not be overwritten by that
  //    trip's response. `editSeq` is bumped by every patch; a response is only
  //    adopted when the sequence still matches the one it was sent for.
  const latest = React.useRef(undefined);
  latest.current = state?.config;
  const saveTimer = React.useRef(undefined);
  const inFlight = React.useRef(undefined);
  const editSeq = React.useRef(0);
  const noticeTimer = React.useRef(undefined);

  /** Replace the status line, and clear a success notice on its own after a moment. */
  const notice = (text, options = {}) => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current);
    noticeTimer.current = undefined;
    setMessage(text);
    setMessageFailed(false);
    if (options.fade) {
      noticeTimer.current = setTimeout(() => {
        noticeTimer.current = undefined;
        setMessage("");
      }, 2000);
    }
  };

  /**
   * Report a rejected write.
   *
   * This is the one state autosave can get wrong in a way a Save button could not:
   * the controls already show the new value, so without an error the user would
   * believe a rejected edit was stored. It stays on screen until the next edit
   * replaces it — no fade, because it is not an acknowledgement.
   */
  const warn = (text) => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current);
    noticeTimer.current = undefined;
    setMessage(text);
    setMessageFailed(true);
  };

  const persist = async () => {
    if (inFlight.current) await inFlight.current.catch(() => {});
    const config = latest.current;
    if (!config) return;
    const sentSeq = editSeq.current;
    setSaving(true);
    const run = (async () => {
      try {
        const value = await api("", { action: "settings", config });
        // Only adopt the Host's echo when nothing changed while it was in flight.
        // Adopting it unconditionally would revert a field the user edited during
        // the round trip — the exact race a Save button never had to face.
        if (editSeq.current === sentSeq) {
          setState((previous) => ({ ...previous, config: value.config }));
          notice("已自动保存", { fade: true });
        }
      } catch (error) {
        // A rejected value must stay visible: the Host refuses half-configured model
        // pairs, and silently keeping the old value would look like the edit worked.
        warn("未保存：" + (error instanceof Error ? error.message : String(error)));
      } finally {
        setSaving(false);
      }
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      if (inFlight.current === run) inFlight.current = undefined;
    }
  };

  React.useEffect(() => () => {
    // An edit must not be dropped because the panel closed before the debounce fired.
    // This sends the request directly: the component is unmounting, so updating its
    // state would be pointless work.
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current);
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current);
    saveTimer.current = undefined;
    noticeTimer.current = undefined;
    const config = latest.current;
    if (config !== undefined) {
      void api("", { action: "settings", config }).catch(() => {});
    }
  }, []);

  /** Queue a write after the edits stop. */
  const queueSave = () => {
    editSeq.current += 1;
    if (noticeTimer.current !== undefined) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = undefined;
    }
    setMessage("保存中…");
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      void persist();
    }, 250);
  };

  const loadHealth = () => {
    setHealthBusy(true);
    return api("?health=1").then((value) => {
      setHealth(value);
      setHealthError("");
      setHealthBusy(false);
    }, (error) => {
      setHealth(undefined);
      setHealthError(error?.message || "读取失败");
      setHealthBusy(false);
    });
  };

  /**
   * Send one real request through the selected model and record what happened.
   *
   * Results are keyed by model number so both stay on screen: comparing model 1
   * against model 2 is the reason to run them in the first place, and a single
   * shared result box would erase the first as soon as the second finished.
   *
   * The elapsed time is measured by the Host, not here, so it excludes this page's
   * own round trip and can be compared across browsers and refresh rates.
   */
  const runProbe = (which) => {
    if (probing) return;
    setProbing(which);
    setProbeResults((previous) => ({ ...previous, [which]: undefined }));
    const query = new URLSearchParams({ probe: "1", model: which, size: probeSize });
    return api("?" + query.toString()).then((value) => {
      setProbeResults((previous) => ({ ...previous, [which]: value }));
      setProbing("");
    }, (error) => {
      setProbeResults((previous) => ({
        ...previous,
        [which]: { ok: false, error: error?.message || "测试失败", ms: 0 }
      }));
      setProbing("");
    });
  };

  /**
   * Render the trigger the Host would actually enforce, from the Host's own
   * resolver.
   *
   * The page must not recompute the formula locally: `threshold = min(window ×
   * ratio, message budget − headroom)` looks trivial, but the inputs (which model
   * is routed, what it reserves for output) live on the Host. A local copy would
   * agree until the day either side changed, and then disagree silently — the
   * page would promise a trigger the engine never uses.
   */
  const loadPreview = () => {
    if (!config) return Promise.resolve();
    setPreviewBusy(true);
    const query = new URLSearchParams({
      threshold: "1",
      ratio: String(config.thresholdRatio ?? ""),
      headroom: String(config.headroomTokens ?? ""),
      retain: String(config.retainRatio ?? "")
    });
    return api("?" + query.toString()).then((value) => {
      setPreview(value);
      setPreviewBusy(false);
    }, (error) => {
      setPreview({ error: error?.message || "读取失败" });
      setPreviewBusy(false);
    });
  };

  // Refresh the preview whenever a trigger input changes, so the resolved number
  // tracks the form without a "compute" button the user could forget to press.
  React.useEffect(() => {
    if (!config) return;
    const abort = new AbortController();
    const timer = setTimeout(() => { if (!abort.signal.aborted) void loadPreview(); }, 250);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [config?.thresholdRatio, config?.headroomTokens, config?.retainRatio, config?.thresholdOverride]);

  // Every hook above has run, so an early return is safe from here on. Before the
  // first fetch resolves there is no config, and rendering the form against
  // `undefined` throws on the first field read — which React answers by
  // unmounting the section, so the settings entry disappears with no message.
  if (!config) {
    return h("div", { className: "dsh-ledger-root" },
      h("div", { className: "dsh-ledger-title" },
        h("span", { className: "dsh-ledger-title-icon", "aria-hidden": "true" }, h(FoldBoltIcon, { fill: 0.4 })),
        h("h2", null, "压缩管理")),
      h("p", { className: "dsh-ledger-muted" }, message || "正在读取设置…")
    );
  }

  const selected = config?.model ? JSON.stringify([config.provider, config.model]) : "";
  const fallbackSelected = config?.fallbackModel
    ? JSON.stringify([config.fallbackProvider, config.fallbackModel])
    : "";

  const row = (icon, label, hint, control) => h("div", { className: "dsh-ledger-row" },
    h("div", { className: "dsh-ledger-row-head" },
      h("span", { className: "dsh-ledger-row-icon", "aria-hidden": "true" }, h(SettingIcon, { name: icon })),
      h("label", { className: "dsh-ledger-row-label" }, label),
      control
    ),
    hint ? h("p", { className: "dsh-ledger-hint" }, hint) : null
  );

  const toggle = (icon, label, hint, key) => row(icon, label, hint,
    h("input", {
      type: "checkbox",
      className: "dsh-ledger-check",
      checked: config[key] === true,
      onChange: (event) => patch({ [key]: event.target.checked })
    }));

  const number = (icon, label, hint, key, options) => h(NumberField, {
    icon, label, hint, options,
    value: Number(config[key]) || options.fallback,
    onCommit: (value) => patch({ [key]: options.scale ? value / options.scale : Math.round(value) })
  });

  // Probe controls. Both are closures so they can read the live probe state; the
  // result renderer is shared so model 1 and model 2 always present identically.
  const probeButton = (which, label, subtitle) => h("button", {
    type: "button",
    className: "dsh-cs-button dsh-ledger-probe-btn",
    "data-running": probing === which ? "1" : undefined,
    disabled: probing !== "",
    title: subtitle,
    onClick: () => void runProbe(which)
  },
    probing === which
      ? h("span", null, "测试中…")
      : h("span", null, label, h("em", { className: "dsh-ledger-probe-sub" }, subtitle))
  );

  const probeResult = (which) => {
    const result = probeResults[which];
    if (!result) return null;
    const elapsed = formatMs(result.ms);
    return h("div", {
      className: "dsh-ledger-probe-result",
      "data-ok": result.ok ? "1" : "0"
    },
      h("div", { className: "dsh-ledger-probe-line" },
        h("span", { className: "dsh-ledger-probe-verdict" }, result.ok ? "通过" : "失败"),
        result.ok ? h("span", { className: "dsh-ledger-probe-ms" }, elapsed) : null,
        result.size ? h("span", { className: "dsh-ledger-probe-dim" }, "长度 " + result.size) : null
      ),
      result.ok
        ? h("div", { className: "dsh-ledger-probe-detail" },
            [
              result.inputTokens !== undefined ? `输入 ${result.inputTokens} tok` : null,
              result.outputTokens !== undefined ? `输出 ${result.outputTokens} tok` : null,
              result.chars ? `摘要 ${result.chars} 字符` : null,
              result.reasoningEffort ? `reasoning ${result.reasoningEffort}` : null
            ].filter(Boolean).join(" · ")
          )
        : h("div", { className: "dsh-ledger-probe-detail" },
            (result.phase ? `[${result.phase}] ` : "") + (result.error || "未知错误")
          ),
      result.ok && result.preview
        ? h("div", { className: "dsh-ledger-probe-preview" }, result.preview)
        : null
    );
  };

  const modelPane = h("div", { className: "dsh-ledger-tabpane" },
    // The four combinations of these two controls are not four behaviours: with the
    // switch off, `mode` is never read, so "official-first" and "direct" do exactly
    // the same thing. Saying so in three places beats letting the user discover it:
    // the switch's hint branches on its own value first (it used to describe `mode`
    // even while off, which made the two rows contradict each other on screen), the
    // select is disabled while off, and its hint says the choice is inactive.
    toggle("shield", "启用自动压缩辅助",
      config?.enabled === false
        ? "关闭：自动压缩完全由官方摘要器处理，插件不介入。下面两项不生效，但手动压缩仍可用。"
        : config?.mode === "direct"
          ? "开启：自动压缩直接交给下方备用模型，官方摘要器不参与。"
          : `开启：自动压缩先由官方处理，连续失败 ${config?.rescueAfterFailures ?? 2} 次后交给备用模型 1，再失败才切备用模型 2。`,
      "enabled"),
    row("replace", "压缩方式",
      config?.enabled === false
        ? "辅助已关闭，此项不生效（自动压缩由官方处理）。"
        : config?.mode === "direct"
          ? "自动压缩直接用备用模型 1，失败后切备用模型 2。手动压缩按「压缩引擎」执行。"
          : `自动压缩先由官方处理，连续失败 ${config?.rescueAfterFailures ?? 2} 次后交给备用模型 1，再失败才切备用模型 2。`,
      h("select", {
        className: "dsh-ledger-select",
        value: config?.mode ?? "rescue",
        // Off means unread, so leaving it clickable would invite the user to "change"
        // a setting that has no effect.
        disabled: config?.enabled === false,
        onChange: (event) => patch({ mode: event.target.value })
      },
        h("option", { value: "rescue" }, "官方优先，失败后救援"),
        h("option", { value: "direct" }, "直接使用备用模型")
      )),
    // The rescue count belongs to `mode: rescue` only, so it sits directly under the
    // select that selects it rather than after the unrelated toggle below.
    config?.enabled !== false && config?.mode !== "direct"
      ? number("gauge", "救援前官方失败次数",
          `官方摘要器连续失败到这一次数，才交给备用模型 1。每次失败都是一次完整请求，调到 1 可以少花一次。`,
          "rescueAfterFailures", { min: 1, max: 5, step: 1, suffix: "次", fallback: 2 })
      : null,
    toggle("replace", "使能非模型压缩",
      "开启后 /compact、自动压缩、溢出恢复都走机械折页，不再调模型。这是唯一会让自动路径完全不花钱的开关，优先级高于上面两项。", "replaceDefault"),
    row("bolt", "备用模型 1",
      "真正负责压缩的模型。超长历史自动分块，保留近期消息和原始记录。",
      h("select", {
        className: "dsh-ledger-select dsh-ledger-select-wide",
        value: selected,
          "aria-label": "压缩模型",
        onChange: (event) => {
          const [provider, model] = event.target.value ? JSON.parse(event.target.value) : ["", ""];
          patch({ provider, model, reasoningEffort: "" });
        }
      },
        h("option", { value: "" }, "请选择模型"),
        models.map((model) => h("option", {
          key: JSON.stringify([model.provider, model.id]),
          value: JSON.stringify([model.provider, model.id])
        }, `${model.name} · ${model.provider}`))
      )),
    row("gauge", "备用模型 1 · Reasoning level", null,
      h("select", {
        className: "dsh-ledger-select",
        value: config?.reasoningEffort ?? "",
          onChange: (event) => patch({ reasoningEffort: event.target.value })
      },
        h("option", { value: "" }, "模型默认"),
        efforts.map((effort) => h("option", { key: effort.id, value: effort.id }, effort.name))
      )),

    // --- fallback model ----------------------------------------------------
    // Model 2 exists because a summarizer can fail for reasons the plugin cannot
    // control (rate limit, truncated output, provider outage). Retrying the same
    // model would hit the same wall, so the second attempt needs a different one.
    row("replace", "备用模型 2",
      config?.fallbackModel
        ? `备用模型 1 失败后自动改用 ${config.fallbackProvider}/${config.fallbackModel}。`
        : "留空表示不启用：备用模型 1 失败就按失败处理，不会换模型重试。",
      h("select", {
        className: "dsh-ledger-select dsh-ledger-select-wide",
        value: fallbackSelected,
          "aria-label": "备用压缩模型",
        onChange: (event) => {
          const [provider, model] = event.target.value ? JSON.parse(event.target.value) : ["", ""];
          patch({ fallbackProvider: provider, fallbackModel: model, fallbackReasoningEffort: "" });
        }
      },
        h("option", { value: "" }, "不启用备用模型"),
        models.map((model) => h("option", {
          key: JSON.stringify([model.provider, model.id]),
          value: JSON.stringify([model.provider, model.id])
        }, `${model.name} · ${model.provider}`))
      )),
    config?.fallbackModel
      ? row("gauge", "备用模型 2 · Reasoning level", null,
          h("select", {
            className: "dsh-ledger-select",
            value: config?.fallbackReasoningEffort ?? "",
                  onChange: (event) => patch({ fallbackReasoningEffort: event.target.value })
          },
            h("option", { value: "" }, "模型默认"),
            fallbackEfforts.map((effort) => h("option", { key: effort.id, value: effort.id }, effort.name))
          ))
      : null,

    // --- live probe --------------------------------------------------------
    // Resolving a model and listing its reasoning levels proves only that the
    // adapter knows about it. Whether it *answers* is a different question: credits,
    // revoked keys, rate limits, a model that rejects its own reasoning parameter,
    // or a summarizer that returns unusable prose all fail at request time. These
    // two buttons spend one real request to find out before a compaction needs it.
    h("div", { className: "dsh-ledger-probe" },
      h("div", { className: "dsh-ledger-probe-head" },
        h(SettingIcon, { name: "pulse", size: 13 }),
        h("span", { className: "dsh-ledger-probe-title" }, "连通性测试"),
        h("span", { className: "dsh-ledger-probe-note" }, "真实压缩请求；大档会花掉可观的 token")
      ),
      h("div", { className: "dsh-ledger-probe-controls" },
        h("label", { className: "dsh-ledger-probe-label" }, "测试长度"),
        h("select", {
          className: "dsh-ledger-select",
          value: probeSize,
          disabled: probing !== "",
          "aria-label": "测试长度",
          onChange: (event) => setProbeSize(event.target.value)
        },
          (sizes.length ? sizes : [{ id: "tiny", label: "极小（≈200 tok）" }]).map((size) =>
            h("option", { key: size.id, value: size.id }, size.label))
        )
      ),
      h("div", { className: "dsh-ledger-probe-buttons" },
        probeButton("1", "测试模型 1", config?.model ? `${config.provider}/${config.model}` : "未配置"),
        probeButton("2", "测试模型 2", config?.fallbackModel ? `${config.fallbackProvider}/${config.fallbackModel}` : "未配置")
      ),
      probeResult("1"),
      probeResult("2")
    ),
  );

  const ingressPane = h("div", { className: "dsh-ledger-tabpane" },
    toggle("ingress", "入境定形",
      "只裁当前回合紧邻上一步、还没发送的大 tool_result；已发送前缀逐字节不动。", "ingress"),
    toggle("image", "允许密图",
      "主模型 inputModalities 含 image，且图比原文更省时，才把头段渲染成点阵 PNG。", "snapImages"),
    number("gauge", "入境阈值", "超过这个量才摘录或贴图。", "minSnapTokens", { min: 200, max: 200000, step: 100, suffix: "tok", fallback: 3000 }),
    number("image", "传图像素预算",
      "必须与 llm-deepseek 的 imagePixelBudget 一致（默认 640000）。画大了会被请求管线缩小，细节就没了。",
      "imagePixelBudget", { min: 200000, max: 4000000, step: 10000, suffix: "px", fallback: 640000 }),
    number("percent", "密图节省", "摘录 + 估图 token ≤ 原文的这个比例，才贴 PNG。", "savingsRatio", { min: 5, max: 100, step: 1, suffix: "%", fallback: 85, scale: 100 }),
  );

  const foldPane = h("div", { className: "dsh-ledger-tabpane" },
    row("replace", "压缩引擎",
      "手动压缩和 /fast-compact 用哪个引擎。auto：配置了模型就用模型，否则机械折页；ledger：强制机械折页（不调模型）；saviour：交给压缩模型。",
      h("span", { className: "dsh-ledger-seg", role: "group" },
        [["auto", "自动"], ["ledger", "机械"], ["saviour", "模型"]].map(([value, text]) => h("button", {
          key: value,
          type: "button",
          className: "dsh-ledger-seg-btn",
          "data-active": (config?.engine ?? "auto") === value ? "1" : undefined,
          "aria-pressed": (config?.engine ?? "auto") === value,
          disabled: (config?.engine ?? "auto") === value,
          onClick: () => patch({ engine: value })
        }, text))
      )),
    toggle("shield", "折页二次确认", "「手动非模型压缩」要再点一次；关掉则单击立即折页。", "confirmFold"),
    h("div", { className: "dsh-ledger-preview" },
      h("div", { className: "dsh-ledger-preview-title" }, h(SettingIcon, { name: "list", size: 12 }), "折页卡示例 · 只留路径/意图/工具/命令/错误/摘录"),
      h(FoldCardPreview, { card: SAMPLE_CARD })
    ),
    h("p", { className: "dsh-ledger-muted" }, "命令：/fast-compact [ledger|saviour|auto] · /fast-compact status"),
  );

  const diagPane = h("div", { className: "dsh-ledger-tabpane" },
    h("div", { className: "dsh-ledger-diag-head" },
      h("button", { type: "button", className: "dsh-ledger-btn", disabled: healthBusy, onClick: loadHealth },
        h(SettingIcon, { name: "pulse", size: 13 }), healthBusy ? "读取中…" : "刷新"),
      health ? h("span", { className: "dsh-ledger-ver" }, "v" + health.version) : null
    ),
    healthError ? h("div", { className: "dsh-ledger-note", "data-error": true }, healthError) : null,
    health ? h(DiagGroups, { health }) : h("p", { className: "dsh-ledger-muted" }, "点“刷新”读取 Host 端计数：入境整形、两种压缩策略各自的次数。"),
    health && health.ingress.lastError
      ? h("div", { className: "dsh-ledger-note", "data-error": true }, "最近错误：" + health.ingress.lastError)
      : null
  );


  // ---------------------------------------------------------------------------
  // 触发线 tab
  // ---------------------------------------------------------------------------
  const triggerPane = h(TriggerPane, { config, patch, saving, preview, previewBusy, loadPreview, toggle, number });

  const panes = { model: modelPane, trigger: triggerPane, ingress: ingressPane, fold: foldPane, diag: diagPane };

  return h("div", { className: "dsh-ledger-root" },
    h("div", { className: "dsh-ledger-title" },
      h("span", { className: "dsh-ledger-title-icon", "aria-hidden": "true" }, h(FoldBoltIcon, { fill: 0.6 })),
      h("h2", null, "压缩管理"),
      health ? h("span", { className: "dsh-ledger-ver" }, "v" + health.version) : null
    ),
    h("p", { className: "dsh-ledger-muted" }, "独立模型压缩 + 本地机械折页。入境定形在工具结果进模型前定形，折页把旧历史换成短卡，两者都不改写已发送的前缀。"),
    h(TabBar, { tabs: [
      { id: "model", label: "模型", icon: "model" },
      { id: "trigger", label: "触发线", icon: "gauge" },
      { id: "ingress", label: "入境", icon: "ingress" },
      { id: "fold", label: "折页", icon: "fold" },
      { id: "diag", label: "诊断", icon: "pulse", badge: health && health.ingress.ok === false ? "!" : undefined }
    ], active: tab, onSelect: setTab }),
    panes[tab],
    message
      ? h("div", {
          className: "dsh-ledger-note",
          // A rejected write must not look like the "已自动保存" acknowledgement.
          "data-error": messageFailed ? true : undefined,
          role: "status"
        }, message)
      : null
  );
}

function TabBar({ tabs, active, onSelect }) {
  return h("div", { className: "dsh-ledger-tabs", role: "tablist" },
    tabs.map((tab) => h("button", {
      key: tab.id,
      type: "button",
      role: "tab",
      className: "dsh-ledger-tab",
      "data-active": tab.id === active ? "1" : undefined,
      "aria-selected": tab.id === active,
      onClick: () => onSelect(tab.id)
    },
      h(SettingIcon, { name: tab.icon, size: 14 }),
      h("span", null, tab.label),
      tab.badge ? h("span", { className: "dsh-ledger-tab-badge" }, tab.badge) : null
    ))
  );
}

/** Number field that keeps its own text while typing and commits on blur. */
function NumberField({ icon, label, hint, value, disabled, options, onCommit }) {
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    onCommit(parsed);
  };
  return h("div", { className: "dsh-ledger-row" },
    h("div", { className: "dsh-ledger-row-head" },
      h("span", { className: "dsh-ledger-row-icon", "aria-hidden": "true" }, h(SettingIcon, { name: icon })),
      h("label", { className: "dsh-ledger-row-label" }, label),
      h("span", { className: "dsh-ledger-num" },
        h("input", {
          type: "number",
          className: "dsh-ledger-input",
          value: text,
          disabled,
          min: options.min,
          max: options.max,
          step: options.step,
          inputMode: "numeric",
          onChange: (event) => setText(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === "Enter") event.currentTarget.blur(); }
        }),
        options.suffix ? h("span", { className: "dsh-ledger-suffix" }, options.suffix) : null
      )
    ),
    hint ? h("p", { className: "dsh-ledger-hint" }, hint) : null
  );
}

/**
 * The automatic-compaction trigger, with the resolved number on screen.
 *
 * Three settings decide when a compaction starts, and none of them is meaningful
 * alone — `0.8` means 80% on a million-token window and 25% on a 131K one, because
 * `headroomTokens` is absolute. So this pane does not just collect three numbers:
 * it shows the token count where compaction will actually fire, says which of the
 * two limits decided it, and explains what each field does in that context.
 *
 * The resolved value comes from the Host (`?threshold=1`) rather than from a local
 * copy of the formula, so what the page promises is what the engine enforces.
 */
function TriggerPane({ config, patch, saving, preview, previewBusy, loadPreview, toggle, number }) {
  const spec = preview?.spec;
  const known = spec?.known === true;
  const cappedByHeadroom = spec?.cappedBy === "headroom";
  const windowTokens = spec?.contextWindow || 0;
  const percent = known ? spec.thresholdPercent : 0;

  // The bar fills to the trigger, and the retained tail is drawn on top of it: the
  // relationship that matters is retain < threshold, and it is invisible as two
  // separate percentages.
  const retainShare = known && percent > 0 ? Math.min(100, (spec.retainTokens / Math.max(1, spec.thresholdTokens)) * 100) : 0;

  return h("div", { className: "dsh-ledger-tabpane" },
    h("p", { className: "dsh-ledger-muted" },
      "这三项决定自动压缩什么时候发生。改动即时生效并自动保存，下面的结果同步重算。"),

    toggle("pulse", "接管自动压缩阈值", 
      "开启：用本页的数值判断何时压缩（默认值与官方一致，所以不改也不会变）。关闭：完全沿用 compaction-basic 自带配置。",
      "thresholdOverride"),

    number("gauge", "触发线比例",
      "上下文用到窗口的这个比例就触发压缩。但 headroom 是绝对值，窗口较小时它会更早生效，实际触发点总以右侧算出的为准。",
      "thresholdRatio", { min: 10, max: 95, step: 1, suffix: "%", fallback: 80, scale: 100 }),

    number("percent", "预留空间 headroom",
      "必须空着不用的 token 数，留给系统提示词变动和下一轮增长。固定 65536 在 1M 窗口只占 6.5%，在 131K 窗口会占掉一半——小窗口提前压缩就是它造成的。",
      "headroomTokens", { min: 0, max: 400000, step: 1024, suffix: "tok", fallback: 65536 }),

    number("list", "保留原文 retain",
      "压缩后最近的这部分原文逐字保留，只压更早的。按消息预算（窗口 − 输出预留）算，不是按窗口。必须明显小于触发线，否则保留段会吞掉整个可压区域。",
      "retainRatio", { min: 2, max: 50, step: 1, suffix: "%", fallback: 16, scale: 100 }),

    h("div", { className: "dsh-ledger-result" },
      h("div", { className: "dsh-ledger-result-head" },
        h("span", { className: "dsh-ledger-result-title" },
          h(SettingIcon, { name: "pulse", size: 13 }), "算出的触发点"),
        previewBusy ? h("span", { className: "dsh-ledger-ver" }, "计算中…") : null
      ),

      preview?.error
        ? h("div", { className: "dsh-ledger-note", "data-error": true }, preview.error)
        : null,

      !config?.thresholdOverride && !preview?.error
        ? h("p", { className: "dsh-ledger-muted" },
            "接管开关已关闭，以下按本页数值试算；实际生效的是官方配置（默认 80% / 65536 / 16%）。")
        : null,

      known
        ? h("div", null,
            h("div", { className: "dsh-ledger-big" },
              h("span", { className: "dsh-ledger-big-num" }, formatTokens(spec.thresholdTokens)),
              h("span", { className: "dsh-ledger-big-unit" }, "tok"),
              h("span", { className: "dsh-ledger-big-pct" }, percent.toFixed(1) + "%")
            ),
            h("p", { className: "dsh-ledger-hint" },
              "窗口 " + formatTokens(windowTokens) + " tok · 输出预留 " + formatTokens(spec.reservedTokens)
              + " tok · 消息预算 " + formatTokens(spec.messageBudget) + " tok"),

            h("div", { className: "dsh-ledger-bar", title: `触发点 ${spec.thresholdTokens} tok` },
              h("div", { className: "dsh-ledger-bar-fill", style: { width: Math.min(100, percent) + "%" } },
                h("div", { className: "dsh-ledger-bar-retain", style: { width: retainShare + "%" } })
              )
            ),
            h("div", { className: "dsh-ledger-bar-legend" },
              h("span", null, h("i", { className: "dsh-ledger-swatch", "data-kind": "retain" }),
                "保留原文 " + formatTokens(spec.retainTokens) + " tok"),
              h("span", null, h("i", { className: "dsh-ledger-swatch", "data-kind": "foldable" }),
                "可压区域 " + formatTokens(Math.max(0, spec.thresholdTokens - spec.retainTokens)) + " tok")
            ),

            h("div", { className: "dsh-ledger-calc" },
              h("div", { className: "dsh-ledger-calc-row", "data-win": cappedByHeadroom ? undefined : "1" },
                h("code", null, "窗口 × " + (spec.thresholdRatio * 100).toFixed(0) + "%"),
                h("span", null, "= " + formatTokens(spec.byRatio) + " tok"),
                cappedByHeadroom ? null : h("em", null, "← 采用")
              ),
              h("div", { className: "dsh-ledger-calc-row", "data-win": cappedByHeadroom ? "1" : undefined },
                h("code", null, "消息预算 − headroom"),
                h("span", null, "= " + formatTokens(spec.byHeadroom) + " tok"),
                cappedByHeadroom ? h("em", null, "← 采用") : null
              ),
              h("div", { className: "dsh-ledger-calc-note" },
                cappedByHeadroom
                  ? "headroom 是绝对值，在这个窗口里它比触发线更紧，所以实际触发点被它压低到 "
                    + percent.toFixed(1) + "%。"
                  : "窗口足够大，headroom 让位于触发线比例，实际触发点就是 "
                    + (spec.thresholdRatio * 100).toFixed(0) + "%。")
            ),

            spec.retainClamped
              ? h("div", { className: "dsh-ledger-note", "data-error": true },
                  "保留比例 " + (spec.retainRatio * 100).toFixed(0) + "% 会让保留段达到或超过触发点，"
                  + "每次压缩都会找不到可安全压缩的区域。已自动下调为 " + formatTokens(spec.retainTokens) + " tok。")
              : null
          )
        : h("p", { className: "dsh-ledger-muted", "data-error": preview?.error ? undefined : true },
            preview?.error ? "" : spec?.reason === "no-window"
              ? "当前会话还没有路由过的模型，无法得到上下文窗口。先发一条消息，或先在别处选好模型。"
              : spec?.reason === "headroom-over-budget"
                ? "预留空间 " + formatTokens(spec.headroomTokens) + " 已吃满消息预算 " + formatTokens(spec.messageBudget) + " tok，永远不会压缩。请调小 headroom。"
                : spec?.reason === "reserved-over-window"
                  ? "输出预留 " + formatTokens(spec.reservedTokens) + " 已超过窗口 " + formatTokens(spec.contextWindow) + " tok。"
                  : "正在读取…"),

      preview?.model
        ? h("p", { className: "dsh-ledger-muted" }, "按当前模型计价：" + preview.model.provider + "/" + preview.model.model)
        : null
    ),

    h("p", { className: "dsh-ledger-muted" }, "命令：/fast-compact status 会打印当前生效的触发点。"),
  );
}


/**
 * Diagnostics, split the way the plugin actually works: the model path and the
 * non-model path.
 *
 * Every earlier attempt grouped by subsystem (ingress vs compaction) and ended up
 * mixing the two strategies inside one group, which left the pane unable to answer
 * the only question that matters — "did the model ever run, and how much did each
 * strategy save?". The two groups below are disjoint: nothing under 非模型压缩
 * spends tokens, nothing under 模型压缩 avoids spending them.
 *
 * Every cell carries a `title`. These numbers are cumulative and shared by every
 * session in the process, so a bare "0" that is really "no need yet" is
 * indistinguishable from "broken" without a hint.
 */
function DiagGroups({ health }) {
  const shaping = health.shaping ?? health.ingress ?? {};
  const model = health.compaction?.model ?? {};
  const mechanical = health.compaction?.mechanical ?? {};
  const idle = (shaping.shaped ?? 0) === 0 && (shaping.failures ?? 0) === 0;
  const lastRun = model.lastBefore || model.lastAfter
    ? `${formatTokens(model.lastBefore)} → ${formatTokens(model.lastAfter)} tok`
    : "尚未运行";

  // The model that answered the most recent run, plus when. Rendered as a full-width
  // row rather than a cell because a provider/model pair plus a timestamp does not fit
  // in a half-width column without truncation — and a truncated model name is exactly
  // the thing this row exists to show.
  const last = model.last ?? {};
  const lastModelLabel = last.provider && last.model
    ? `${last.provider}/${last.model}` + (last.reasoningEffort ? ` · ${last.reasoningEffort}` : "")
    : "尚未运行";
  const lastModelNote = last.at
    ? new Date(last.at).toLocaleString()
    : "";

  return h("div", { className: "dsh-ledger-diag-groups" },
    h("div", { className: "dsh-ledger-diag-group", "data-kind": "model" },
      h(DiagGroupHead, { title: "模型压缩", note: "调压缩模型生成摘要，会花 token" }),
      h("div", { className: "dsh-ledger-grid" },
        h(DiagCell, {
          label: "压缩次数",
          value: String(model.compactions ?? 0),
          title: "用独立压缩模型生成摘要的次数。自动压力触发和手动按钮都算在内。"
        }),
        h(DiagCell, {
          label: "失败",
          value: String(model.failures ?? 0),
          bad: (model.failures ?? 0) > 0,
          title: "模型压缩真正报错的次数。用户主动取消不计入。"
        }),
        h(DiagCell, {
          label: "共省",
          value: formatTokens(model.savedTokens) + " tok",
          title: "累计省下的 token：每次压缩前后请求估算之差求和。"
        }),
        h(DiagCell, {
          label: "最近一次",
          value: lastRun,
          title: "最近一次成功的模型压缩：压缩前估算 → 压缩后估算。"
        })
      ),
      // Full-width: the model identity is the answer to "which one actually ran",
      // and a fallback needs to name both models, which does not fit half a row.
      h("div", { className: "dsh-ledger-last-model", "data-fellback": last.fellBack ? "1" : undefined },
        h("span", { className: "dsh-ledger-last-model-key" }, "上次用的模型"),
        h("span", { className: "dsh-ledger-last-model-val", title: lastModelLabel }, lastModelLabel),
        lastModelNote ? h("span", { className: "dsh-ledger-last-model-at" }, lastModelNote) : null,
        last.fellBack && last.failedModel
          ? h("span", { className: "dsh-ledger-last-model-note" },
              `模型 1（${last.failedProvider}/${last.failedModel}）失败，已用备用模型`)
          : null
      )
    ),
    h("div", { className: "dsh-ledger-diag-group", "data-kind": "mechanical" },
      h(DiagGroupHead, { title: "非模型压缩", note: "本地改写，不调模型、不花 token" }),
      h("div", { className: "dsh-ledger-grid" },
        h(DiagCell, {
          label: "手动折页",
          value: String(mechanical.manual ?? 0),
          title: "你点「手动非模型压缩」的次数，或 /fast-compact ledger。把旧历史换成短卡。"
        }),
        h(DiagCell, {
          label: "接管折页",
          value: String(mechanical.replaced ?? 0),
          title: "「使能非模型压缩」开关生效、把本该调模型的自动路径改成折页的次数。大于 0 说明该开关在工作。"
        }),
        h(DiagCell, {
          label: "钩住引擎",
          value: String(mechanical.live ?? 0),
          title: "当前存活、已被本插件包装的 compaction-basic 实例数。每个 agent 预设/scope 一个，数量变化正常。"
        }),
        h(DiagCell, {
          label: "已定形",
          value: String(shaping.shaped ?? 0),
          title: "累计改写了多少个工具结果。只处理「上一步刚产生、还没被任何请求发送过」的结果；超 minSnapTokens 才动手。"
        }),
        h(DiagCell, {
          label: "其中贴图",
          value: String(shaping.snapped ?? 0),
          title: "已定形里有多少个转成了密排 PNG。「允许密图」关闭时恒为 0。"
        }),
        h(DiagCell, {
          label: "定形共省",
          value: formatTokens(shaping.savedTokens) + " tok",
          title: "入境整形累计省下的估算 token：原文估算减去改写后估算。"
        }),
        h(DiagCell, {
          label: "定形失败",
          value: String(shaping.failures ?? 0),
          bad: (shaping.failures ?? 0) > 0,
          title: "入境改写被会话拒绝的次数（surface op 格式不符、append 失败等）。一次 pass 遇到第一个错误就停。"
        }),
        h(DiagCell, {
          label: "状态",
          value: shaping.ok === false ? "失败" : idle ? "待命" : "正常",
          bad: shaping.ok === false,
          title: "待命＝还没遇到需要处理的块；正常＝处理过；失败＝最近一次出错。"
        }),
        h(DiagCell, {
          label: "会话 API",
          value: health.sessionApi === "eventAt" ? "eventAt" : health.sessionApi === "events" ? "events(旧)" : "未采样",
          bad: health.sessionApi === "events",
          title: "宿主提供的会话读接口。eventAt 是新接口；events（旧）说明版本不匹配，入境整形会退化。"
        })
      )
    ),
    h("p", { className: "dsh-ledger-muted" }, "以上都是本进程内的累计计数，宿主重启后归零；不分会话。")
  );
}


function DiagGroupHead({ title, note }) {
  return h("div", { className: "dsh-ledger-diag-group-head" },
    h("span", { className: "dsh-ledger-diag-group-title" }, title),
    note ? h("span", { className: "dsh-ledger-diag-group-note", title: note }, note) : null
  );
}

function DiagCell({ label, value, bad, title }) {
  return h("div", { className: "dsh-ledger-cell", "data-bad": bad ? "1" : undefined, title: title || undefined },
    h("span", { className: "dsh-ledger-cell-key" }, label),
    h("span", { className: "dsh-ledger-cell-val", title: title || String(value) }, value)
  );
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1000) return (number / 1000).toFixed(number >= 10000 ? 0 : 1) + "k";
  return String(Math.round(number));
}

/**
 * Elapsed time, in the unit that reads best.
 *
 * Sub-second results are the common case for a small probe, and "0.4s" is far more
 * informative there than "400ms" is at ten seconds — so the unit follows the
 * magnitude rather than being fixed.
 */
function formatMs(value) {
  const ms = Math.max(0, Number(value) || 0);
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + " s";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return minutes + " 分 " + seconds + " 秒";
}

/** A frozen fold card, so the fold tab shows the shape before anything is folded. */
const SAMPLE_CARD = {
  items: 128,
  tokens: 42350,
  edits: ["lib/client.js"],
  reads: ["lib/ingress.js", "lib/fold.js"],
  intents: ["把两个压缩插件合成一个", "输入栏加非模型压缩按钮"],
  tools: [{ name: "read", n: 12 }, { name: "edit", n: 6 }],
  commands: ["node --test lib/ledger.test.js -> 0"],
  errors: [],
  excerpt: ["[user] 合并 saviour 和 ledger", "[tool] read lib/controller.js"]
};

function FoldCardPreview({ card }) {
  const files = [...(card.edits ?? []).map((path) => ({ path, kind: "改" })), ...(card.reads ?? []).map((path) => ({ path, kind: "读" }))];
  const meta = [`${card.items} 条`, `${formatTokens(card.tokens)} tok`];
  if (card.edits?.length) meta.push(`${card.edits.length} 改`);
  if (card.reads?.length) meta.push(`${card.reads.length} 读`);
  const lines = [];
  for (const intent of (card.intents ?? []).slice(0, 2)) lines.push(h(Tick, { key: "i" + intent, text: intent }));
  if (files.length) {
    lines.push(h(Tick, {
      key: "files",
      text: null,
      children: h("span", { className: "dsh-ledger-files" }, files.slice(0, 6).map((file, index) =>
        h("span", { className: "dsh-ledger-file", key: index, title: file.path },
          h("span", { className: "dsh-ledger-file-path" }, shortPath(file.path)),
          h("span", { className: "dsh-ledger-file-kind" }, file.kind))), files.length > 6 ? h("span", { className: "dsh-ledger-more" }, `+${files.length - 6}`) : null)
    }));
  }
  for (const command of (card.commands ?? []).slice(0, 2)) {
    lines.push(h(Tick, { key: "c" + command, text: command }));
  }
  return h(React.Fragment, null,
    h("div", { className: "dsh-ledger-meta" }, meta.join(" · ")),
    h("div", { className: "dsh-ledger-rail" }, lines)
  );
}

function Tick({ text, children, title }) {
  return h("div", { className: "dsh-ledger-tick", "data-kind": children ? "files" : "intent", title: title || (text ?? undefined) },
    h("span", { className: "dsh-ledger-dot", "aria-hidden": "true" }, h("svg", { viewBox: "0 0 8 8", width: 7, height: 7 },
      h("circle", { cx: 4, cy: 4, r: 2.25, fill: "currentColor" }))),
    h("div", { className: "dsh-ledger-tick-body" }, children ?? text)
  );
}

function shortPath(path) {
  const parts = String(path || "").split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

const ICON_PATHS = {
  ingress: ["M12 3v9", "m8 8 4 4 4-4", "M5 16v2a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2"],
  image: ["M4 5h16v14H4z", "m5 16 4-5 3 4 2-2 4 3"],
  gauge: ["M5 17a8 8 0 1 1 14 0", "m12 17 4-5"],
  percent: ["M7 7h.01M17 17h.01", "M17 7 7 17"],
  fold: ["M5 4h9l5 5v11H5z", "M14 4v5h5"],
  replace: ["M4 8h12l-3-3", "M20 16H8l3 3"],
  shield: ["M12 4l7 3v5c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7z", "m9 12 2 2 4-4"],
  pulse: ["M3 12h4l2-5 3 10 2-5h7"],
  list: ["M4 7h16M4 12h16M4 17h10"],
  model: ["M12 3l7 4v10l-7 4-7-4V7z", "M12 12l7-4", "M12 12v9", "M12 12 5 8"],
  bolt: ["M13 2 4 14h7l-1 8 10-12h-7l1-8z"]
};

function SettingIcon({ name, size }) {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.pulse;
  return h("svg", {
    viewBox: "0 0 24 24",
    width: size || 15,
    height: size || 15,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true"
  }, paths.map((d, index) => h("path", { key: index, d })));
}

/**
 * Error boundary for the settings page.
 *
 * Without one, a render-time throw unmounts the whole settings dialog — the user
 * sees a blank page and no explanation. Catching it here keeps the rest of the
 * dialog alive and prints the message, which is also the only way to read such a
 * failure back from a shipped desktop build.
 */
class SectionBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[dsh-compact-manager] settings page crashed:", error, info);
  }
  render() {
    const error = this.state.error;
    if (error) {
      return h("div", { className: "dsh-ledger-root" },
        h("div", { className: "dsh-ledger-title" },
          h("span", { className: "dsh-ledger-title-icon", "aria-hidden": "true" }, h(FoldBoltIcon, { fill: 0.5 })),
          h("h2", null, "压缩管理")),
        h("p", { className: "dsh-ledger-muted" }, "这个页面渲染时出错了。下面的信息可以直接交给开发者。"),
        h("div", { className: "dsh-ledger-note", "data-error": true }, String(error?.message ?? error)),
        h("div", { className: "dsh-ledger-note" }, String(error?.stack ?? "")),
        h("button", { type: "button", className: "dsh-ledger-btn", onClick: () => this.setState({ error: null }) }, "重试")
      );
    }
    return this.props.children ?? null;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const inject = ["slots"];
const name = PACKAGE + "-client";

function apply(ctx) {
  // One owned <style> element, keyed by plugin so a reload replaces it instead of
  // stacking a second copy, and removed when this fiber unloads.
  ctx.effect(() => {
    const id = PACKAGE + "/style.css";
    let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(id) + "]");
    if (tag === null) {
      tag = document.createElement("style");
      tag.dataset.plugin = PACKAGE;
      tag.dataset.pluginCss = id;
      document.head.appendChild(tag);
    }
    tag.textContent = CSS;
    return () => { tag.remove(); };
  }, PACKAGE + ": css");

  ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
    name: "conversation.input.right",
    id: "compact-manager-popup-anchor",
    order: 100,
    inject: (sessionId) => ({ sessionId })
  }, PopupBridge));

  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "compact-manager",
    order: 18,
    label: () => "压缩管理"
  }, () => h(SectionBoundary, null, h(SettingsPanel))));
}

exports.PopupBridge = PopupBridge;
exports.CompactFooter = CompactFooter;
exports.SettingsPanel = SettingsPanel;
exports.DiagGroups = DiagGroups;
exports.DiagCell = DiagCell;
exports.TriggerPane = TriggerPane;
exports.FoldBoltIcon = FoldBoltIcon;
exports.apply = apply;
exports.inject = inject;
exports.name = name;
