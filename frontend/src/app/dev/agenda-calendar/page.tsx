"use client";

import { useEffect, useRef, useState } from "react";
import WeekCalendar from "@/components/agenda/WeekCalendar";
import AiBreakdownDialog from "@/components/agenda/AiBreakdownDialog";
import { agendaApi } from "@/lib/agenda/api";
import type { AgendaTask, AgendaThread, TaskInput } from "@/lib/agenda/types";

function localDay(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function shift(day: string, amount: number) { const value = new Date(`${day}T12:00`); value.setDate(value.getDate() + amount); return localDay(value); }
function monday(today: string) { return shift(today, -((new Date(`${today}T12:00`).getDay() + 6) % 7)); }
function task(id: string, input: TaskInput): AgendaTask {
  return { id, title: input.title, notes: input.notes ?? "", priority: input.priority ?? 4, labels: input.labels ?? [], parentId: input.parentId ?? null,
    subjectId: input.subjectId ?? null, threadId: null, scheduledDate: input.scheduledDate ?? null, scheduledStartAt: input.scheduledStartAt ?? null,
    durationMinutes: input.durationMinutes ?? null, deadlineDate: input.deadlineDate ?? null, reminderMinutes: null, status: "open", completedAt: null,
    source: input.source ?? "manual", memoryId: null, reviewStep: null, sortOrder: 0, createdAt: "", updatedAt: "" };
}
function fixtures(week: string): AgendaTask[] {
  return [
    task("drag", { title: "戴维南定理 · 拖动试试", scheduledDate: week, scheduledStartAt: `${week}T09:00`, durationMinutes: 60, priority: 1 }),
    task("overlap", { title: "电路例题 · 重叠分栏", scheduledDate: week, scheduledStartAt: `${week}T09:30`, durationMinutes: 60 }),
    task("overlap-2", { title: "整理公式", scheduledDate: week, scheduledStartAt: `${week}T09:45`, durationMinutes: 30 }),
    task("resize", { title: "模拟答辩 · 拉底边", scheduledDate: shift(week, 1), scheduledStartAt: `${shift(week, 1)}T10:00`, durationMinutes: 90 }),
    { ...task("review", { title: "闪回：节点电压法", scheduledDate: shift(week, 2), scheduledStartAt: `${shift(week, 2)}T08:30`, durationMinutes: 45 }), source: "review", reviewStep: 2 },
    task("all-day", { title: "整理期末复习清单", scheduledDate: shift(week, 2) }),
    task("deadline", { title: "提交实验报告", scheduledDate: shift(week, 3), deadlineDate: shift(week, 4) }),
    { ...task("done", { title: "完成：基础概念回顾", scheduledDate: shift(week, 3), scheduledStartAt: `${shift(week, 3)}T09:00`, durationMinutes: 45 }), status: "done" },
    task("weekend", { title: "复习总结", scheduledDate: shift(week, 6), scheduledStartAt: `${shift(week, 6)}T11:00`, durationMinutes: 30 }),
  ];
}

export default function AgendaCalendarPreview() {
  const [today, setToday] = useState("");
  const [week, setWeek] = useState("");
  const [tasks, setTasks] = useState<AgendaTask[]>([]);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState(false);
  const failureRef = useRef(false);
  const [message, setMessage] = useState("本地假数据；不会请求后端或写入数据库。");
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const day = localDay(); const start = monday(day);
    setToday(day); setWeek(start); setTasks(fixtures(start));
    const originalBreakdown = agendaApi.breakdown;
    const originalBatch = agendaApi.createBatch;
    // This route alone temporarily replaces API methods; restore them on navigation/unmount.
    agendaApi.breakdown = async input => {
      await new Promise(resolve => setTimeout(resolve, 900));
      if (failureRef.current) throw new Error("模型暂时不可用，请稍后重试，或手动添加学习任务。（模拟 503）");
      return { parent: { title: input.goal, deadlineDate: input.deadlineDate, priority: 2 }, children: [
        { title: "梳理核心概念与知识盲点", scheduledDate: input.today, scheduledStartAt: `${input.today}T09:00`, durationMinutes: 45, priority: 2 },
        { title: "完成专项练习并记录错因", scheduledDate: shift(input.today, 1), scheduledStartAt: `${shift(input.today, 1)}T10:00`, durationMinutes: 60, priority: 3 },
        { title: "回顾错题，检验掌握情况", scheduledDate: shift(input.today, 2), durationMinutes: 30, priority: 4 },
      ] };
    };
    agendaApi.createBatch = async (parent, children) => {
      await new Promise(resolve => setTimeout(resolve, 350));
      const savedParent = parent ? task(crypto.randomUUID(), parent) : null;
      return { parent: savedParent, children: children.map(input => task(crypto.randomUUID(), { ...input, parentId: savedParent?.id ?? null })) };
    };
    setReady(true);
    return () => { agendaApi.breakdown = originalBreakdown; agendaApi.createBatch = originalBatch; };
  }, []);
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  if (!ready) return <p>正在准备本地预览…</p>;
  const subjects = [{ id: "circuits", name: "电路原理", color: "var(--accent)", deadline: shift(today, 7) }];
  const threads: AgendaThread[] = [{ threadId: "thread", title: "节点法的适用边界", subjectId: "circuits", subjectName: "电路原理", subjectColor: "var(--accent)", deadlineDate: shift(monday(today), 4), updatedAt: "" }];
  const buttonStyle = { border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)", padding: "6px 10px", background: "var(--bg)", color: "var(--text)", cursor: "pointer" };
  return <main style={{ height: "100dvh", padding: 20, display: "flex", flexDirection: "column", gap: 12, background: "var(--bg-app-shell)", color: "var(--text)" }}>
    <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, marginRight: "auto" }}>知隙日程 <span style={{ color: "var(--orange)", fontSize: 12 }}>开发预览 · 假数据</span></h1>
      <label style={{ fontSize: 12 }}><input type="checkbox" checked={failure} onChange={event => { failureRef.current = event.target.checked; setFailure(event.target.checked); }} /> 模拟 503</label>
      <button style={buttonStyle} onClick={() => { setTasks(fixtures(monday(today))); setWeek(monday(today)); }}>重置数据</button>
      <button style={{ ...buttonStyle, background: "var(--accent-solid)", color: "var(--on-accent)" }} onClick={() => setOpen(true)}>AI 拆解目标</button>
    </header>
    <p role="status" style={{ color: "var(--text-secondary)", fontSize: 12 }}>{message}</p>
    <div style={{ flex: 1, minHeight: 0 }}>
      <WeekCalendar weekStart={week} today={today} tasks={tasks} threads={threads} onWeekChange={setWeek}
        onSelectTask={id => setMessage(`选中任务：${tasks.find(value => value.id === id)?.title}`)} onSelectThread={() => setMessage("选中支线：节点法的适用边界")}
        onReschedule={(id, patch) => { setTasks(current => current.map(value => value.id === id ? { ...value, ...patch } : value)); setMessage(`已排期 ${id}：${JSON.stringify(patch)}`); }}
        onCreateAt={slot => { setTasks(current => [...current, task(crypto.randomUUID(), { title: "新学习任务", ...slot, durationMinutes: slot.scheduledStartAt ? 30 : null })]); setMessage(`已本地创建：${slot.scheduledStartAt ?? `${slot.scheduledDate} 全天`}`); }} />
    </div>
    <AiBreakdownDialog open={open} subjects={subjects} defaultSubjectId="circuits" initialGoal="掌握电路原理期末核心知识，完成专项练习" onClose={() => setOpen(false)} onCreated={created => {
      setTasks(current => [...current, ...(created.parent ? [created.parent] : []), ...created.children]); setMessage(`已本地入列：${created.children.length} 条子任务；没有数据库写入。`);
    }} />
  </main>;
}
