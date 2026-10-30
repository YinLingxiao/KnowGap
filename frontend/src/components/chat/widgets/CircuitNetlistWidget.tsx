"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  Check, CircleAlert, CircuitBoard, ImageIcon, Loader2, Pencil, Plus, RotateCcw, Trash2, TriangleAlert,
} from "lucide-react";
import { cx } from "@/lib/cx";
import { useI18n } from "@/components/LanguageProvider";
import base from "../LearningWidget.module.css";
import { RouteBadge, useImageUrl } from "./VisionBits";
import { confirmNetlist, getNetlist } from "@/lib/api/vision-client";
import {
  asRecord, asText, checkNetlist, CONTROLLED_ELEMENTS, describeControl, ELEMENT_OPTIONS, elementLabel, netlistText,
  parseNetlistData, toWireNetlist, type NetBranch, type NetControl, type NetIssue, type NetlistData,
} from "./visionData";
import { sendOrAsk } from "./widgetEvents";
import styles from "./VisionWidgets.module.css";

const solveRequest = (tr: (text: string) => string) =>
  tr("请开始列方程求解：先说明选用节点电压法还是网孔电流法，再写出 KCL/KVL 方程并求解。");
const EMPTY_CONTROL: NetControl = { ref: "", quantity: "", direction: "" };

function solveEffort(route: NetlistData["route"]): "low" | "medium" | "high" | undefined {
  return route && route.effort !== "off" ? route.effort : undefined;
}

function fromView(previous: NetlistData, view: Record<string, unknown>): NetlistData {
  return parseNetlistData({
    ...asRecord(view.netlist), title: previous.title, route: previous.route,
    netlist_id: view.netlist_id, image_id: view.image_id, imageUrl: previous.imageSrc, version: view.version,
    confirmed: view.confirmed, issues: view.issues,
  });
}

