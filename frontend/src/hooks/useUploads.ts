"use client";

import { useMemo, useSyncExternalStore } from "react";
import { createMaterialClient } from "@/lib/api/material-client";
import { createUploadQueue, type UploadJob } from "@/lib/materials/uploads";

const client = createMaterialClient();

/** 整个应用共用一个上传队列：关掉新建空间的弹窗、切换页面，上传都继续。 */
export const uploadQueue = createUploadQueue(
  (file, subjectId, signal) => client.upload(file, subjectId ?? undefined, signal),
  { concurrency: 2, discard: (material) => client.remove(material.id) },
);

const EMPTY: UploadJob[] = [];

/** 某个空间（或全部）正在排队、上传、失败的文件 */
export function useUploads(subjectId?: string | null): UploadJob[] {
  const jobs = useSyncExternalStore(uploadQueue.subscribe, uploadQueue.snapshot, () => EMPTY);
  return useMemo(
    () => (subjectId === undefined ? jobs : jobs.filter((job) => job.subjectId === subjectId)),
    [jobs, subjectId],
  );
}
