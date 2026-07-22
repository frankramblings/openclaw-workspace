// Background constellation effect with animated stars and connections

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let rafId: number | null = null;
let onResizeHandler: ((ev?: Event) => void) | null = null;
let isRunning = false;

interface Star {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
}

export function startConstellations(): void {
  if (isRunning || document.getElementById('constellations-canvas')) {
    return;
  }

  canvas = document.createElement('canvas');
  canvas.id = 'constellations-canvas';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  document.body.prepend(canvas);

  ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    canvas = null;
    return;
  }

  isRunning = true;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0;
  let H = 0;
  const STAR_COUNT = 50;
  const CONNECT_DIST = 120;
  let stars: Star[] = [];
  let t = 0;

  function resize(): void {
    W = window.innerWidth;
    H = window.innerHeight;
    if (canvas) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (stars.length === 0) {
      initStars();
    }
  }

  function initStars(): void {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        r: 0.8 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  resize();

  onResizeHandler = () => {
    resize();
    initStars();
  };
  window.addEventListener('resize', onResizeHandler);

  function getColor(): string {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue('--bg-effect-color').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2';
  }

  function draw(): void {
    if (!document.body.classList.contains('bg-pattern-constellations')) {
      if (onResizeHandler) {
        window.removeEventListener('resize', onResizeHandler);
        onResizeHandler = null;
      }
      if (canvas) {
        canvas.remove();
        canvas = null;
      }
      ctx = null;
      rafId = null;
      isRunning = false;
      return;
    }

    rafId = requestAnimationFrame(draw);
    t += 0.01;

    if (ctx) {
      ctx.clearRect(0, 0, W, H);
      const c = getColor();

      for (const s of stars) {
        s.x += s.vx;
        s.y += s.vy;
        if (s.x < 0) s.x = W;
        if (s.x > W) s.x = 0;
        if (s.y < 0) s.y = H;
        if (s.y > H) s.y = 0;
      }

      ctx.strokeStyle = c;
      ctx.lineWidth = 0.5;
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          const dx = stars[i].x - stars[j].x;
          const dy = stars[i].y - stars[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONNECT_DIST) {
            ctx.globalAlpha = (1 - dist / CONNECT_DIST) * 0.15;
            ctx.beginPath();
            ctx.moveTo(stars[i].x, stars[i].y);
            ctx.lineTo(stars[j].x, stars[j].y);
            ctx.stroke();
          }
        }
      }

      ctx.fillStyle = c;
      for (const s of stars) {
        const twinkle = 0.5 + 0.5 * Math.sin(t * 2 + s.phase);
        ctx.globalAlpha = 0.15 + twinkle * 0.25;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  draw();
}

export function stopConstellations(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (onResizeHandler) {
    window.removeEventListener('resize', onResizeHandler);
    onResizeHandler = null;
  }
  if (canvas) {
    canvas.remove();
    canvas = null;
  }
  ctx = null;
  isRunning = false;
}
