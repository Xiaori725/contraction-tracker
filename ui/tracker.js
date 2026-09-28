// The frontend owns click timestamps and a durable outbox. Python owns authentication
// and all Supabase access. A transport send is never treated as a database receipt.
const instances = new WeakMap();
const LEVELS = ["轻", "中", "强"];
const EMPTY = { records: [], active: null, next: null, server_now: 0 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PENDING = 500;

export function validChange(op) {
  if (!op || typeof op !== "object" || !UUID.test(op.id || "") || !UUID.test(op.operation_id || "")) return false;
  if (!["start", "finish", "strength", "edit", "delete"].includes(op.action)) return false;
  if (op.action !== "start" && (!Number.isSafeInteger(op.version) || op.version < 1)) return false;
  if (op.intensity !== undefined && op.intensity !== null && ![1, 2, 3].includes(op.intensity)) return false;
  const timestamp = v => Number.isSafeInteger(v) && v >= 946684800000 && v <= 8640000000000000;
  if (["start", "edit"].includes(op.action) && !timestamp(op.start_ms)) return false;
  if (["finish", "edit"].includes(op.action) && !timestamp(op.end_ms)) return false;
  if (op.action === "edit" && op.end_ms < op.start_ms) return false;
  return op.action !== "strength" || [1, 2, 3].includes(op.intensity);
}

export function acknowledge(events, ids) {
  const accepted = new Set(Array.isArray(ids) ? ids : []);
  return events.filter(event => !accepted.has(event.operation_id));
}

export function optimistic(snapshot, events) {
  let records = (snapshot?.records || []).filter(r => r.end_ms !== null).map(r => ({ ...r }));
  let active = snapshot?.active ? { ...snapshot.active } : null;
  for (const op of events) {
    const record = active?.id === op.id ? active : records.find(r => r.id === op.id);
    const targetVersion = (op.version || 0) + 1;
    if (op.action === "start") {
      // Preserve this device's unsynced timer if another device has started one.
      // The conflicting outbox remains visible until the user chooses a version.
      if (!record) active = { id: op.id, start_ms: op.start_ms, end_ms: null, intensity: op.intensity ?? null, version: 1 };
    } else if (op.action === "finish") {
      if (record && (record.end_ms === null || record.version < targetVersion)) {
        const finished = { ...record, end_ms: op.end_ms, intensity: op.intensity ?? null, version: targetVersion };
        records = [finished, ...records.filter(r => r.id !== op.id)];
      }
      if (active?.id === op.id) active = null;
    } else if (op.action === "strength") {
      if (active?.id === op.id && active.version < targetVersion) active = { ...active, intensity: op.intensity, version: targetVersion };
    } else if (op.action === "edit") {
      records = records.map(r => r.id === op.id && r.version < targetVersion
        ? { ...r, start_ms: op.start_ms, end_ms: op.end_ms, intensity: op.intensity ?? null, version: targetVersion }
        : r);
    } else if (op.action === "delete") {
      records = records.filter(r => r.id !== op.id);
      if (active?.id === op.id) active = null;
    }
  }
  records.sort((a, b) => b.start_ms - a.start_ms || b.id.localeCompare(a.id));
  records = records.map((r, index) => index + 1 < records.length
    ? { ...r, previous_start: records[index + 1].start_ms, previous_end: records[index + 1].end_ms }
    : r);
  return { ...(snapshot || EMPTY), records, active };
}

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

export function clockTime(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function localInput(ms) {
  const date = new Date(ms);
  const local = new Date(ms - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 19);
}

function setText(node, text) { if (node.textContent !== String(text)) node.textContent = String(text); }
function show(node, visible) { node.classList.toggle("hidden", !visible); }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function timeLabel(ms) { return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }

function storageKey(data) {
  return `yike-outbox-v2:${encodeURIComponent(data.space_id)}:${encodeURIComponent(data.user_id)}`;
}

function persist(ctx) {
  try {
    if (ctx.queue.length) {
      localStorage.setItem(ctx.storageKey, JSON.stringify({ v: 1, user_id: ctx.data.user_id, space_id: ctx.data.space_id, events: ctx.queue }));
    } else localStorage.removeItem(ctx.storageKey);
    ctx.storageError = "";
  } catch {
    ctx.storageError = "浏览器无法暂存本次操作，请保持页面打开，直到云端确认保存。";
  }
}

function readQueue(ctx) {
  try {
    const raw = localStorage.getItem(ctx.storageKey);
    if (!raw) return;
    if (raw.length > 600000) throw new Error("Invalid outbox size");
    const saved = JSON.parse(raw);
    if (saved?.v !== 1 || saved.user_id !== ctx.data.user_id || saved.space_id !== ctx.data.space_id
      || !Array.isArray(saved.events) || saved.events.length > MAX_PENDING || !saved.events.every(validChange)) {
      ctx.corrupt = true;
      ctx.localError = "本机暂存内容无法读取。请核对云端记录后，再选择采用云端版本。";
      return;
    }
    ctx.queue = saved.events;
  } catch {
    ctx.corrupt = true;
    ctx.localError = "本机暂存内容无法读取。请核对云端记录后，再选择采用云端版本。";
  }
}

function sendQueue(ctx, force = false, allowEmpty = false) {
  if (ctx.destroyed || !ctx.data.loaded || (!ctx.queue.length && !allowEmpty)) return;
  if (!allowEmpty && (ctx.data.conflict || navigator.onLine === false || ctx.corrupt)) return;
  const now = Date.now();
  if (!force && now - ctx.lastSend < 4500) return;
  ctx.lastSend = now;
  try {
    ctx.bridge.setStateValue("pending", { attempt: ++ctx.attempt, total: ctx.queue.length, events: ctx.queue.slice(0, 20).map(op => ({ ...op })) });
  } catch {
    // Outbox remains saved even if the WebSocket transport rejects the event.
    ctx.transportError = "连接中断，操作尚未同步。恢复连接后会重试。";
  }
}

function action(ctx, type) {
  try { ctx.bridge.setTriggerValue("action", { type }); }
  catch { ctx.transportError = "暂时无法连接云端，请稍后重试。"; paint(ctx); }
}

function enqueue(ctx, op) {
  if (!validChange(op)) { ctx.localError = "记录内容无效，请检查后重试。"; paint(ctx); return false; }
  if (ctx.queue.length >= MAX_PENDING) { ctx.localError = "本机待同步操作较多，请先完成同步。"; paint(ctx); return false; }
  ctx.queue.push(op);
  ctx.localError = "";
  persist(ctx); // Write before the WebSocket message can leave the browser.
  paint(ctx);
  sendQueue(ctx, true);
  return true;
}

function updateStrengths(container, value, attribute) {
  for (const button of container.querySelectorAll(`[${attribute}]`)) {
    button.setAttribute("aria-pressed", String(Number(button.getAttribute(attribute)) === value));
  }
}

function createRecordNode(ctx, record) {
  const article = element("article", "record");
  const top = element("div", "record-top"), timeGroup = element("div");
  const time = element("time", "record-time"), day = element("span", "record-day"), strength = element("span", "record-strength");
  timeGroup.append(time, day); top.append(timeGroup, strength);
  const grid = element("dl", "record-grid"), durationGroup = element("div"), intervalGroup = element("div");
  const durationValue = element("dd"), intervalValue = element("dd");
  durationGroup.append(element("dt", "", "持续时长"), durationValue);
  intervalGroup.append(element("dt", "", "开始间隔"), intervalValue); grid.append(durationGroup, intervalGroup);
  const bottom = element("div", "record-bottom"), rest = element("span"), edit = element("button", "record-edit", "修改记录");
  edit.type = "button";
  edit.addEventListener("click", () => {
    const current = ctx.view.records.find(r => r.id === article.dataset.id);
    if (current) openEdit(ctx, current);
  });
  bottom.append(rest, edit); article.append(top, grid, bottom); article.dataset.id = record.id;
  return { article, time, day, strength, durationValue, intervalValue, rest, edit };
}

function paintRecords(ctx) {
  const visible = ctx.view.records.slice(0, ctx.visible);
  const ids = new Set(visible.map(r => r.id));
  for (const [id, nodes] of ctx.recordNodes) if (!ids.has(id)) { nodes.article.remove(); ctx.recordNodes.delete(id); }
  let prior = null;
  for (const record of visible) {
    let nodes = ctx.recordNodes.get(record.id);
    if (!nodes) { nodes = createRecordNode(ctx, record); ctx.recordNodes.set(record.id, nodes); }
    const expected = prior ? prior.nextSibling : ctx.el.records.firstChild;
    if (expected !== nodes.article) ctx.el.records.insertBefore(nodes.article, expected);
    prior = nodes.article;
    setText(nodes.time, timeLabel(record.start_ms)); nodes.time.dateTime = new Date(record.start_ms).toISOString();
    setText(nodes.day, new Date(record.start_ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }));
    setText(nodes.strength, record.intensity ? `强度 · ${LEVELS[record.intensity - 1]}` : "强度未记录");
    setText(nodes.durationValue, duration(record.end_ms - record.start_ms));
    setText(nodes.intervalValue, record.previous_start != null ? duration(record.start_ms - record.previous_start) : (ctx.view.next ? "待载入更早记录" : "首次记录"));
    setText(nodes.rest, record.previous_end != null ? `此前休息 ${duration(record.start_ms - record.previous_end)}` : "从这一刻开始记录");
    nodes.edit.disabled = !!ctx.queue.length || !!ctx.data.conflict;
  }
  show(ctx.el.empty, !visible.length);
  setText(ctx.el["empty-title"], ctx.data.loaded ? "从第一次宫缩开始" : "正在读取记录");
  show(ctx.buttons["load-more"], ctx.visible < ctx.view.records.length || !!ctx.view.next);
  ctx.buttons["load-more"].disabled = !ctx.data.loaded;
}

function frozenDuration(ctx) {
  const finish = [...ctx.queue].reverse().find(op => op.action === "finish");
  const finished = finish && ctx.view.records.find(r => r.id === finish.id);
  if (finished) return { duration: finished.end_ms - finished.start_ms, pending: true };
  return ctx.lastFinished ? { duration: ctx.lastFinished.end_ms - ctx.lastFinished.start_ms, pending: false } : null;
}

function tick(ctx) {
  if (ctx.destroyed) return;
  const now = Date.now(), active = ctx.view.active, last = ctx.view.records[0], frozen = frozenDuration(ctx);
  const elapsed = active ? Math.max(0, now - active.start_ms) : frozen ? frozen.duration : 0;
  setText(ctx.el.digits, clockTime(elapsed));
  ctx.el.digits.setAttribute("aria-label", `本次持续 ${duration(elapsed)}`);
  show(ctx.el["rest-panel"], !!last);
  if (last) {
    setText(ctx.el["interval-label"], active ? "本次开始间隔" : "距上次开始");
    setText(ctx.el["rest-label"], active ? "本次前的休息时长" : "上次结束后已休息");
    setText(ctx.el.interval, duration((active ? active.start_ms : now) - last.start_ms));
    setText(ctx.el.rest, duration((active ? active.start_ms : now) - last.end_ms));
  }
}

function paint(ctx) {
  if (ctx.destroyed) return;
  ctx.view = optimistic(ctx.data.snapshot || EMPTY, ctx.queue);
  const active = ctx.view.active, frozen = frozenDuration(ctx);
  if (active) ctx.strength = active.intensity ?? null;
  const notice = [ctx.localError, ctx.storageError, ctx.transportError, ctx.data.sync_error].filter(Boolean).join(" ");
  const conflictText = ctx.data.conflict ? "本机操作与云端记录有冲突。待同步操作已保留，请核对后选择采用云端版本，或重试同步。" : "";
  show(ctx.el.notice, !!(notice || conflictText));
  setText(ctx.el["notice-text"], notice || conflictText);
  show(ctx.buttons.discard, !!(ctx.queue.length || ctx.corrupt));
  show(ctx.el["clock-warning"], ctx.clockSkew);
  ctx.el.dial.classList.toggle("active", !!active);
  ctx.el.dial.classList.toggle("frozen", !active && !!frozen);
  setText(ctx.el["timer-status"], active ? "宫缩进行中" : frozen?.pending ? "本次已结束，等待同步" : frozen ? "本次已记录" : "准备记录");
  setText(ctx.el["toggle-label"], active ? "结束宫缩" : "开始宫缩");
  setText(ctx.el["timer-symbol"], active ? "■" : "▶");
  setText(ctx.el["timer-hint"], active ? "结束时点击，时长会自动保存" : ctx.queue.length ? "操作待同步，请保持页面打开" : "宫缩开始时点击，结束时再点一次");
  ctx.buttons.toggle.classList.toggle("stop", !!active);
  ctx.buttons.toggle.disabled = ctx.corrupt || (!active && (!ctx.data.loaded || !!ctx.queue.length || !!ctx.data.conflict));
  updateStrengths(ctx.root, ctx.strength, "data-strength");
  for (const button of ctx.root.querySelectorAll("[data-strength]")) button.disabled = ctx.corrupt || (!ctx.data.loaded && !active) || !!ctx.data.conflict;
  show(ctx.buttons["cancel-active"], !!active);
  ctx.buttons["cancel-active"].disabled = !!ctx.data.conflict;
  const offline = navigator.onLine === false;
  const pending = ctx.queue.length;
  let status = "正在读取云端记录";
  if (pending) status = `${pending} 项操作待同步 · ${ctx.storageError ? "暂存失败，请勿关闭页面" : "本机已暂存"}${offline ? " · 当前离线" : ""}`;
  else if (ctx.data.conflict || notice) status = "请先处理上方提示";
  else if (offline) status = "当前离线 · 显示最近同步的记录";
  else if (ctx.data.loaded) status = ctx.lastServerTime ? `最近同步 ${timeLabel(ctx.lastServerTime)}` : "云端记录已载入";
  setText(ctx.el["sync-status"], status);
  ctx.el["sync-status"].classList.toggle("pending", !!pending || offline);
  paintRecords(ctx);
  tick(ctx);
}

function openEdit(ctx, record) {
  if (ctx.queue.length || ctx.data.conflict) return;
  ctx.editing = { ...record };
  ctx.editStrength = record.intensity ?? null;
  ctx.el["edit-start"].value = localInput(record.start_ms);
  ctx.el["edit-end"].value = localInput(record.end_ms);
  ctx.el["edit-error"].textContent = "";
  show(ctx.el["edit-error"], false);
  updateStrengths(ctx.el["edit-dialog"], ctx.editStrength, "data-edit-strength");
  ctx.el["edit-dialog"].showModal();
}

function closeEdit(ctx) { ctx.el["edit-dialog"].close(); ctx.editing = null; }

function confirm(ctx, kind, payload) {
  ctx.confirming = { kind, payload };
  const texts = {
    discard: ["采用云端版本？", "这会放弃本设备尚未同步的操作，并重新读取云端记录。云端已经保存的记录会保留。", "确认采用云端版本"],
    cancel: ["取消本次计时？", "取消后，本次宫缩不会保留在记录中。操作会同步到另一台设备。", "取消本次计时"],
    delete: ["删除这条记录？", "此操作会同步到另一台设备，删除后无法在页面中恢复。", "确认删除"],
    edit: ["保存这次修改？", "修改后的时间和强度会同步给另一个邮箱。", "确认保存"]
  };
  const [title, text, label] = texts[kind];
  setText(ctx.el["confirm-title"], title); setText(ctx.el["confirm-text"], text); setText(ctx.el["confirm-button"], label);
  ctx.el["confirm-dialog"].showModal();
}

function saveEdit(ctx, event) {
  event.preventDefault();
  if (!ctx.editing) return;
  const record = ctx.editing;
  // Preserve original millisecond precision when only the intensity was edited.
  const start = ctx.el["edit-start"].value === localInput(record.start_ms) ? record.start_ms : new Date(ctx.el["edit-start"].value).getTime();
  const end = ctx.el["edit-end"].value === localInput(record.end_ms) ? record.end_ms : new Date(ctx.el["edit-end"].value).getTime();
  let error = "";
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 946684800000 || end < start || end > Date.now() + 300000) error = "请检查时间：结束不能早于开始，也不能在未来。";
  const others = [...ctx.view.records, ...(ctx.view.active ? [ctx.view.active] : [])].filter(r => r.id !== record.id);
  if (!error && others.some(r => start < (r.end_ms ?? Infinity) && end > r.start_ms)) error = "修改后的时间与另一条宫缩记录重叠，请检查。";
  if (error) { setText(ctx.el["edit-error"], error); show(ctx.el["edit-error"], true); return; }
  confirm(ctx, "edit", { action: "edit", id: record.id, operation_id: crypto.randomUUID(), version: record.version, start_ms: start, end_ms: end, intensity: ctx.editStrength });
}

