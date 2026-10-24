"use client";

import { useEffect, useRef } from "react";
import styles from "./InteractiveParticleBackground.module.css";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  orbitSpeed: number;
  orbitRadius: number;
};

type Palette = {
  background: string;
  trail: string;
  particle: string;
};

const FALLBACK_PALETTE: Palette = {
  background: "#ffffff",
  trail: "rgba(255, 255, 255, 0.2)",
  particle: "#0066cc",
};
const INFLUENCE = 300;

function reducedMotion() {
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.dataset.motion === "reduced"
  );
}

/**
 * 登录页背景：白底、随机分布的蓝点自由漂移，鼠标靠近时沿切线旋转并向光标聚集。
 * 物理参数与预览站点 HeroSection 的 interactive-bg 保持一致。
 */
export function InteractiveParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frameId = 0;
    let reduced = false;
    let palette: Palette = FALLBACK_PALETTE;
    const pointer = { x: -1000, y: -1000 };

    const readPalette = (): Palette => {
      const computed = getComputedStyle(canvas);
      return {
        background:
          computed.getPropertyValue("--auth-particle-bg").trim() || FALLBACK_PALETTE.background,
        trail: computed.getPropertyValue("--auth-particle-trail").trim() || FALLBACK_PALETTE.trail,
        particle:
          computed.getPropertyValue("--auth-particle-color").trim() || FALLBACK_PALETTE.particle,
      };
    };

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(Math.floor((width * height) / 6000), 250);
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.random() - 0.5,
        vy: Math.random() - 0.5,
        size: Math.random() * 1.5 + 0.5,
        color: palette.particle,
        orbitSpeed: 0.5 + Math.random() * 1.5,
        orbitRadius: 0.8 + Math.random() * 0.4,
      }));
    };

    const step = () => {
      // 以背景色半透明覆盖上一帧，形成参考站点的拖尾。
      ctx.fillStyle = palette.trail;
      ctx.fillRect(0, 0, width, height);

      for (const particle of particles) {
        particle.x += particle.vx;
        particle.y += particle.vy;

        const dx = pointer.x - particle.x;
        const dy = pointer.y - particle.y;
        const distance = Math.hypot(dx, dy);

        if (distance < INFLUENCE) {
          const strength = (INFLUENCE - distance) / INFLUENCE;
          const angle = Math.atan2(dy, dx);

          // 切向：绕光标旋转。
          const tangential = 0.3 * strength * particle.orbitSpeed;
          particle.vx += Math.cos(angle + Math.PI / 2) * tangential;
          particle.vy += Math.sin(angle + Math.PI / 2) * tangential;

          // 径向：向光标聚集。
          const radial = 0.1 * strength * particle.orbitRadius;
          particle.vx += Math.cos(angle) * radial;
          particle.vy += Math.sin(angle) * radial;
        }

        particle.vx *= 0.96;
        particle.vy *= 0.96;
        if (Math.abs(particle.vx) < 0.2) particle.vx += (Math.random() - 0.5) * 0.1;
        if (Math.abs(particle.vy) < 0.2) particle.vy += (Math.random() - 0.5) * 0.1;

        if (particle.x < 0) particle.x = width;
        if (particle.x > width) particle.x = 0;
        if (particle.y < 0) particle.y = height;
        if (particle.y > height) particle.y = 0;

        const speed = Math.hypot(particle.vx, particle.vy);
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fillStyle = particle.color;
        ctx.globalAlpha = Math.min(1, speed / 2 + 0.3);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };

    const frame = () => {
      step();
      frameId = window.requestAnimationFrame(frame);
    };

    const paintStatic = () => {
      ctx.fillStyle = palette.background;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = palette.particle;
      ctx.globalAlpha = 0.5;
      for (const particle of particles) {
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
    };

    const clearPointer = () => {
      pointer.x = -1000;
      pointer.y = -1000;
    };

    const onPointerOut = (event: PointerEvent) => {
      if (!event.relatedTarget) clearPointer();
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
          frameId = 0;
        }
      } else if (!reduced && !frameId) {
        frameId = window.requestAnimationFrame(frame);
      }
    };

    const stop = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", clearPointer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };

    const applyThemePalette = () => {
      const next = readPalette();
      const backgroundChanged = next.background !== palette.background;
      palette = next;
      for (const particle of particles) particle.color = palette.particle;
      if (!backgroundChanged) return;
      ctx.clearRect(0, 0, width, height);
      if (reduced) {
        paintStatic();
      } else {
        ctx.fillStyle = palette.background;
        ctx.fillRect(0, 0, width, height);
      }
    };

    const start = () => {
      stop();
      palette = readPalette();
      build();
      reduced = reducedMotion();
      if (reduced) {
        paintStatic();
        return;
      }
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.addEventListener("pointerout", onPointerOut);
      window.addEventListener("blur", clearPointer);
      document.addEventListener("visibilitychange", onVisibilityChange);
      frameId = window.requestAnimationFrame(frame);
    };

    // ResizeObserver 注册后会立刻回调一次，而下面已经手动 start() 过，第一次直接跳过，避免重复初始化。
    let firstResize = true;
    const resizeObserver = new ResizeObserver(() => {
      if (firstResize) {
        firstResize = false;
        return;
      }
      start();
    });
    resizeObserver.observe(canvas);

    start();

    // 页面打开后用户才改“减少动态效果”（系统设置或应用内开关）时，立即切换成静态或恢复动画。
    const syncMotion = () => {
      if (reducedMotion() !== reduced) start();
    };
    const onThemeOrMotionChange = () => {
      applyThemePalette();
      syncMotion();
    };

    // 主题切换（含“跟随系统”下的系统深浅色变化）时同步背景与粒子颜色。
    const themeObserver = new MutationObserver(onThemeOrMotionChange);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-motion"],
    });
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    colorScheme.addEventListener("change", applyThemePalette);
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    motionQuery.addEventListener("change", syncMotion);

    return () => {
      stop();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      colorScheme.removeEventListener("change", applyThemePalette);
      motionQuery.removeEventListener("change", syncMotion);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.layer} aria-hidden="true" />;
}
