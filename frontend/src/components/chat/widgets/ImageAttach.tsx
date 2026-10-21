"use client";

import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { toApiError } from "@/lib/api/errors";
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_BYTES, uploadImage, type UploadedImage } from "@/lib/api/vision-client";
import styles from "./VisionWidgets.module.css";

interface ImageAttachProps {
  /** Called after a successful upload. Typical use: setDraft(withImageMarker(draft, image.marker)). */
  onUploaded: (image: UploadedImage) => void;
  disabled?: boolean;
}

/** Composer toolbar button: pick an image, upload it, hand back the [[kg-image:...]] marker. */
export function ImageAttach({ onUploaded, disabled = false }: ImageAttachProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    // The backend re-checks the bytes; this only saves a pointless upload.
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError("只支持 PNG、JPEG 或 WebP 图片。");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("图片不能超过 10 MB，请压缩或裁剪后再上传。");
      return;
    }
    setBusy(true);
    try {
      onUploaded(await uploadImage(file));
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <span className={styles.attach}>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => void pick(event.target.files?.[0])}
      />
      <button
        type="button"
        className={styles.attachBtn}
        disabled={disabled || busy}
        aria-label={busy ? "正在上传图片" : "上传图片（错题、电路图或题目截图）"}
        title="上传图片：手写错题、电路图或题目截图"
        onClick={() => input.current?.click()}
      >
        {busy ? <Loader2 size={16} className={styles.spin} aria-hidden /> : <ImagePlus size={16} aria-hidden />}
      </button>
      {error && (
        <span className={styles.attachError} role="alert">
          <span>{error}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setError("")}>
            <X size={12} aria-hidden />
          </button>
        </span>
      )}
    </span>
  );
}
