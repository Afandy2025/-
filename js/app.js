(function () {
    'use strict';

    const PAGE_FILES = [
        'pages/عصير_Page_1.png',
        'pages/عصير_Page_2.png',
        'pages/عصير_Page_3.png',
        'pages/عصير_Page_4.png',
        'pages/عصير_Page_5.png'
    ];
    const A4_RATIO = 21 / 29.7;

    const canvas = document.getElementById('flipbook-canvas');
    const ctx = canvas.getContext('2d');
    const navLeft = document.getElementById('nav-left');
    const navRight = document.getElementById('nav-right');
    const pageIndicator = document.getElementById('page-indicator');

    let pages = [], currentPage = 0, totalPages = 0;
    let pageW = 0, pageH = 0, dpr = 1;
    let isDragging = false, isAnimating = false, flipDirection = 0;
    let cornerOrigin = { x: 0, y: 0 }, pointerPos = { x: 0, y: 0 };
    let audioCtx = null;

    // ─── Audio ───
    function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    function playFlipSound() {
        if (!audioCtx) return;
        try {
            const now = audioCtx.currentTime, sr = audioCtx.sampleRate;
            const g = audioCtx.createBuffer(1, Math.round(sr * 0.06), sr), gd = g.getChannelData(0);
            for (let i = 0; i < gd.length; i++) gd[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 60) * 0.22;
            const gs = audioCtx.createBufferSource(); gs.buffer = g;
            const gf = audioCtx.createBiquadFilter(); gf.type = 'bandpass'; gf.frequency.value = 3200; gf.Q.value = 1.2;
            gs.connect(gf).connect(audioCtx.destination); gs.start(now);
            const s = audioCtx.createBuffer(1, Math.round(sr * 0.28), sr), sd = s.getChannelData(0);
            for (let i = 0; i < sd.length; i++) { const t = i / sr; sd[i] = (Math.random() * 2 - 1) * Math.exp(-Math.pow((t - 0.08) / 0.06, 2)) * 0.14; }
            for (let p = 0; p < 3; p++) for (let i = 1; i < sd.length - 1; i++) sd[i] = (sd[i - 1] + sd[i] * 2 + sd[i + 1]) / 4;
            const ss = audioCtx.createBufferSource(); ss.buffer = s;
            const sf = audioCtx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 2500;
            ss.connect(sf).connect(audioCtx.destination); ss.start(now + 0.02);
            const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 75;
            const og = audioCtx.createGain(); og.gain.setValueAtTime(0, now + 0.2);
            og.gain.linearRampToValueAtTime(0.07, now + 0.22); og.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
            o.connect(og).connect(audioCtx.destination); o.start(now + 0.2); o.stop(now + 0.4);
        } catch (_) { }
    }

    function loadImages() {
        return Promise.all(PAGE_FILES.map(src => new Promise((resolve, reject) => {
            const img = new Image(); img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed: ' + src)); img.src = src;
        })));
    }

    function calculateDimensions() {
        const vw = window.innerWidth, vh = window.innerHeight, mob = vw <= 768;
        let tw = mob ? vw * 0.93 : vw * 0.85, th = tw / A4_RATIO;
        if (th > vh * 0.88) { th = vh * 0.88; tw = th * A4_RATIO; }
        pageW = Math.round(Math.max(tw, 260)); pageH = Math.round(pageW / A4_RATIO);
        dpr = window.devicePixelRatio || 1;
        canvas.width = pageW * dpr; canvas.height = pageH * dpr;
        canvas.style.width = pageW + 'px'; canvas.style.height = pageH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ─── Fold Geometry ───
    // Fold line = perpendicular bisector of Corner→Pointer
    // fnx,fny = normal pointing toward the corner (the folded-away side)
    function computeFold(corner, pointer) {
        const dx = pointer.x - corner.x, dy = pointer.y - corner.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) return null;
        return {
            mx: (corner.x + pointer.x) / 2, my: (corner.y + pointer.y) / 2,
            fdx: -dy / dist, fdy: dx / dist,
            fnx: -dx / dist, fny: -dy / dist,
            dist
        };
    }

    function constrainPointer(corner, ptr) {
        let px = ptr.x, py = ptr.y;
        const m = 30;
        const mmx = (corner.x + px) / 2, mmy = (corner.y + py) / 2;
        if (mmx < -m) px = -2 * m - corner.x; if (mmx > pageW + m) px = 2 * (pageW + m) - corner.x;
        if (mmy < -m) py = -2 * m - corner.y; if (mmy > pageH + m) py = 2 * (pageH + m) - corner.y;
        return { x: px, y: py };
    }

    // Clip to one half of the fold line. cornerSide=true → side containing the corner
    // Bezier bow always curves toward KEPT side (away from corner)
    function clipFold(f, cornerSide, curv) {
        const sign = cornerSide ? 1 : -1;
        const ext = (pageW + pageH) * 2;
        const lx1 = f.mx - f.fdx * ext, ly1 = f.my - f.fdy * ext;
        const lx2 = f.mx + f.fdx * ext, ly2 = f.my + f.fdy * ext;
        const ox = f.fnx * ext * sign, oy = f.fny * ext * sign;
        // Control point bows toward KEPT side (away from corner normal)
        const cpx = f.mx - f.fnx * curv, cpy = f.my - f.fny * curv;
        ctx.beginPath();
        ctx.moveTo(lx1, ly1);
        if (curv > 0.5) ctx.quadraticCurveTo(cpx, cpy, lx2, ly2);
        else ctx.lineTo(lx2, ly2);
        ctx.lineTo(lx2 + ox, ly2 + oy);
        ctx.lineTo(lx1 + ox, ly1 + oy);
        ctx.closePath();
        ctx.clip();
    }

    // Reflect coordinates across the fold line
    function reflectAcrossFold(f) {
        const nx = f.fnx, ny = f.fny, d = nx * f.mx + ny * f.my;
        ctx.transform(1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny, 2 * nx * d, 2 * ny * d);
    }

    // ─── Rendering ───
    function render() {
        ctx.clearRect(0, 0, pageW, pageH);
        if (totalPages === 0) return;
        if (isDragging || isAnimating) renderCurl();
        else drawPage(currentPage);
    }

    function drawPage(idx) {
        if (idx >= 0 && idx < totalPages) ctx.drawImage(pages[idx], 0, 0, pageW, pageH);
        else { ctx.fillStyle = '#f5f0e8'; ctx.fillRect(0, 0, pageW, pageH); }
    }

    function renderCurl() {
        const cPtr = constrainPointer(cornerOrigin, pointerPos);
        const f = computeFold(cornerOrigin, cPtr);
        if (!f) { drawPage(currentPage); return; }

        const diag = Math.sqrt(pageW * pageW + pageH * pageH);
        const progress = Math.min(1, f.dist / diag);
        const curv = Math.sin(progress * Math.PI) * pageW * 0.06;
        const revealIdx = flipDirection === 1 ? currentPage + 1 : currentPage - 1;

        // ── Layer 1: Revealed (next/prev) page — CORNER side (underneath fold) ──
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
        clipFold(f, true, curv);
        drawPage(revealIdx);
        // Shadow on revealed page from the lifted page
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

        // ── Layer 2: Current page — KEPT side (not yet peeled) ──
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
        clipFold(f, false, curv);
        drawPage(currentPage);
        ctx.restore();

        // ── Layer 3: Curl back — on KEPT side, overlapping current page near fold ──
        // The curl back = reflection of the folded (corner) portion across the fold.
        // It folds OVER onto the kept side, like a real page peeling.
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
        // Limit to KEPT side (the curl back folds over onto this side)
        clipFold(f, false, curv);

        ctx.save();
        reflectAcrossFold(f);
        // In reflected space, clip to page bounds + corner side (the folded portion)
        ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
        clipFold(f, true, curv);
        // Cream paper
        ctx.fillStyle = '#efe9df';
        ctx.fillRect(0, 0, pageW, pageH);
        ctx.globalAlpha = 0.05;
        drawPage(currentPage);
        ctx.globalAlpha = 1;
        ctx.restore();

        // Curvature shading on the curl back
        const cw = Math.max(20, f.dist * 0.5);
        const cg = ctx.createLinearGradient(
            f.mx - f.fnx * 1, f.my - f.fny * 1,
            f.mx - f.fnx * cw, f.my - f.fny * cw);
        cg.addColorStop(0, 'rgba(0,0,0,0.2)');
        cg.addColorStop(0.1, 'rgba(255,255,255,0.06)');
        cg.addColorStop(0.3, 'rgba(0,0,0,0.04)');
        cg.addColorStop(0.7, 'rgba(255,255,255,0.02)');
        cg.addColorStop(1, 'rgba(0,0,0,0.1)');
        ctx.fillStyle = cg;
        ctx.fillRect(-50, -50, pageW + 100, pageH + 100);
        ctx.restore();

        // ── Layer 4: Fold edge line ──
        if (progress > 0.01) {
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
            const ext = (pageW + pageH) * 2;
            const cpx = f.mx - f.fnx * curv, cpy = f.my - f.fny * curv;
            ctx.beginPath();
            ctx.moveTo(f.mx - f.fdx * ext, f.my - f.fdy * ext);
            if (curv > 0.5) ctx.quadraticCurveTo(cpx, cpy, f.mx + f.fdx * ext, f.my + f.fdy * ext);
            else ctx.lineTo(f.mx + f.fdx * ext, f.my + f.fdy * ext);
            ctx.strokeStyle = 'rgba(80,70,60,' + Math.min(0.3, progress * 0.4) + ')';
            ctx.lineWidth = Math.min(1.8, progress * 2.5);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(f.mx - f.fdx * ext - f.fnx * 1.5, f.my - f.fdy * ext - f.fny * 1.5);
            if (curv > 0.5) ctx.quadraticCurveTo(cpx - f.fnx * 1.5, cpy - f.fny * 1.5,
                f.mx + f.fdx * ext - f.fnx * 1.5, f.my + f.fdy * ext - f.fny * 1.5);
            else ctx.lineTo(f.mx + f.fdx * ext - f.fnx * 1.5, f.my + f.fdy * ext - f.fny * 1.5);
            ctx.strokeStyle = 'rgba(255,255,240,' + Math.min(0.15, progress * 0.2) + ')';
            ctx.lineWidth = 0.8;
            ctx.stroke();
            ctx.restore();
        }

        // ── Layer 5: Highlight on front page near fold ──
        if (progress > 0.015) {
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
            clipFold(f, false, curv);
            const hw = Math.min(25, pageW * progress * 0.12);
            const hg = ctx.createLinearGradient(
                f.mx - f.fnx * 1, f.my - f.fny * 1,
                f.mx - f.fnx * hw, f.my - f.fny * hw);
            hg.addColorStop(0, 'rgba(255,255,255,' + Math.min(0.14, progress * 0.18) + ')');
            hg.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = hg;
            ctx.fillRect(-50, -50, pageW + 100, pageH + 100);
            ctx.restore();
        }
    }

    // ─── Pointers ───
    function getPointerPos(e) {
        const r = canvas.getBoundingClientRect();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: (cx - r.left) * (pageW / r.width), y: (cy - r.top) * (pageH / r.height) };
    }

    function onPointerDown(e) {
        if (isAnimating) return;
        initAudio();
        const pos = getPointerPos(e), ez = pageW * 0.30;
        if (pos.x > pageW - ez && currentPage < totalPages - 1) {
            isDragging = true; flipDirection = 1;
            cornerOrigin = { x: pageW, y: pos.y > pageH / 2 ? pageH : 0 };
            pointerPos = { x: pos.x, y: pos.y };
            canvas.style.cursor = 'grabbing'; render(); return;
        }
        if (pos.x < ez && currentPage > 0) {
            isDragging = true; flipDirection = -1;
            cornerOrigin = { x: 0, y: pos.y > pageH / 2 ? pageH : 0 };
            pointerPos = { x: pos.x, y: pos.y };
            canvas.style.cursor = 'grabbing'; render(); return;
        }
    }

    function onPointerMove(e) {
        if (!isDragging) {
            const p = getPointerPos(e), ez = pageW * 0.30;
            canvas.style.cursor =
                ((p.x > pageW - ez && currentPage < totalPages - 1) || (p.x < ez && currentPage > 0)) ? 'grab' : 'default';
            return;
        }
        e.preventDefault(); pointerPos = getPointerPos(e); render();
    }

    function onPointerUp() {
        if (!isDragging) return;
        isDragging = false; canvas.style.cursor = 'default';
        const cPtr = constrainPointer(cornerOrigin, pointerPos);
        const f = computeFold(cornerOrigin, cPtr);
        const diag = Math.sqrt(pageW * pageW + pageH * pageH);
        const progress = f ? Math.min(1, f.dist / diag) : 0;
        if (progress > 0.18) animateComplete(); else animateSnapBack();
    }

    // ─── Animations ───
    function animateComplete() {
        isAnimating = true;
        const start = { x: pointerPos.x, y: pointerPos.y };
        const target = { x: cornerOrigin.x === pageW ? -pageW * 0.35 : pageW * 1.35, y: cornerOrigin.y };
        playFlipSound();
        const t0 = performance.now(), dur = 480;
        function step(now) {
            const t = Math.min((now - t0) / dur, 1), e = 1 - Math.pow(1 - t, 3);
            pointerPos = { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e };
            render();
            if (t < 1) requestAnimationFrame(step);
            else { currentPage += flipDirection; isAnimating = false; flipDirection = 0; render(); updateUI(); }
        }
        requestAnimationFrame(step);
    }

    function animateSnapBack() {
        isAnimating = true;
        const start = { x: pointerPos.x, y: pointerPos.y }, target = { x: cornerOrigin.x, y: cornerOrigin.y };
        const t0 = performance.now(), dur = 320;
        function step(now) {
            const t = Math.min((now - t0) / dur, 1);
            const e = Math.min(1, 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 0.3));
            pointerPos = { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e };
            render();
            if (t < 1) requestAnimationFrame(step);
            else { isAnimating = false; flipDirection = 0; render(); }
        }
        requestAnimationFrame(step);
    }

    function autoFlip(dir) {
        if (isAnimating || isDragging) return;
        if (currentPage + dir < 0 || currentPage + dir >= totalPages) return;
        initAudio(); flipDirection = dir;
        cornerOrigin = { x: dir === 1 ? pageW : 0, y: pageH };
        pointerPos = { x: dir === 1 ? pageW - 3 : 3, y: pageH - 3 };
        animateComplete();
    }

    function updateUI() {
        pageIndicator.textContent = (currentPage + 1) + ' / ' + totalPages;
        navLeft.classList.toggle('disabled', currentPage <= 0);
        navRight.classList.toggle('disabled', currentPage >= totalPages - 1);
    }

    function bindEvents() {
        canvas.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        canvas.addEventListener('touchstart', onPointerDown, { passive: true });
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);
        navLeft.addEventListener('click', () => autoFlip(-1));
        navRight.addEventListener('click', () => autoFlip(1));
        document.addEventListener('keydown', e => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') autoFlip(1);
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') autoFlip(-1);
        });
        window.addEventListener('resize', () => { calculateDimensions(); render(); });
    }

    async function init() {
        calculateDimensions();
        ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, pageW, pageH);
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '15px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Loading menu…', pageW / 2, pageH / 2);
        try {
            pages = await loadImages(); totalPages = pages.length;
            render(); updateUI(); bindEvents();
            setTimeout(() => {
                if (isAnimating || isDragging) return;
                flipDirection = 1; cornerOrigin = { x: pageW, y: pageH }; isAnimating = true;
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
            ctx.clearRect(0, 0, pageW, pageH); ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, pageW, pageH);
            ctx.fillStyle = '#ff6b6b'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Error loading menu. Please refresh.', pageW / 2, pageH / 2);
            console.error(err);
        }
    }

    init();
})();
