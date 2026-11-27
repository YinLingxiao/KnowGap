/**
 * 资料上传队列：文件在后台逐个上传、解析，界面不用干等。
 *
 * - 新建空间时选的资料、资料库里拖进来的文件都放进同一个队列，同时最多传 `concurrency` 个。
 * - 排队中、上传中的可以取消：上传中的会断开请求，后端随之停止解析、不保存；
 *   万一后端刚好已经存好，再调用 `discard` 删掉，不留下用户撤回的资料。
 * - 失败的留在队列里显示原因，可以重试或移除；成功的从队列里拿掉，并通知 `watch` 的订阅者刷新列表。
 *
 * 不依赖 React，方便单测；界面通过 hooks/useUploads 订阅。
 */
import type { CourseMaterial } from "@/lib/types";

export type UploadState = "queued" | "uploading" | "failed";

export interface UploadJob {
  id: string;
  name: string;
  size: number;
  subjectId: string | null;
  state: UploadState;
  error: string | null;
}

export type UploadEvent =
  | { type: "done"; job: UploadJob; material: CourseMaterial }
  | { type: "failed"; job: UploadJob };

export type Uploader = (file: File, subjectId: string | null, signal: AbortSignal) => Promise<CourseMaterial>;

export interface UploadQueueOptions {
  concurrency?: number;
  /** 取消时后端已经存好的资料：删掉它 */
  discard?: (material: CourseMaterial) => Promise<void>;
}

export interface UploadQueue {
  enqueue(files: File[], subjectId: string | null): UploadJob[];
  cancel(id: string): void;
  retry(id: string): void;
  snapshot(): UploadJob[];
  subscribe(listener: () => void): () => void;
  watch(listener: (event: UploadEvent) => void): () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error ? error : "上传失败";
}

export function createUploadQueue(upload: Uploader, { concurrency = 2, discard }: UploadQueueOptions = {}): UploadQueue {
  let jobs: UploadJob[] = [];
  let sequence = 0;
  const files = new Map<string, File>();
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const watchers = new Set<(event: UploadEvent) => void>();

  const changed = () => listeners.forEach((listener) => listener());
  const notify = (event: UploadEvent) => watchers.forEach((watcher) => watcher(event));
  const patch = (id: string, values: Partial<UploadJob>) => {
    jobs = jobs.map((job) => (job.id === id ? { ...job, ...values } : job));
    changed();
  };
  const remove = (id: string) => {
    jobs = jobs.filter((job) => job.id !== id);
    files.delete(id);
    controllers.delete(id);
    changed();
  };

  const start = (job: UploadJob) => {
    const file = files.get(job.id);
    if (!file) return;
    const controller = new AbortController();
    controllers.set(job.id, controller);
    patch(job.id, { state: "uploading", error: null });
    upload(file, job.subjectId, controller.signal).then(
      (material) => {
        if (controller.signal.aborted) {
          void discard?.(material).catch(() => undefined);
          return;
        }
        const finished = jobs.find((item) => item.id === job.id) ?? job;
        remove(job.id);
        notify({ type: "done", job: finished, material });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        controllers.delete(job.id);
        patch(job.id, { state: "failed", error: messageOf(error) });
        const failed = jobs.find((item) => item.id === job.id);
        if (failed) notify({ type: "failed", job: failed });
      },
    ).finally(pump);
  };

  function pump() {
    let running = jobs.filter((job) => job.state === "uploading").length;
    for (const job of jobs) {
      if (running >= concurrency) return;
      if (job.state !== "queued") continue;
      start(job);
      running += 1;
    }
  }

  return {
    enqueue(list, subjectId) {
      const added = list.map((file) => {
        sequence += 1;
        const job: UploadJob = { id: `upload-${sequence}`, name: file.name, size: file.size, subjectId, state: "queued", error: null };
        files.set(job.id, file);
        return job;
      });
      if (!added.length) return added;
      jobs = [...jobs, ...added];
      changed();
      pump();
      return added;
    },
    cancel(id) {
      controllers.get(id)?.abort();
      remove(id);
      pump();
    },
    retry(id) {
      const job = jobs.find((item) => item.id === id);
      if (!job || job.state !== "failed") return;
      patch(id, { state: "queued", error: null });
      pump();
    },
    snapshot: () => jobs,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  };
}

/** 文件大小的短写：812 KB、3.4 MB */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** 同一批里重复选的同一个文件（同名同大小）只留一份 */
export function sameFile(a: { name: string; size: number }, b: { name: string; size: number }): boolean {
  return a.name === b.name && a.size === b.size;
}

/**
 * 长文件名从中间省略：保留结尾（「…Quiz_Final.pptx」），否则同一系列的课件截出来一模一样。
 * 返回 [可省略的前段, 始终显示的结尾]；短名字结尾为空。
 */
export function splitName(name: string, tail = 16): [string, string] {
  if (name.length <= tail + 8) return [name, ""];
  return [name.slice(0, -tail), name.slice(-tail)];
}
