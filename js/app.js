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

    const A4_WIDTH = 21;
    const A4_HEIGHT = 29.7;
    const A4_RATIO = A4_WIDTH / A4_HEIGHT; // ~0.7071

    // ─── DOM Elements ───
    const canvas = document.getElementById('flipbook-canvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('flipbook-container');
    const navLeft = document.getElementById('nav-left');
    const navRight = document.getElementById('nav-right');
    const pageIndicator = document.getElementById('page-indicator');

    // ─── State ───
    let pages = [];
    let currentPage = 0;
    let totalPages = 0;

    // Flip animation state
    let isFlipping = false;
    let isDragging = false;
    let flipProgress = 0; // 0 = no flip, 1 = fully flipped
    let flipDirection = 0; // 1 = forward, -1 = backward
    let dragStartX = 0;
    let dragCurrentX = 0;
    let animationId = null;

    // Dimensions
    let pageW = 0;
    let pageH = 0;
    let canvasW = 0;
    let canvasH = 0;

    // ─── Audio: Paper flip sound via Web Audio API ───
    let audioCtx = null;

    function initAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    function playFlipSound() {
        if (!audioCtx) return;
        try {
            const now = audioCtx.currentTime;

            // Layer 1: Initial crisp "grab" — short burst of filtered noise
            const grabLen = Math.round(audioCtx.sampleRate * 0.06);
            const grabBuf = audioCtx.createBuffer(1, grabLen, audioCtx.sampleRate);
            const grabData = grabBuf.getChannelData(0);
            for (let i = 0; i < grabLen; i++) {
                const t = i / audioCtx.sampleRate;
                const env = Math.exp(-t * 60) * 0.25;
                grabData[i] = (Math.random() * 2 - 1) * env;
            }
            const grabSrc = audioCtx.createBufferSource();
            grabSrc.buffer = grabBuf;
            const grabFilter = audioCtx.createBiquadFilter();
            grabFilter.type = 'bandpass';
            grabFilter.frequency.value = 3000;
            grabFilter.Q.value = 1.5;
            grabSrc.connect(grabFilter);
            grabFilter.connect(audioCtx.destination);
            grabSrc.start(now);

            // Layer 2: Paper sliding swoosh — longer filtered noise
            const swooshLen = Math.round(audioCtx.sampleRate * 0.25);
            const swooshBuf = audioCtx.createBuffer(1, swooshLen, audioCtx.sampleRate);
            const swooshData = swooshBuf.getChannelData(0);
            for (let i = 0; i < swooshLen; i++) {
                const t = i / audioCtx.sampleRate;
                // Bell-shaped envelope peaking at ~0.08s
                const env = Math.exp(-Math.pow((t - 0.08) / 0.06, 2)) * 0.15;
                swooshData[i] = (Math.random() * 2 - 1) * env;
            }
            // Smooth the noise for softer paper texture
            for (let pass = 0; pass < 3; pass++) {
                for (let i = 1; i < swooshLen - 1; i++) {
                    swooshData[i] = (swooshData[i - 1] + swooshData[i] * 2 + swooshData[i + 1]) / 4;
                }
            }
            const swooshSrc = audioCtx.createBufferSource();
            swooshSrc.buffer = swooshBuf;
            const swooshFilter = audioCtx.createBiquadFilter();
            swooshFilter.type = 'lowpass';
            swooshFilter.frequency.value = 2500;
            swooshSrc.connect(swooshFilter);
            swooshFilter.connect(audioCtx.destination);
            swooshSrc.start(now + 0.02);

            // Layer 3: Soft thump when page lands
            const thumpOsc = audioCtx.createOscillator();
            thumpOsc.type = 'sine';
            thumpOsc.frequency.value = 80;
            const thumpGain = audioCtx.createGain();
            thumpGain.gain.setValueAtTime(0, now + 0.18);
            thumpGain.gain.linearRampToValueAtTime(0.08, now + 0.2);
            thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
            thumpOsc.connect(thumpGain);
            thumpGain.connect(audioCtx.destination);
            thumpOsc.start(now + 0.18);
            thumpOsc.stop(now + 0.35);
        } catch (e) {
            // Silently fail
        }
    }

    // ─── Image Loading ───
    function loadImages() {
        return Promise.all(
            PAGE_FILES.map(src => {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = () => reject(new Error(`Failed to load: ${src}`));
                    img.src = src;
                });
            })
        );
    }

    // ─── Sizing ───
    function calculateDimensions() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const isMobile = vw <= 768;

        // Target 80% of viewport width on desktop, 95% on mobile
        let targetW = isMobile ? vw * 0.95 : vw * 0.80;
        let targetH = targetW / A4_RATIO;

        // Ensure it fits in viewport height (leave room for indicators)
        const maxH = vh * 0.88;
        if (targetH > maxH) {
            targetH = maxH;
            targetW = targetH * A4_RATIO;
        }

        pageW = Math.round(targetW);
        pageH = Math.round(targetH);
        canvasW = pageW;
        canvasH = pageH;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvasW * dpr;
        canvas.height = canvasH * dpr;
        canvas.style.width = canvasW + 'px';
        canvas.style.height = canvasH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ─── Rendering ───
    function render() {
        ctx.clearRect(0, 0, canvasW, canvasH);

        if (totalPages === 0) return;

        // Draw current page (base layer)
        drawPage(currentPage, 0, 0, pageW, pageH);

        // Draw flip animation if active
        if ((isFlipping || isDragging) && flipProgress > 0) {
            drawFlipEffect();
        }
    }

    function drawPage(index, x, y, w, h) {
        if (index < 0 || index >= totalPages) {
            // Draw blank page
            ctx.fillStyle = '#f5f0e8';
            ctx.fillRect(x, y, w, h);
            return;
        }
        ctx.drawImage(pages[index], x, y, w, h);
    }

    function drawFlipEffect() {
        const progress = flipProgress;
        const dir = flipDirection;

        // The page being flipped
        const flippingPageIndex = dir === 1 ? currentPage : currentPage - 1;
        // The page revealed underneath
        const underPageIndex = dir === 1 ? currentPage + 1 : currentPage - 1;

        if (dir === -1 && currentPage <= 0 && !isDragging) return;
        if (dir === 1 && currentPage >= totalPages - 1 && !isDragging) return;

        ctx.save();

        // Calculate fold position
        const foldX = dir === 1
            ? pageW * (1 - progress)
            : pageW * progress;

        // Draw the page underneath (revealed page)
        ctx.save();
        ctx.beginPath();
        if (dir === 1) {
            ctx.rect(foldX, 0, pageW - foldX, pageH);
        } else {
            ctx.rect(0, 0, foldX, pageH);
        }
        ctx.clip();
        if (underPageIndex >= 0 && underPageIndex < totalPages) {
            drawPage(underPageIndex, 0, 0, pageW, pageH);
        } else {
            ctx.fillStyle = '#f5f0e8';
            ctx.fillRect(0, 0, pageW, pageH);
        }

        // Shadow on revealed page
        const shadowWidth = Math.min(40, pageW * progress * 0.15);
        if (dir === 1) {
            const grad = ctx.createLinearGradient(foldX, 0, foldX + shadowWidth, 0);
            grad.addColorStop(0, 'rgba(0,0,0,0.3)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(foldX, 0, shadowWidth, pageH);
        } else {
            const grad = ctx.createLinearGradient(foldX, 0, foldX - shadowWidth, 0);
            grad.addColorStop(0, 'rgba(0,0,0,0.3)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(foldX - shadowWidth, 0, shadowWidth, pageH);
        }
        ctx.restore();

        // Draw the flipping page with curl effect
        ctx.save();

        // Curl width proportional to progress
        const curlWidth = pageW * progress;
        const curlAmount = Math.sin(progress * Math.PI) * 0.15; // bend intensity

        if (dir === 1) {
            // Forward flip: page curls from right to left
            ctx.beginPath();
            ctx.moveTo(foldX, 0);

            // Top edge with curve
            const topCurveX = foldX + curlWidth * 0.5;
            const topCurveControlX = foldX + curlWidth * curlAmount;
            ctx.quadraticCurveTo(topCurveControlX, -pageH * curlAmount * 0.3, foldX + curlWidth, 0);

            // Right edge
            ctx.lineTo(foldX + curlWidth, pageH);

            // Bottom edge with curve
            ctx.quadraticCurveTo(topCurveControlX, pageH + pageH * curlAmount * 0.3, foldX, pageH);

            ctx.closePath();
            ctx.clip();

            // Draw the back of the flipping page (paper-white back)
            ctx.save();
            // Cream/off-white paper back
            ctx.fillStyle = '#f5f0e8';
            ctx.fillRect(foldX, 0, curlWidth, pageH);
            // Subtle paper texture using a light gradient
            const backGrad = ctx.createLinearGradient(foldX, 0, foldX + curlWidth, 0);
            backGrad.addColorStop(0, 'rgba(200,190,175,0.12)');
            backGrad.addColorStop(0.5, 'rgba(255,255,250,0.05)');
            backGrad.addColorStop(1, 'rgba(180,170,155,0.15)');
            ctx.fillStyle = backGrad;
            ctx.fillRect(foldX, 0, curlWidth, pageH);
            ctx.restore();

            // Paper texture gradient on curled page
            const curlGrad = ctx.createLinearGradient(foldX, 0, foldX + curlWidth, 0);
            curlGrad.addColorStop(0, 'rgba(0,0,0,0.08)');
            curlGrad.addColorStop(0.3, 'rgba(255,255,255,0.1)');
            curlGrad.addColorStop(0.5, 'rgba(0,0,0,0.02)');
            curlGrad.addColorStop(0.7, 'rgba(255,255,255,0.08)');
            curlGrad.addColorStop(1, 'rgba(0,0,0,0.15)');
            ctx.fillStyle = curlGrad;
            ctx.fill();

        } else {
            // Backward flip: page curls from left to right
            const startX = foldX - curlWidth;
            ctx.beginPath();
            ctx.moveTo(foldX, 0);

            const controlX = foldX - curlWidth * curlAmount;
            ctx.quadraticCurveTo(controlX, -pageH * curlAmount * 0.3, startX, 0);
            ctx.lineTo(startX, pageH);
            ctx.quadraticCurveTo(controlX, pageH + pageH * curlAmount * 0.3, foldX, pageH);

            ctx.closePath();
            ctx.clip();

            // Draw the back of the flipping page (paper-white back)
            ctx.save();
            ctx.fillStyle = '#f5f0e8';
            ctx.fillRect(startX, 0, curlWidth, pageH);
            const backGrad2 = ctx.createLinearGradient(foldX, 0, startX, 0);
            backGrad2.addColorStop(0, 'rgba(200,190,175,0.12)');
            backGrad2.addColorStop(0.5, 'rgba(255,255,250,0.05)');
            backGrad2.addColorStop(1, 'rgba(180,170,155,0.15)');
            ctx.fillStyle = backGrad2;
            ctx.fillRect(startX, 0, curlWidth, pageH);
            ctx.restore();

            // Paper texture
            const curlGrad = ctx.createLinearGradient(foldX, 0, startX, 0);
            curlGrad.addColorStop(0, 'rgba(0,0,0,0.08)');
            curlGrad.addColorStop(0.3, 'rgba(255,255,255,0.1)');
            curlGrad.addColorStop(0.5, 'rgba(0,0,0,0.02)');
            curlGrad.addColorStop(1, 'rgba(0,0,0,0.15)');
            ctx.fillStyle = curlGrad;
            ctx.fill();
        }

        ctx.restore();
        ctx.restore();
    }

    // ─── Flip Animation ───
    function animateFlip(direction, fromProgress) {
        if (isFlipping) return;

        const targetPage = currentPage + direction;
        if (targetPage < 0 || targetPage >= totalPages) return;

        isFlipping = true;
        flipDirection = direction;
        const startProgress = fromProgress || 0;
        const startTime = performance.now();
        const duration = 400 * (1 - startProgress); // Faster if already dragged partway

        playFlipSound();

        function step(now) {
            const elapsed = now - startTime;
            const t = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const eased = 1 - Math.pow(1 - t, 3);
            flipProgress = startProgress + (1 - startProgress) * eased;

            render();

            if (t < 1) {
                animationId = requestAnimationFrame(step);
            } else {
                // Flip complete
                currentPage = targetPage;
                flipProgress = 0;
                isFlipping = false;
                flipDirection = 0;
                render();
                updateUI();
            }
        }

        animationId = requestAnimationFrame(step);
    }

    function animateSnapBack(fromProgress) {
        isFlipping = true;
        const startProgress = fromProgress;
        const startTime = performance.now();
        const duration = 300;

        function step(now) {
            const elapsed = now - startTime;
            const t = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            flipProgress = startProgress * (1 - eased);

            render();

            if (t < 1) {
                animationId = requestAnimationFrame(step);
            } else {
                flipProgress = 0;
                isFlipping = false;
                flipDirection = 0;
                isDragging = false;
                render();
            }
        }

        animationId = requestAnimationFrame(step);
    }

    // ─── Drag Interaction ───
    function getCanvasPos(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    }

    function onPointerDown(e) {
        if (isFlipping) return;
        initAudio();

        const pos = getCanvasPos(e);
        const edgeZone = pageW * 0.25; // 25% from each edge is drag zone

        if (pos.x > pageW - edgeZone && currentPage < totalPages - 1) {
            // Drag from right edge → flip forward
            isDragging = true;
            flipDirection = 1;
            dragStartX = pos.x;
            flipProgress = 0;
            canvas.style.cursor = 'grabbing';
        } else if (pos.x < edgeZone && currentPage > 0) {
            // Drag from left edge → flip backward
            isDragging = true;
            flipDirection = -1;
            dragStartX = pos.x;
            flipProgress = 0;
            canvas.style.cursor = 'grabbing';
        }
    }

    function onPointerMove(e) {
        if (!isDragging) {
            // Update cursor based on position
            const pos = getCanvasPos(e);
            const edgeZone = pageW * 0.25;
            if ((pos.x > pageW - edgeZone && currentPage < totalPages - 1) ||
                (pos.x < edgeZone && currentPage > 0)) {
                canvas.style.cursor = 'grab';
            } else {
                canvas.style.cursor = 'default';
            }
            return;
        }

        e.preventDefault();
        const pos = getCanvasPos(e);
        dragCurrentX = pos.x;

        const dragDelta = dragStartX - dragCurrentX;

        if (flipDirection === 1) {
            flipProgress = Math.max(0, Math.min(1, dragDelta / pageW));
        } else {
            flipProgress = Math.max(0, Math.min(1, -dragDelta / pageW));
        }

        render();
    }

    function onPointerUp(e) {
        if (!isDragging) return;
        isDragging = false;
        canvas.style.cursor = 'default';

        const threshold = 0.2;

        if (flipProgress > threshold) {
            // Complete the flip
            animateFlip(flipDirection, flipProgress);
        } else {
            // Snap back
            animateSnapBack(flipProgress);
        }
    }

    // ─── UI Updates ───
    function updateUI() {
        pageIndicator.textContent = `${currentPage + 1} / ${totalPages}`;

        navLeft.classList.toggle('disabled', currentPage <= 0);
        navRight.classList.toggle('disabled', currentPage >= totalPages - 1);
    }

    // ─── Event Listeners ───
    function bindEvents() {
        // Mouse events
        canvas.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);

        // Touch events
        canvas.addEventListener('touchstart', onPointerDown, { passive: true });
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);

        // Navigation arrows
        navLeft.addEventListener('click', () => {
            if (!isFlipping && currentPage > 0) {
                initAudio();
                animateFlip(-1, 0);
            }
        });

        navRight.addEventListener('click', () => {
            if (!isFlipping && currentPage < totalPages - 1) {
                initAudio();
                animateFlip(1, 0);
            }
        });

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                if (!isFlipping && currentPage < totalPages - 1) {
                    initAudio();
                    animateFlip(1, 0);
                }
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                if (!isFlipping && currentPage > 0) {
                    initAudio();
                    animateFlip(-1, 0);
                }
            }
        });

        // Resize
        window.addEventListener('resize', () => {
            calculateDimensions();
            render();
        });
    }

    // ─── Init ───
    async function init() {
        calculateDimensions();

        // Show loading state
        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, 0, canvasW, canvasH);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Loading menu...', canvasW / 2, canvasH / 2);

        try {
            pages = await loadImages();
            totalPages = pages.length;
            currentPage = 0;

            render();
            updateUI();
            bindEvents();
        } catch (err) {
            ctx.clearRect(0, 0, canvasW, canvasH);
            ctx.fillStyle = '#2a2a2a';
            ctx.fillRect(0, 0, canvasW, canvasH);
            ctx.fillStyle = '#ff6b6b';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Error loading menu pages. Please refresh.', canvasW / 2, canvasH / 2);
            console.error(err);
        }
    }

    init();
})();
