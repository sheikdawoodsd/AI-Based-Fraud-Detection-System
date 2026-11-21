/* Animated background: a drifting network of transactions. A few nodes get flagged and pulse red. */
(function () {
  const cv = document.getElementById('bg');
  const ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W, H, dpr, nodes = [], t = 0;

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(90, Math.max(34, (W * H) / 20000)));
    nodes = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .28, vy: (Math.random() - .5) * .28,
      r: 1.4 + Math.random() * 1.8,
      flag: Math.random() < .07, ph: Math.random() * 6.28
    }));
  }

  function frame() {
    t += 0.016;
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * .75, H * .1, 0, W * .75, H * .1, Math.max(W, H) * .8);
    g.addColorStop(0, 'rgba(124,140,255,.16)'); g.addColorStop(1, 'rgba(11,16,32,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    for (const a of nodes) {
      if (!reduce) {
        a.x += a.vx; a.y += a.vy;
        if (a.x < -20) a.x = W + 20; if (a.x > W + 20) a.x = -20;
        if (a.y < -20) a.y = H + 20; if (a.y > H + 20) a.y = -20;
      }
    }
    const max = 150;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
        if (d < max) {
          const bad = a.flag || b.flag;
          ctx.strokeStyle = bad ? `rgba(255,93,115,${(1 - d / max) * .22})` : `rgba(124,140,255,${(1 - d / max) * .2})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    for (const a of nodes) {
      if (a.flag) {
        const pulse = (Math.sin(t * 2 + a.ph) + 1) / 2;
        ctx.fillStyle = `rgba(255,93,115,${.08 + pulse * .12})`;
        ctx.beginPath(); ctx.arc(a.x, a.y, 7 + pulse * 14, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#FF5D73';
      } else ctx.fillStyle = 'rgba(170,182,255,.75)';
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.28); ctx.fill();
    }
    if (!reduce) requestAnimationFrame(frame);
  }

  addEventListener('resize', resize);
  resize(); frame();
})();