function toggle(ctx) {
  const now = Date.now();
  if (now - ctx.lastTap < 800 || ctx.buttons.toggle.disabled) return;
  ctx.lastTap = now;
  const active = ctx.view.active;
  if (active) {
    if (now < active.start_ms) { ctx.localError = "设备时间早于开始时间，请校准时钟后结束计时。"; paint(ctx); return; }
    const op = { action: "finish", id: active.id, operation_id: crypto.randomUUID(), version: active.version, end_ms: now, intensity: ctx.strength };
    if (enqueue(ctx, op)) { ctx.lastFinished = { ...active, end_ms: now }; ctx.strength = null; paint(ctx); }
  } else {
    const last = ctx.view.records[0];
    if (last && now < last.end_ms) { ctx.localError = "设备时间早于上次结束时间，请先检查手机时间。"; paint(ctx); return; }
    const op = { action: "start", id: crypto.randomUUID(), operation_id: crypto.randomUUID(), start_ms: now, intensity: ctx.strength };
    ctx.lastFinished = null;
    enqueue(ctx, op);
  }
}

function acceptConfirmation(ctx) {
  const pending = ctx.confirming;
  if (!pending) return;
  ctx.confirming = null;
  ctx.el["confirm-dialog"].close();
  if (pending.kind === "discard") {
    ctx.queue = []; ctx.corrupt = false; ctx.localError = ""; ctx.transportError = ""; ctx.lastFinished = null; ctx.strength = null;
    persist(ctx);
    sendQueue(ctx, true, true);
    action(ctx, "refresh");
  } else if (pending.kind === "edit") {
    if (enqueue(ctx, pending.payload)) closeEdit(ctx);
  } else {
    const target = pending.payload;
    if (target && enqueue(ctx, { action: "delete", id: target.id, operation_id: crypto.randomUUID(), version: target.version })) {
      if (pending.kind === "delete") closeEdit(ctx);
      ctx.lastFinished = null;
    }
  }
  paint(ctx);
}

