"use client";

import { useEffect, useRef } from "react";

export function SignupMesh() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let pointerX = 0.7;
    let pointerY = 0.25;

    const size = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * ratio;
      canvas.height = window.innerHeight * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const render = (milliseconds = 0) => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const time = reduced.matches ? 0 : milliseconds * 0.00012;
      context.clearRect(0, 0, width, height);
      context.lineWidth = 0.65;
      for (let row = 0; row < 68; row += 1) {
        const baseY = -55 + row * 6;
        context.beginPath();
        for (let x = -30; x <= width + 30; x += 10) {
          const proximity = Math.exp(-(((x - width * pointerX) / (width * 0.25)) ** 2));
          const wave = Math.sin(x / 102 + row * 0.2 + time * 7) * 14 + Math.sin(x / 290 - row * 0.12 - time * 4) * 18;
          const lift = -proximity * (40 + pointerY * 24);
          const y = baseY + wave + lift;
          if (x === -30) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.strokeStyle = row % 2 ? "rgba(115,87,255,.34)" : "rgba(81,159,231,.34)";
        context.stroke();
      }
      if (!reduced.matches) frame = window.requestAnimationFrame(render);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerX = event.clientX / window.innerWidth;
      pointerY = event.clientY / window.innerHeight;
    };
    const onResize = () => {
      size();
      if (reduced.matches) render();
    };

    size();
    render();
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  return <canvas ref={canvasRef} tabIndex={-1} className="pointer-events-none absolute inset-0 h-full w-full opacity-80" />;
}