function IssueList({ issues }: { issues: NetIssue[] }) {
  const { tx } = useI18n();
  if (issues.length === 0) return null;
  return (
    <ul className={styles.issueList} aria-label={tx("拓扑检查结果")}>
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${issue.ref ?? ""}-${i}`} className={issue.level === "error" ? styles.issueError : styles.issueWarn}>
          {issue.level === "error" ? <CircleAlert size={13} aria-hidden /> : <TriangleAlert size={13} aria-hidden />}
          <span>
            <span className="sr-only">{issue.level === "error" ? tx("错误：") : tx("提醒：")}</span>
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * circuit_netlist: the vision model's netlist draft, confirmed or corrected by the student before
 * the reasoning model solves anything.
 *
 * data: { title, netlist_id, version, image_id? | imageUrl?, nodes: [{ id, note }], branches: [{ id, element, value,
 *         from, to, polarity, control: { ref, quantity: "U" | "I", direction } | null }], uncertain: [id],
 *         issues?, route? }
 * Cards written without a netlist_id (by the model directly) still work and confirm through a text prompt.
 */
export function CircuitNetlistWidget({ data }: { data: Record<string, unknown> }) {
  const { tx } = useI18n();
  const initial = useMemo(() => parseNetlistData(data), [data]);
  const [card, setCard] = useState<NetlistData>(initial);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<NetBranch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverIssues, setServerIssues] = useState<NetIssue[]>([]);
  const [sent, setSent] = useState<"sent" | "prefilled" | null>(null);
  const [showImage, setShowImage] = useState(false);
  const image = useImageUrl(showImage ? card.imageId : null);
  const refImageSrc = card.imageId ? image.url : card.imageSrc;
  const hasReferenceImage = Boolean(card.imageId || card.imageSrc);
  const listId = useId();

  useEffect(() => {
    setCard(initial);
  }, [initial]);

  const netlistId = initial.netlistId;
  useEffect(() => {
    if (!netlistId) return;
    let alive = true;
    // The card JSON in the message is the first draft; the server knows later versions and confirmation.
    getNetlist(netlistId).then(
      (view) => {
        if (alive) setCard((previous) => fromView(previous, view));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [netlistId]);

  const editing = mode === "edit";
  const rows = editing ? draft : card.branches;
  const editErrors = useMemo(() => (editing ? checkNetlist(draft) : []), [editing, draft]);
  const viewIssues = useMemo(
    () => (card.issues.length ? card.issues : checkNetlist(card.branches)),
    [card.issues, card.branches],
  );
  const nodeIds = useMemo(
    () => [...new Set([...card.nodes.map((node) => node.id), ...rows.flatMap((row) => [row.from, row.to])].filter(Boolean))],
    [card.nodes, rows],
  );

  if (card.branches.length === 0 && !editing) return null;

  const blocking = viewIssues.some((issue) => issue.level === "error");
  const errorRefs = new Set(
    [...(editing ? editErrors : viewIssues), ...serverIssues]
      .filter((issue) => issue.level === "error" && issue.ref)
      .map((issue) => issue.ref),
  );
  const uncertain = new Set(card.uncertain);
  const hasControl = rows.some((row) => CONTROLLED_ELEMENTS.has(row.element));
  const hasPolarity = editing || rows.some((row) => row.polarity);
  const done = card.confirmed;

  const patch = (index: number, change: Partial<NetBranch>) =>
    setDraft((all) => all.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const patchControl = (index: number, change: Partial<NetControl>) =>
    setDraft((all) => all.map((row, i) => (i === index ? { ...row, control: { ...(row.control ?? EMPTY_CONTROL), ...change } } : row)));

  const startEdit = () => {
    setDraft(card.branches.map((row) => ({ ...row, control: row.control ? { ...row.control } : null })));
    setMode("edit");
    setError("");
    setServerIssues([]);
  };

  const addRow = () =>
    setDraft((all) => {
      const used = new Set(all.map((row) => row.id));
      let n = all.length + 1;
      while (used.has(`B${n}`)) n += 1;
      return [...all, { id: `B${n}`, element: "R", value: "", from: "", to: "", polarity: "", control: null }];
    });

  const confirm = async (edited: NetBranch[] | null) => {
    const branches = edited ?? card.branches;
    const errors = checkNetlist(branches);
    if (errors.length) {
      setError(errors[0].message);
      return;
    }
    setError("");
    setServerIssues([]);
    if (!card.netlistId) {
      const text = [
        tx("「{title}」的电路拓扑我已核对{state}：", {
          title: card.title,
          state: edited ? tx("并修正") : tx("，连接无误"),
        }),
        netlistText(card.nodes, branches),
        solveRequest(tx),
      ].join("\n");
      setCard({ ...card, branches, confirmed: true });
      setMode("view");
      setSent(sendOrAsk(text, solveEffort(card.route)));
      return;
    }
    setBusy(true);
    try {
      const view = await confirmNetlist(card.netlistId, card.version, edited ? toWireNetlist(card.nodes, edited) : null);
      const next = fromView(card, view);
      setCard(next);
      setMode("view");
      const marker = asText(view.marker) || `[[kg-netlist:${next.netlistId}@${next.version}]]`;
      // The backend's relay_prompt carries the confirmed netlist text and the routed effort.
      const solve = asText(view.relay_prompt) || tx("电路拓扑已确认{state}。{request}", {
        state: edited ? tx("（含我的修正）") : tx("，连接无误"),
        request: solveRequest(tx),
      });
      setSent(sendOrAsk(`${marker}\n${solve}`, solveEffort(next.route)));
    } catch (err) {
      const apiError = err as { message?: string; kind?: string; issues?: NetIssue[] };
      setError(apiError.message || tx("确认失败，请稍后重试。"));
      if (apiError.issues?.length) setServerIssues(apiError.issues);
      if (apiError.kind === "conflict" && card.netlistId) {
        getNetlist(card.netlistId).then((view) => setCard((previous) => fromView(previous, view)), () => {});
        setMode("view");
      }
    } finally {
      setBusy(false);
    }
  };

  const doneText = !card.netlistId
    ? sent === "sent" ? tx("已确认拓扑，AI 正在列方程求解。") : tx("已确认拓扑，求解请求已填入输入框，按回车发送。")
    : sent === "sent" ? tx("已确认拓扑（第 {version} 版），AI 正在列方程求解。", { version: card.version })
      : sent === "prefilled" ? tx("已确认拓扑（第 {version} 版），求解请求已填入输入框，按回车发送。", { version: card.version })
        : tx("这张拓扑卡已确认（第 {version} 版）。", { version: card.version });

  return (
    <section className={base.widgetCard} aria-label={card.title}>
      <header className={base.widgetHead}>
        <div className={base.widgetTitleWrap}>
          <span className={base.widgetBadge}>
            <CircuitBoard size={12} aria-hidden />
            {tx("电路拓扑")}
          </span>
          <strong className={base.widgetTitle}>{card.title}</strong>
        </div>
        <div className={styles.headMeta}>
          <RouteBadge route={card.route} />
          <span className={base.stepCounter}>
            {tx("{nodes} 个节点 · {branches} 条支路", { nodes: nodeIds.length, branches: rows.length })}{card.netlistId ? tx(" · 第 {version} 版", { version: card.version }) : ""}
          </span>
        </div>
      </header>

      {!done && !editing && (
        <p className={styles.hint}>{tx("花几秒核对节点和连线：标黄的支路是识别不确定的地方，确认无误后再开始计算。")}</p>
      )}

      {!editing && card.nodes.length > 0 && (
        <div className={base.netNodes} role="list" aria-label={tx("识别出的节点")}>
          {card.nodes.map((node) => (
            <span key={node.id} role="listitem" className={base.netNode} title={node.note || undefined}>
              {node.id}
            </span>
          ))}
        </div>
      )}

      <div className={base.matrixScroll}>
        <table className={cx(base.matrixTable, editing && styles.editTable)}>
          <thead>
            <tr>
              <th scope="col">{tx("支路")}</th>
              <th scope="col">{tx("元件")}</th>
              <th scope="col">{tx("参数")}</th>
              <th scope="col">{tx("起点")}</th>
              <th scope="col">{tx("终点")}</th>
              {hasPolarity && <th scope="col">{tx("极性 / 参考方向")}</th>}
              {hasControl && <th scope="col">{tx("控制量")}</th>}
              {editing && <th scope="col"><span className="sr-only">{tx("删除")}</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const flagged = errorRefs.has(row.id);
              const doubtful = !editing && uncertain.has(row.id);
              const rowClass = cx(flagged && styles.rowError, !flagged && doubtful && styles.rowUncertain);
              if (!editing) {
                return (
                  <tr key={`${row.id}-${i}`} className={rowClass}>
                    <td className={base.dimCell}>
                      {row.id}
                      {doubtful && (
                        <span className={styles.flag}>
                          <TriangleAlert size={11} aria-hidden />
                          {tx("待核对")}
                        </span>
                      )}
                    </td>
                    <td>{elementLabel(row.element)}</td>
                    <td>{row.value || <span className={styles.muted}>—</span>}</td>
                    <td>{row.from}</td>
                    <td>{row.to}</td>
                    {hasPolarity && <td>{row.polarity || <span className={styles.muted}>—</span>}</td>}
                    {hasControl && <td>{CONTROLLED_ELEMENTS.has(row.element) ? describeControl(row.control) || tx("未填写") : ""}</td>}
                  </tr>
                );
              }
              const label = tx("第 {n} 条支路", { n: i + 1 });
              const controlled = CONTROLLED_ELEMENTS.has(row.element);
              return (
                <tr key={i} className={rowClass}>
                  <td>
                    <input className={styles.cellInput} value={row.id} maxLength={16} aria-label={tx("{label}编号", { label })}
                      onChange={(event) => patch(i, { id: event.target.value.replace(/\s/g, "") })} />
                  </td>
                  <td>
                    <select className={styles.cellSelect} value={row.element} aria-label={tx("{label}元件类型", { label })}
                      onChange={(event) => {
                        const element = event.target.value;
                        patch(i, { element, control: CONTROLLED_ELEMENTS.has(element) ? row.control ?? { ...EMPTY_CONTROL } : null });
                      }}>
                      {ELEMENT_OPTIONS.map(([code, name]) => (
                        <option key={code} value={code}>{name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input className={styles.cellInput} value={row.value} maxLength={40} placeholder="10Ω" aria-label={tx("{label}参数", { label })}
                      onChange={(event) => patch(i, { value: event.target.value })} />
                  </td>
                  <td>
                    <input className={styles.cellInput} value={row.from} maxLength={16} list={listId} aria-label={tx("{label}起点", { label })}
                      onChange={(event) => patch(i, { from: event.target.value.replace(/\s/g, "") })} />
                  </td>
                  <td>
                    <input className={styles.cellInput} value={row.to} maxLength={16} list={listId} aria-label={tx("{label}终点", { label })}
                      onChange={(event) => patch(i, { to: event.target.value.replace(/\s/g, "") })} />
                  </td>
                  <td>
                    <input className={styles.cellInput} value={row.polarity} maxLength={24} placeholder="+a" aria-label={tx("{label}极性或参考方向", { label })}
                      onChange={(event) => patch(i, { polarity: event.target.value })} />
                  </td>
                  {hasControl && (
                    <td>
                      {controlled && (
                        <div className={styles.controlCell}>
                          <select className={styles.cellSelect} value={row.control?.ref ?? ""} aria-label={tx("{label}控制量所在支路", { label })}
                            onChange={(event) => patchControl(i, { ref: event.target.value })}>
                            <option value="">{tx("控制支路")}</option>
                            {draft.filter((other, j) => j !== i && other.id).map((other) => (
                              <option key={other.id} value={other.id}>{other.id}</option>
                            ))}
                          </select>
                          <select className={styles.cellSelect} value={row.control?.quantity ?? ""} aria-label={tx("{label}控制量类型", { label })}
                            onChange={(event) => patchControl(i, { quantity: event.target.value as NetControl["quantity"] })}>
                            <option value="">{tx("类型")}</option>
                            <option value="U">{tx("电压")}</option>
                            <option value="I">{tx("电流")}</option>
                          </select>
                          <input className={styles.cellInput} value={row.control?.direction ?? ""} maxLength={24} placeholder="a→b"
                            aria-label={tx("{label}控制量方向", { label })} onChange={(event) => patchControl(i, { direction: event.target.value })} />
                        </div>
                      )}
                    </td>
                  )}
                  <td>
                    <button type="button" className={styles.iconBtn} aria-label={tx("删除{label} {id}", { label, id: row.id })}
                      onClick={() => setDraft((all) => all.filter((_, j) => j !== i))}>
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {editing && (
          <datalist id={listId}>
            {nodeIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        )}
      </div>

      <IssueList issues={editing ? editErrors : viewIssues} />
      {error && <p className={styles.errorNote} role="alert">{error}</p>}
      <IssueList issues={serverIssues} />
      {done && (
        <p className={styles.confirmedNote} role="status">
          <Check size={13} aria-hidden />
          {doneText}
        </p>
      )}

      {showImage && hasReferenceImage && (
        refImageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated blob/public reference, not optimizable here
          <img className={styles.refImage} src={refImageSrc} alt={tx("{title} 的原图", { title: card.title })} />
        ) : (
          <p className={styles.hint}>{image.failed ? tx("原图无法加载，可能已被删除。") : tx("原图加载中…")}</p>
        )
      )}

      <footer className={base.widgetFoot}>
        {hasReferenceImage && (
          <button type="button" className={base.ctrlBtn} aria-expanded={showImage} onClick={() => setShowImage((open) => !open)}>
            <ImageIcon size={12} aria-hidden />
            <span>{showImage ? tx("收起原图") : tx("对照原图")}</span>
          </button>
        )}
        {!done && !editing && (
          <div className={styles.footActions}>
            <button type="button" className={base.ctrlBtn} disabled={busy} onClick={startEdit}>
              <Pencil size={12} aria-hidden />
              <span>{tx("修正某条支路连接")}</span>
            </button>
            <button type="button" className={base.askAiBtn} disabled={busy || blocking} onClick={() => void confirm(null)}
              title={blocking ? tx("网表有连接错误，请先修正") : undefined}>
              {busy ? <Loader2 size={12} className={styles.spin} aria-hidden /> : <Check size={12} aria-hidden />}
              <span>{tx("连接无误，交由逻辑模型列方程求解")}</span>
            </button>
          </div>
        )}
        {!done && editing && (
          <div className={styles.footActions}>
            <button type="button" className={base.ctrlBtn} disabled={busy || draft.length >= 80} onClick={addRow}>
              <Plus size={12} aria-hidden />
              <span>{tx("添加支路")}</span>
            </button>
            <button type="button" className={base.ctrlBtn} disabled={busy} onClick={startEdit}>
              <RotateCcw size={12} aria-hidden />
              <span>{tx("恢复识别结果")}</span>
            </button>
            <button type="button" className={base.ctrlBtn} disabled={busy} onClick={() => { setMode("view"); setError(""); setServerIssues([]); }}>
              <span>{tx("取消")}</span>
            </button>
            <button type="button" className={base.askAiBtn} disabled={busy || editErrors.length > 0} onClick={() => void confirm(draft)}>
              {busy ? <Loader2 size={12} className={styles.spin} aria-hidden /> : <Check size={12} aria-hidden />}
              <span>{tx("提交修正并求解")}</span>
            </button>
          </div>
        )}
      </footer>
    </section>
  );
}
