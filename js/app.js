(function () {
    'use strict';

    // ─── Configuration ───
    const PAGE_FILES = [
        'pages/عصير_Page_1.png',
        'pages/عصير_Page_2.png',
        'pages/عصير_Page_3.png',
        'pages/عصير_Page_4.png',
        'pages/عصير_Page_5.png'
    ];
    const A4_RATIO = 21 / 29.7;

    // ─── DOM ───
    const canvas = document.getElementById('flipbook-canvas');
    const ctx = canvas.getContext('2d');
    const navLeft = document.getElementById('nav-left');
    const navRight = document.getElementById('nav-right');
    const pageIndicator = document.getElementById('page-indicator');

    // ─── State ───
    let pages = [];
    let currentPage = 0;
    let totalPages = 0;
    let pageW = 0, pageH = 0, dpr = 1;

    // Interaction
    let isDragging = false;
    let isAnimating = false;
    let flipDirection = 0; // 1=forward, -1=backward
    let cornerOrigin = { x: 0, y: 0 };
    let pointerPos = { x: 0, y: 0 };

    // Audio
    let audioCtx = null;

    // ─── Audio ───
    function initAudio() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    function playFlipSound() {
        if (!audioCtx) return;
        try {
            const now = audioCtx.currentTime;
            const sr = audioCtx.sampleRate;

            // Crisp grab
            const g = audioCtx.createBuffer(1, Math.round(sr * 0.06), sr);
            const gd = g.getChannelData(0);
            for (let i = 0; i < gd.length; i++) gd[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 60) * 0.22;
            const gs = audioCtx.createBufferSource(); gs.buffer = g;
            const gf = audioCtx.createBiquadFilter(); gf.type = 'bandpass'; gf.frequency.value = 3200; gf.Q.value = 1.2;
            gs.connect(gf).connect(audioCtx.destination); gs.start(now);

            // Paper swoosh
            const s = audioCtx.createBuffer(1, Math.round(sr * 0.28), sr);
            const sd = s.getChannelData(0);
            for (let i = 0; i < sd.length; i++) {
                const t = i / sr;
                sd[i] = (Math.random() * 2 - 1) * Math.exp(-Math.pow((t - 0.08) / 0.06, 2)) * 0.14;
            }
            for (let p = 0; p < 3; p++) for (let i = 1; i < sd.length - 1; i++) sd[i] = (sd[i - 1] + sd[i] * 2 + sd[i + 1]) / 4;
            const ss = audioCtx.createBufferSource(); ss.buffer = s;
            const sf = audioCtx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 2500;
            ss.connect(sf).connect(audioCtx.destination); ss.start(now + 0.02);

            // Soft thump
            const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 75;
            const og = audioCtx.createGain();
            og.gain.setValueAtTime(0, now + 0.2);
            og.gain.linearRampToValueAtTime(0.07, now + 0.22);
            og.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
            o.connect(og).connect(audioCtx.destination); o.start(now + 0.2); o.stop(now + 0.4);
        } catch (_) { }
    }

    // ─── Image Loading ───
    function loadImages() {
        return Promise.all(PAGE_FILES.map(src => new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed: ' + src));
            img.src = src;
        })));
    }

    // ─── Sizing ───
    function calculateDimensions() {
        const vw = window.innerWidth, vh = window.innerHeight;
        const isMobile = vw <= 768;
        let tw = isMobile ? vw * 0.93 : vw * 0.85;
        let th = tw / A4_RATIO;
        const maxH = vh * 0.88;
        if (th > maxH) { th = maxH; tw = th * A4_RATIO; }
        pageW = Math.round(Math.max(tw, 260));
        pageH = Math.round(pageW / A4_RATIO);
        dpr = window.devicePixelRatio || 1;
        canvas.width = pageW * dpr;
        canvas.height = pageH * dpr;
        canvas.style.width = pageW + 'px';
        canvas.style.height = pageH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ══════════════════════════════════════════════════════
    // ─── FOLD-LINE GEOMETRY ───
    // The fold line = perpendicular bisector of segment Corner→Pointer.
    // foldNorm points toward the corner (the "folded-away" side).
    // ══════════════════════════════════════════════════════

    function computeFold(corner, pointer) {
        const dx = pointer.x - corner.x, dy = pointer.y - corner.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) return null;
        return {
            mx: (corner.x + pointer.x) / 2,
            my: (corner.y + pointer.y) / 2,
            fdx: -dy / dist, fdy: dx / dist,   // fold-line direction
            fnx: -dx / dist, fny: -dy / dist,   // normal → toward corner
            dist
        };
    }

    // Constrain pointer so fold line stays on the page
    function constrainPointer(corner, ptr) {
        let px = ptr.x, py = ptr.y;
        const margin = 30;
        // Keep midpoint roughly within page
        let mmx = (corner.x + px) / 2, mmy = (corner.y + py) / 2;
        if (mmx < -margin) px = 2 * (-margin) - corner.x;
        if (mmx > pageW + margin) px = 2 * (pageW + margin) - corner.x;
        if (mmy < -margin) py = 2 * (-margin) - corner.y;
        if (mmy > pageH + margin) py = 2 * (pageH + margin) - corner.y;
        return { x: px, y: py };
    }

    // ─── Clip to one side of the fold line (with optional Bezier bow) ───
    // cornerSide=true → keep corner side  |  false → keep opposite side
    // The curve always bows toward the KEPT side for a paper-bend illusion.
    function clipFold(f, cornerSide, curvature) {
        const sign = cornerSide ? 1 : -1;
        const ext = (pageW + pageH) * 2;
        const lx1 = f.mx - f.fdx * ext, ly1 = f.my - f.fdy * ext;
        const lx2 = f.mx + f.fdx * ext, ly2 = f.my + f.fdy * ext;
        const ox = f.fnx * ext * sign, oy = f.fny * ext * sign;

        // Control point always bows toward the KEPT side (away from corner)
        const cpx = f.mx - f.fnx * curvature;
        const cpy = f.my - f.fny * curvature;

        ctx.beginPath();
        ctx.moveTo(lx1, ly1);
        if (curvature > 0.5) {
            ctx.quadraticCurveTo(cpx, cpy, lx2, ly2);
        } else {
            ctx.lineTo(lx2, ly2);
        }
        ctx.lineTo(lx2 + ox, ly2 + oy);
        ctx.lineTo(lx1 + ox, ly1 + oy);
        ctx.closePath();
        ctx.clip();
    }

    // Reflect coordinate system across the fold line
    function reflectAcrossFold(f) {
        const nx = f.fnx, ny = f.fny, mx = f.mx, my = f.my;
        const dot = nx * mx + ny * my;
        ctx.transform(1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny,
            2 * nx * dot, 2 * ny * dot);
    }

    // ══════════════════════════════════════════════════════
    // ─── RENDERING ───
    // ══════════════════════════════════════════════════════

    function render() {
        ctx.clearRect(0, 0, pageW, pageH);
        if (totalPages === 0) return;
        if (isDragging || isAnimating) {
            renderCurl();
        } else {
            drawPage(currentPage);
        }
    }

    function drawPage(idx) {
        if (idx >= 0 && idx < totalPages) {
            ctx.drawImage(pages[idx], 0, 0, pageW, pageH);
        } else {
            ctx.fillStyle = '#f5f0e8';
            ctx.fillRect(0, 0, pageW, pageH);
        }
    }

    function renderCurl() {
        const cPtr = constrainPointer(cornerOrigin, pointerPos);
        const f = computeFold(cornerOrigin, cPtr);
        if (!f) { drawPage(currentPage); return; }

        const diag = Math.sqrt(pageW * pageW + pageH * pageH);
        const progress = Math.min(1, f.dist / diag);
        const curvature = Math.sin(progress * Math.PI) * pageW * 0.06;

        const revealIdx = flipDirection === 1 ? currentPage + 1 : currentPage - 1;

        // ── Layer 1: Revealed page (next/prev) visible in the folded-away region ──
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
        clipFold(f, true, curvature);
        drawPage(revealIdx);
        // Shadow on revealed page near the fold
        const sw = Math.min(70, pageW * progress * 0.25);
        if (sw > 2) {
            const sg = ctx.createLinearGradient(
                f.mx + f.fnx * 1, f.my + f.fny * 1,
                f.mx + f.fnx * sw, f.my + f.fny * sw);
            const sa = Math.min(0.45, progress * 0.55);
            sg.addColorStop(0, 'rgba(0,0,0,' + sa + ')');
            sg.addColorStop(0.35, 'rgba(0,0,0,' + (sa * 0.35) + ')');
            sg.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = sg;
            ctx.fillRect(-50, -50, pageW + 100, pageH + 100);
        }
        ctx.restore();

        // ── Layer 2: Current page — the unfolded (kept) part ──
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
        clipFold(f, false, curvature);
        drawPage(currentPage);
        // Light highlight near fold edge on front
        if (progress > 0.015) {
            const hw = Math.min(25, pageW * progress * 0.12);
            const hg = ctx.createLinearGradient(
                f.mx - f.fnx * 1, f.my - f.fny * 1,
                f.mx - f.fnx * hw, f.my - f.fny * hw);
            hg.addColorStop(0, 'rgba(255,255,255,' + Math.min(0.14, progress * 0.18) + ')');
            hg.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = hg;
            ctx.fillRect(-50, -50, pageW + 100, pageH + 100);
        }
        ctx.restore();

        // ── Layer 3: Back of the curl (reflected paper back) ──
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
        clipFold(f, true, curvature);

        ctx.save();
        reflectAcrossFold(f);
        ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
        // Draw cream paper back
        ctx.fillStyle = '#efe9df';
        ctx.fillRect(0, 0, pageW, pageH);
        // Faint bleed-through
        ctx.globalAlpha = 0.05;
        drawPage(currentPage);
        ctx.globalAlpha = 1;
        ctx.restore();

        // Curvature shading on the curl back
        const cw = Math.max(20, f.dist * 0.6);
        const cg = ctx.createLinearGradient(
            f.mx - f.fnx * 2, f.my - f.fny * 2,
            f.mx + f.fnx * cw, f.my + f.fny * cw);
        cg.addColorStop(0, 'rgba(0,0,0,0.18)');
        cg.addColorStop(0.08, 'rgba(255,255,255,0.07)');
        cg.addColorStop(0.18, 'rgba(0,0,0,0.04)');
        cg.addColorStop(0.5, 'rgba(255,255,255,0.03)');
        cg.addColorStop(0.8, 'rgba(0,0,0,0.06)');
        cg.addColorStop(1, 'rgba(0,0,0,0.12)');
        ctx.fillStyle = cg;
        ctx.fillRect(-50, -50, pageW + 100, pageH + 100);
        ctx.restore();

        // ── Layer 4: Fold edge (paper thickness line) ──
        if (progress > 0.01) {
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
            const ext = (pageW + pageH) * 2;
            const cpx = f.mx - f.fnx * curvature;
            const cpy = f.my - f.fny * curvature;

            ctx.beginPath();
            ctx.moveTo(f.mx - f.fdx * ext, f.my - f.fdy * ext);
            if (curvature > 0.5) {
                ctx.quadraticCurveTo(cpx, cpy, f.mx + f.fdx * ext, f.my + f.fdy * ext);
            } else {
                ctx.lineTo(f.mx + f.fdx * ext, f.my + f.fdy * ext);
            }
            ctx.strokeStyle = 'rgba(80,70,60,' + Math.min(0.3, progress * 0.4) + ')';
            ctx.lineWidth = Math.min(1.8, progress * 2.5);
            ctx.stroke();

            // Paper edge highlight
            ctx.beginPath();
            ctx.moveTo(f.mx - f.fdx * ext - f.fnx * 1.5, f.my - f.fdy * ext - f.fny * 1.5);
            if (curvature > 0.5) {
                ctx.quadraticCurveTo(cpx - f.fnx * 1.5, cpy - f.fny * 1.5,
                    f.mx + f.fdx * ext - f.fnx * 1.5, f.my + f.fdy * ext - f.fny * 1.5);
            } else {
                ctx.lineTo(f.mx + f.fdx * ext - f.fnx * 1.5, f.my + f.fdy * ext - f.fny * 1.5);
            }
            ctx.strokeStyle = 'rgba(255,255,240,' + Math.min(0.15, progress * 0.2) + ')';
            ctx.lineWidth = 0.8;
            ctx.stroke();
            ctx.restore();
        }
    }

    // ══════════════════════════════════════════════════════
    // ─── POINTER INTERACTION ───
    // ══════════════════════════════════════════════════════

    function getPointerPos(e) {
        const rect = canvas.getBoundingClientRect();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        return {
            x: (cx - rect.left) * (pageW / rect.width),
            y: (cy - rect.top) * (pageH / rect.height)
        };
    }

    function onPointerDown(e) {
        if (isAnimating) return;
        initAudio();
        const pos = getPointerPos(e);
        const edgeZone = pageW * 0.30;

        // Right edge → flip forward
        if (pos.x > pageW - edgeZone && currentPage < totalPages - 1) {
            const cornerY = pos.y > pageH / 2 ? pageH : 0;
            isDragging = true;
            flipDirection = 1;
            cornerOrigin = { x: pageW, y: cornerY };
            pointerPos = { x: pos.x, y: pos.y };
            canvas.style.cursor = 'grabbing';
            render();
            return;
        }
        // Left edge → flip backward
        if (pos.x < edgeZone && currentPage > 0) {
            const cornerY = pos.y > pageH / 2 ? pageH : 0;
            isDragging = true;
            flipDirection = -1;
            cornerOrigin = { x: 0, y: cornerY };
            pointerPos = { x: pos.x, y: pos.y };
            canvas.style.cursor = 'grabbing';
            render();
            return;
        }
    }

    function onPointerMove(e) {
        if (!isDragging) {
            const pos = getPointerPos(e);
            const edgeZone = pageW * 0.30;
            const nearEdge =
                (pos.x > pageW - edgeZone && currentPage < totalPages - 1) ||
                (pos.x < edgeZone && currentPage > 0);
            canvas.style.cursor = nearEdge ? 'grab' : 'default';
            return;
        }
        e.preventDefault();
        pointerPos = getPointerPos(e);
        render();
    }

    function onPointerUp() {
        if (!isDragging) return;
        isDragging = false;
        canvas.style.cursor = 'default';

        const cPtr = constrainPointer(cornerOrigin, pointerPos);
        const f = computeFold(cornerOrigin, cPtr);
        const diag = Math.sqrt(pageW * pageW + pageH * pageH);
        const progress = f ? Math.min(1, f.dist / diag) : 0;

        if (progress > 0.18) {
            animateComplete();
        } else {
            animateSnapBack();
        }
    }

    // ══════════════════════════════════════════════════════
    // ─── ANIMATIONS ───
    // ══════════════════════════════════════════════════════

    function animateComplete() {
        isAnimating = true;
        const start = { x: pointerPos.x, y: pointerPos.y };
        // Target: the opposite side of the page
        const target = {
            x: cornerOrigin.x === pageW ? -pageW * 0.35 : pageW * 1.35,
            y: cornerOrigin.y
        };
        playFlipSound();
        const t0 = performance.now(), dur = 480;

        function step(now) {
            const t = Math.min((now - t0) / dur, 1);
            const e = 1 - Math.pow(1 - t, 3);
            pointerPos = {
                x: start.x + (target.x - start.x) * e,
                y: start.y + (target.y - start.y) * e
            };
            render();
            if (t < 1) { requestAnimationFrame(step); }
            else {
                currentPage += flipDirection;
                isAnimating = false;
                flipDirection = 0;
                render();
                updateUI();
            }
        }
        requestAnimationFrame(step);
    }

    function animateSnapBack() {
        isAnimating = true;
        const start = { x: pointerPos.x, y: pointerPos.y };
        const target = { x: cornerOrigin.x, y: cornerOrigin.y };
        const t0 = performance.now(), dur = 320;

        function step(now) {
            const t = Math.min((now - t0) / dur, 1);
            const e = 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 0.3);
            pointerPos = {
                x: start.x + (target.x - start.x) * Math.min(1, e),
                y: start.y + (target.y - start.y) * Math.min(1, e)
            };
            render();
            if (t < 1) { requestAnimationFrame(step); }
            else {
                isAnimating = false;
                flipDirection = 0;
                render();
            }
        }
        requestAnimationFrame(step);
    }

    function autoFlip(dir) {
        if (isAnimating || isDragging) return;
        const target = currentPage + dir;
        if (target < 0 || target >= totalPages) return;
        initAudio();
        flipDirection = dir;
        cornerOrigin = { x: dir === 1 ? pageW : 0, y: pageH };
        pointerPos = { x: dir === 1 ? pageW - 3 : 3, y: pageH - 3 };
        animateComplete();
    }

    // ─── UI ───
    function updateUI() {
        pageIndicator.textContent = (currentPage + 1) + ' / ' + totalPages;
        navLeft.classList.toggle('disabled', currentPage <= 0);
        navRight.classList.toggle('disabled', currentPage >= totalPages - 1);
    }

    // ─── Events ───
    function bindEvents() {
        canvas.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        canvas.addEventListener('touchstart', onPointerDown, { passive: true });
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);
        navLeft.addEventListener('click', () => autoFlip(-1));
        navRight.addEventListener('click', () => autoFlip(1));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') autoFlip(1);
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') autoFlip(-1);
        });
        window.addEventListener('resize', () => { calculateDimensions(); render(); });
    }

    // ─── Init ───
    async function init() {
        calculateDimensions();
        ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, pageW, pageH);
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '15px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Loading menu…', pageW / 2, pageH / 2);

        try {
            pages = await loadImages();
            totalPages = pages.length;
            render();
            updateUI();
            bindEvents();

            // Hint: brief corner curl peek
            setTimeout(() => {
                if (isAnimating || isDragging) return;
                flipDirection = 1;
                cornerOrigin = { x: pageW, y: pageH };
                isAnimating = true;
                const dur = 900, t0 = performance.now();
                const peekX = pageW * 0.78, peekY = pageH * 0.82;
                (function step(now) {
                    const t = Math.min((now - t0) / dur, 1);
                    if (t < 0.45) {
                        const e = Math.sin((t / 0.45) * Math.PI / 2);
                        pointerPos = { x: pageW + (peekX - pageW) * e, y: pageH + (peekY - pageH) * e };
                    } else {
                        const e = 1 - Math.pow(1 - (t - 0.45) / 0.55, 2);
                        pointerPos = { x: peekX + (pageW - peekX) * e, y: peekY + (pageH - peekY) * e };
                    }
                    render();
                    if (t < 1) requestAnimationFrame(step);
                    else { isAnimating = false; flipDirection = 0; render(); }
                })(performance.now());
            }, 800);
        } catch (err) {
            ctx.clearRect(0, 0, pageW, pageH);
            ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, pageW, pageH);
            ctx.fillStyle = '#ff6b6b'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Error loading menu. Please refresh.', pageW / 2, pageH / 2);
            console.error(err);
        }
    }

    init();
})();