function handleClick(ctx, event) {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.hasAttribute("data-strength")) {
    const value = Number(button.getAttribute("data-strength"));
    if (ctx.strength === value) return;
    ctx.strength = value;
    const active = ctx.view.active;
    if (active) enqueue(ctx, { action: "strength", id: active.id, operation_id: crypto.randomUUID(), version: active.version, intensity: value });
    else paint(ctx);
    return;
  }
  if (button.hasAttribute("data-edit-strength")) {
    ctx.editStrength = Number(button.getAttribute("data-edit-strength"));
    updateStrengths(ctx.el["edit-dialog"], ctx.editStrength, "data-edit-strength");
    return;
  }
  switch (button.dataset.action) {
    case "toggle": toggle(ctx); break;
    case "cancel-active": if (ctx.view.active) confirm(ctx, "cancel", { ...ctx.view.active }); break;
    case "refresh":
    case "retry": ctx.transportError = ""; sendQueue(ctx, true); action(ctx, "refresh"); paint(ctx); break;
    case "load-more":
      ctx.visible += 10;
      if (ctx.visible > ctx.view.records.length && ctx.view.next) action(ctx, "load_more");
      paint(ctx); break;
    case "discard": confirm(ctx, "discard"); break;
    case "delete-record": if (ctx.editing) confirm(ctx, "delete", { ...ctx.editing }); break;
    case "close-edit": closeEdit(ctx); break;
    case "close-confirm": ctx.confirming = null; ctx.el["confirm-dialog"].close(); break;
    case "confirm": acceptConfirmation(ctx); break;
  }
}

function createInstance(parentElement, args) {
  const root = parentElement.querySelector(".tracker-shell");
  if (!root) throw new Error("The tracker component markup is missing.");
  const ctx = {
    root, data: args.data || {}, bridge: args, el: {}, buttons: {}, queue: [], view: EMPTY,
    recordNodes: new Map(), visible: 10, strength: null, editing: null, editStrength: null,
    confirming: null, lastFinished: null, lastTap: 0, lastSend: 0, attempt: Date.now(),
    localError: "", transportError: "", storageError: "", corrupt: false, clockSkew: false,
    lastServerTime: 0, destroyed: false
  };
  for (const node of root.querySelectorAll("[data-role]")) ctx.el[node.dataset.role] = node;
  for (const node of root.querySelectorAll("[data-action]")) ctx.buttons[node.dataset.action] = node;
  ctx.storageKey = storageKey(ctx.data);
  readQueue(ctx);
  const onClick = event => handleClick(ctx, event);
  const onSubmit = event => saveEdit(ctx, event);
  const onResume = () => { if (document.visibilityState !== "hidden") { tick(ctx); sendQueue(ctx, true); action(ctx, "refresh"); paint(ctx); } };
  const onOffline = () => paint(ctx);
  const onEditCancel = () => { ctx.editing = null; };
  const onConfirmCancel = () => { ctx.confirming = null; };
  root.addEventListener("click", onClick);
  ctx.el["edit-form"].addEventListener("submit", onSubmit);
  ctx.el["edit-dialog"].addEventListener("cancel", onEditCancel);
  ctx.el["confirm-dialog"].addEventListener("cancel", onConfirmCancel);
  document.addEventListener("visibilitychange", onResume);
  window.addEventListener("online", onResume);
  window.addEventListener("focus", onResume);
  window.addEventListener("offline", onOffline);
  const timer = setInterval(() => tick(ctx), 250);
  const retry = setInterval(() => { if (document.visibilityState !== "hidden") sendQueue(ctx); }, 5000);
  ctx.cleanup = () => {
    if (ctx.destroyed) return;
    ctx.destroyed = true;
    clearInterval(timer); clearInterval(retry);
    root.removeEventListener("click", onClick);
    ctx.el["edit-form"].removeEventListener("submit", onSubmit);
    ctx.el["edit-dialog"].removeEventListener("cancel", onEditCancel);
    ctx.el["confirm-dialog"].removeEventListener("cancel", onConfirmCancel);
    document.removeEventListener("visibilitychange", onResume);
    window.removeEventListener("online", onResume); window.removeEventListener("focus", onResume); window.removeEventListener("offline", onOffline);
    ctx.el["edit-dialog"].close(); ctx.el["confirm-dialog"].close();
    ctx.el.records.replaceChildren();
    ctx.el["edit-start"].value = ""; ctx.el["edit-end"].value = "";
    instances.delete(parentElement);
  };
  return ctx;
}

export default function tracker(args) {
  const { parentElement, data = {} } = args;
  let ctx = instances.get(parentElement);
  if (ctx && ctx.storageKey !== storageKey(data)) { ctx.cleanup(); ctx = null; }
  if (!ctx) { ctx = createInstance(parentElement, args); instances.set(parentElement, ctx); }
  ctx.bridge = args;
  ctx.data = data;
  const nextQueue = acknowledge(ctx.queue, data.acked_operation_ids);
  if (nextQueue.length !== ctx.queue.length) { ctx.queue = nextQueue; persist(ctx); ctx.transportError = ""; }
  if (Number.isFinite(data.snapshot?.server_now) && data.snapshot.server_now !== ctx.lastServerTime) {
    ctx.lastServerTime = data.snapshot.server_now;
    ctx.clockSkew = Math.abs(Date.now() - data.snapshot.server_now) > 120000;
  }
  paint(ctx); // This deliberately leaves open edit fields untouched.
  if (ctx.queue.length) queueMicrotask(() => sendQueue(ctx));
  return ctx.cleanup;
}
