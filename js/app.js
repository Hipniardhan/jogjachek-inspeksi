(() => {
    const toolbarViewportAnchor =
        document.getElementById('toolbarViewportAnchor');
    const toolbarElement =
        toolbarViewportAnchor?.querySelector('.toolbar');
    const form = document.getElementById('inspectionForm');
    const fileSlotSelect = document.getElementById('fileSlotSelect');
    const draftState = document.getElementById('draftState');
    const ACTIVE_FILE_SLOT_KEY = 'rtech-inspection-active-file-slot';
    const DAILY_RECAP_STORAGE_KEY = 'rtech-inspection-daily-recap';
    const DAILY_RECAP_MONTHLY_RESET_KEY = 'rtech-inspection-recap-last-monthly-reset';
    const fileSlots = ['1', '2', '3'];
    const annotationRadius = 4;
    const annotationTextOffset = 16;
    const paperWidthPx = 210.08 * 96 / 25.4;
    const mobileToolbarQuery =
        window.matchMedia('(max-width: 820px)');
    const mobileSheetQuery = mobileToolbarQuery;
    const mobileScreenMargin = 34;
    const mobileScreenScaleFactor = 0.92;
    let mode = 'mark';
    let marks = [];
    let annotationIdCounter = 0;
    let activeAnnotationDrag = null;
    let suppressAnnotationClick = false;
    let undoStack = [];
    let currentSnapshot = null;
    let currentSnapshotKey = '';
    let saveTimer = null;
    let pendingNumberInput = null;
    let toolbarViewportFrame = null;
    let dailyRecap = [];
    const checklistClickState = new WeakMap();
    const isStandalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true;
    const isLocalhost =
        ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

    document.documentElement.classList.toggle('is-standalone', isStandalone);

    if ('serviceWorker' in navigator && isLocalhost) {
        window.addEventListener('load', async () => {
            try {
                const registrations = await navigator.serviceWorker.getRegistrations();

                await Promise.all(
                    registrations
                        .filter((registration) => registration.scope.startsWith(window.location.origin))
                        .map((registration) => registration.unregister())
                );
            } catch (error) {
                console.error('Service worker unregister failed:', error);
            }
        });
    } else if ('serviceWorker' in navigator) {
        window.addEventListener('load', async () => {
            try {
                const registration = await navigator.serviceWorker.register('./service-worker.js');

                console.log('Service worker registered:', registration.scope);
            } catch (error) {
                console.error('Service worker registration failed:', error);
            }
        });
    }

    function updateSheetScreenScale() {
        const viewportWidth =
            document.documentElement.clientWidth ||
            window.innerWidth;

        const availableWidth = Math.max(
            viewportWidth - mobileScreenMargin,
            1
        );

        /*
        * Lebar kertas tetap A4.
        * Hanya skalanya yang menyesuaikan layar.
        */
        const scale = mobileSheetQuery.matches
            ? Math.min(1, (availableWidth / paperWidthPx) * mobileScreenScaleFactor)
            : 1;

        document.documentElement.style.setProperty(
            '--sheet-screen-scale',
            scale.toFixed(5)
        );
    }

    function resetToolbarViewportPosition() {
        if (!toolbarViewportAnchor) {
            return;
        }

        toolbarViewportAnchor.style.removeProperty('transform');
        toolbarViewportAnchor.style.removeProperty('width');
    }

    function updateMobileToolbarHeight() {
        if (!toolbarElement) {
            return;
        }

        const toolbarHeight = toolbarElement.offsetHeight;

        document.documentElement.style.setProperty(
            '--mobile-toolbar-height',
            `${toolbarHeight}px`
        );
    }

    function syncToolbarWithVisualViewport() {
        if (!toolbarViewportAnchor) {
            return;
        }

        if (!mobileToolbarQuery.matches) {
            resetToolbarViewportPosition();
            updateMobileToolbarHeight();
            return;
        }

        const viewport = window.visualViewport;

        if (!viewport) {
            toolbarViewportAnchor.style.transform =
                'translate3d(0, 0, 0) scale(1)';

            toolbarViewportAnchor.style.width = '100vw';

            updateMobileToolbarHeight();

            return;
        }

        const scale =
            Number.isFinite(viewport.scale) &&
            viewport.scale > 0
                ? viewport.scale
                : 1;

        const inverseScale = 1 / scale;

        const offsetLeft =
            Number.isFinite(viewport.offsetLeft)
                ? viewport.offsetLeft
                : 0;

        const offsetTop =
            Number.isFinite(viewport.offsetTop)
                ? viewport.offsetTop
                : 0;

        toolbarViewportAnchor.style.width = '100vw';

        toolbarViewportAnchor.style.transform =
            `translate3d(${offsetLeft}px, ${offsetTop}px, 0) ` +
            `scale(${inverseScale})`;

        updateMobileToolbarHeight();
    }

    function requestToolbarViewportSync() {
        if (toolbarViewportFrame !== null) {
            return;
        }

        toolbarViewportFrame =
            window.requestAnimationFrame(() => {
                toolbarViewportFrame = null;
                syncToolbarWithVisualViewport();
            });
    }

    function getChecklistFieldFromTarget(target) {
        if (!(target instanceof Element)) {
            return null;
        }

        if (
            target.closest(
                'textarea, input[type="text"], input[type="number"], select, button, a'
            )
        ) {
            return null;
        }

        const directField = target.closest('input[type="radio"], input[type="checkbox"]');

        if (directField && form.contains(directField)) {
            return directField;
        }

        const label = target.closest('label');

        if (label && form.contains(label)) {
            const labelField = label.querySelector('input[type="radio"], input[type="checkbox"]');

            if (labelField) {
                return labelField;
            }
        }

        const cell = target.closest('td, th');

        if (!cell || !form.contains(cell)) {
            return null;
        }

        return cell.querySelector('input[type="radio"], input[type="checkbox"]');
    }

    function beginPrintMode() {
        document.documentElement.classList.toggle('mobile-print', mobileSheetQuery.matches);
        document.documentElement.style.setProperty('--sheet-screen-scale', '1');
    }

    function endPrintMode() {
        document.documentElement.classList.remove('mobile-print');
        updateSheetScreenScale();
    }

    function setMode(nextMode) {
        commitPendingNumberInput();
        mode = nextMode === 'erase' && mode === 'erase' ? 'mark' : nextMode;
        document.querySelectorAll('[data-mark-mode]').forEach((button) => {
            button.classList.toggle('active', button.dataset.markMode === mode);
        });
        document.querySelectorAll('.mark-surface').forEach((surface) => {
            surface.style.cursor = mode === 'erase' ? 'not-allowed' : (mode === 'number' ? 'text' : 'crosshair');
        });

        if (mode === 'erase') {
            draftState.textContent = 'Mode hapus aktif';
        } else if (nextMode === 'erase') {
            draftState.textContent = 'Mode lingkar aktif';
        }
    }

    function createAnnotationId() {
        annotationIdCounter += 1;
        return `annotation-${Date.now().toString(36)}-${annotationIdCounter.toString(36)}`;
    }

    function clampPercent(value, min = 0, max = 100) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return min;
        }

        return Math.min(max, Math.max(min, Number(number.toFixed(2))));
    }

    function getDefaultAnnotationTextPoint(circleX, circleY) {
        const horizontalOffset = circleX > 72 ? -annotationTextOffset : annotationTextOffset;
        const verticalOffset = circleY > 78 ? -10 : 10;

        return {
            x: clampPercent(circleX + horizontalOffset, 8, 92),
            y: clampPercent(circleY + verticalOffset, 8, 92),
        };
    }

    function normalizeMark(mark) {
        if (!mark || !mark.view) {
            return null;
        }

        if ((mark.type || 'circle') === 'number') {
            return {
                type: 'number',
                view: mark.view,
                x: clampPercent(mark.x),
                y: clampPercent(mark.y),
                value: sanitizeNumber(mark.value),
            };
        }

        const circleX = clampPercent(mark.circleX ?? mark.x);
        const circleY = clampPercent(mark.circleY ?? mark.y);
        const textPoint = getDefaultAnnotationTextPoint(circleX, circleY);

        return {
            type: 'annotation',
            id: mark.id || createAnnotationId(),
            view: mark.view,
            circleX,
            circleY,
            circleRadius: clampPercent(mark.circleRadius ?? annotationRadius, 1.6, 10),
            textX: clampPercent(mark.textX ?? textPoint.x, 6, 94),
            textY: clampPercent(mark.textY ?? textPoint.y, 6, 94),
            text: String(mark.text || ''),
        };
    }

    function getAnnotationLinePoints(mark) {
        const dx = mark.textX - mark.circleX;
        const dy = mark.textY - mark.circleY;
        const distance = Math.hypot(dx, dy) || 1;
        const circleOffset = mark.circleRadius + 0.7;
        const textOffset = 1.8;

        return {
            x1: clampPercent(mark.circleX + (dx / distance) * circleOffset),
            y1: clampPercent(mark.circleY + (dy / distance) * circleOffset),
            x2: clampPercent(mark.textX - (dx / distance) * textOffset),
            y2: clampPercent(mark.textY - (dy / distance) * textOffset),
        };
    }

    function setAnnotationLineAttributes(line, mark) {
        const points = getAnnotationLinePoints(mark);
        line.setAttribute('x1', `${points.x1}%`);
        line.setAttribute('y1', `${points.y1}%`);
        line.setAttribute('x2', `${points.x2}%`);
        line.setAttribute('y2', `${points.y2}%`);
    }

    function autoGrowAnnotationText(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.max(textarea.scrollHeight, 26)}px`;
    }

    function enterAnnotationEdit(textarea) {
        if (!textarea) {
            return;
        }

        textarea.readOnly = false;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        autoGrowAnnotationText(textarea);
    }

    function updateAnnotationElements(surface, index, mark) {
        const circle = surface.querySelector(`.annotation-circle[data-index="${index}"]`);
        const line = surface.querySelector(`.annotation-arrow[data-index="${index}"]`);
        const box = surface.querySelector(`.annotation-box[data-index="${index}"]`);

        if (circle) {
            circle.setAttribute('cx', `${mark.circleX}%`);
            circle.setAttribute('cy', `${mark.circleY}%`);
            circle.setAttribute('r', `${mark.circleRadius}%`);
        }

        if (line) {
            setAnnotationLineAttributes(line, mark);
        }

        if (box) {
            box.style.setProperty('--text-x', `${mark.textX}%`);
            box.style.setProperty('--text-y', `${mark.textY}%`);
        }
    }

    function deleteAnnotation(index) {
        if (!marks[index]) {
            return;
        }

        removePendingNumberInput();
        marks.splice(index, 1);
        renderMarks();
        recordHistoryChange();
    }

    function beginAnnotationDrag(event, index, dragType) {
        if (event.button !== undefined && event.button !== 0) {
            return;
        }

        const mark = marks[index];

        if (!mark || mark.type !== 'annotation') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        activeAnnotationDrag = {
            index,
            dragType,
            surface: event.currentTarget.closest('.mark-surface'),
            pointerId: event.pointerId,
            captureTarget: event.currentTarget,
            startClientX: event.clientX,
            startClientY: event.clientY,
            moved: false,
        };

        if (event.currentTarget.setPointerCapture) {
            event.currentTarget.setPointerCapture(event.pointerId);
        }

        window.addEventListener('pointermove', moveAnnotationDrag);
        window.addEventListener('pointerup', finishAnnotationDrag);
        window.addEventListener('pointercancel', finishAnnotationDrag);
    }

    function moveAnnotationDrag(event) {
        if (!activeAnnotationDrag || event.pointerId !== activeAnnotationDrag.pointerId) {
            return;
        }

        event.preventDefault();

        const mark = marks[activeAnnotationDrag.index];

        if (!mark || mark.type !== 'annotation') {
            return;
        }

        if (
            !activeAnnotationDrag.moved &&
            Math.hypot(
                event.clientX - activeAnnotationDrag.startClientX,
                event.clientY - activeAnnotationDrag.startClientY
            ) < 4
        ) {
            return;
        }

        const point = getSurfacePoint(event, activeAnnotationDrag.surface);
        activeAnnotationDrag.moved = true;

        if (activeAnnotationDrag.dragType === 'circle') {
            mark.circleX = clampPercent(point.x, 0, 100);
            mark.circleY = clampPercent(point.y, 0, 100);
        } else {
            mark.textX = clampPercent(point.x, 6, 94);
            mark.textY = clampPercent(point.y, 6, 94);
        }

        updateAnnotationElements(activeAnnotationDrag.surface, activeAnnotationDrag.index, mark);
    }

    function finishAnnotationDrag(event) {
        if (!activeAnnotationDrag || event.pointerId !== activeAnnotationDrag.pointerId) {
            return;
        }

        if (
            activeAnnotationDrag.captureTarget.releasePointerCapture &&
            (!activeAnnotationDrag.captureTarget.hasPointerCapture ||
                activeAnnotationDrag.captureTarget.hasPointerCapture(activeAnnotationDrag.pointerId))
        ) {
            activeAnnotationDrag.captureTarget.releasePointerCapture(activeAnnotationDrag.pointerId);
        }

        window.removeEventListener('pointermove', moveAnnotationDrag);
        window.removeEventListener('pointerup', finishAnnotationDrag);
        window.removeEventListener('pointercancel', finishAnnotationDrag);

        const finishedDrag = activeAnnotationDrag;
        suppressAnnotationClick = finishedDrag.moved;

        if (finishedDrag.moved) {
            recordHistoryChange();
        } else if (event.type !== 'pointercancel') {
            enterAnnotationEdit(
                finishedDrag.surface.querySelector(`.annotation-text[data-index="${finishedDrag.index}"]`)
            );
        }

        activeAnnotationDrag = null;

        if (suppressAnnotationClick) {
            window.setTimeout(() => {
                suppressAnnotationClick = false;
            }, 0);
        }
    }

    function renderMarks() {
        document.querySelectorAll('.annotation-layer, .annotation-box, .number-mark').forEach((mark) => mark.remove());
        marks = marks.map(normalizeMark).filter(Boolean);

        document.querySelectorAll('.mark-surface').forEach((surface) => {
            const surfaceMarks = marks
                .map((mark, index) => ({ mark, index }))
                .filter((entry) => entry.mark.view === surface.dataset.view);

            const annotationMarks = surfaceMarks.filter((entry) => entry.mark.type === 'annotation');

            if (annotationMarks.length) {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                const markerId = `annotation-arrow-${surface.dataset.view}`;
                svg.classList.add('annotation-layer');

                const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                marker.setAttribute('id', markerId);
                marker.setAttribute('viewBox', '0 0 10 10');
                marker.setAttribute('refX', '9');
                marker.setAttribute('refY', '5');
                marker.setAttribute('markerWidth', '6');
                marker.setAttribute('markerHeight', '6');
                marker.setAttribute('orient', 'auto-start-reverse');

                const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                arrowHead.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
                arrowHead.classList.add('annotation-arrow-head');
                marker.appendChild(arrowHead);
                defs.appendChild(marker);
                svg.appendChild(defs);

                annotationMarks.forEach(({ mark, index }) => {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.classList.add('annotation-arrow');
                    line.dataset.index = String(index);
                    line.setAttribute('marker-end', `url(#${markerId})`);
                    setAnnotationLineAttributes(line, mark);
                    svg.appendChild(line);

                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.classList.add('annotation-circle');
                    circle.dataset.index = String(index);
                    circle.setAttribute('cx', `${mark.circleX}%`);
                    circle.setAttribute('cy', `${mark.circleY}%`);
                    circle.setAttribute('r', `${mark.circleRadius}%`);
                    circle.addEventListener('pointerdown', (event) => {
                        if (mode === 'erase') {
                            event.preventDefault();
                            event.stopPropagation();
                            deleteAnnotation(index);
                            return;
                        }

                        beginAnnotationDrag(event, index, 'circle');
                    });
                    circle.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();

                        if (suppressAnnotationClick) {
                            return;
                        }

                        enterAnnotationEdit(surface.querySelector(`.annotation-text[data-index="${index}"]`));
                    });
                    svg.appendChild(circle);
                });

                surface.appendChild(svg);
            }

            annotationMarks.forEach(({ mark, index }) => {
                const box = document.createElement('div');
                box.className = 'annotation-box';
                box.dataset.index = String(index);
                box.style.setProperty('--text-x', `${mark.textX}%`);
                box.style.setProperty('--text-y', `${mark.textY}%`);

                const textarea = document.createElement('textarea');
                textarea.className = 'annotation-text';
                textarea.dataset.index = String(index);
                textarea.value = mark.text;
                textarea.placeholder = 'Keterangan';
                textarea.rows = 1;
                textarea.readOnly = true;
                textarea.spellcheck = false;
                textarea.addEventListener('input', () => {
                    mark.text = textarea.value;
                    autoGrowAnnotationText(textarea);
                });
                textarea.addEventListener('blur', () => {
                    textarea.readOnly = true;
                });
                textarea.addEventListener('dblclick', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    enterAnnotationEdit(textarea);
                });

                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.className = 'annotation-delete';
                deleteButton.textContent = 'x';
                deleteButton.setAttribute('aria-label', 'Hapus anotasi');
                deleteButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    deleteAnnotation(index);
                });

                box.addEventListener('pointerdown', (event) => {
                    if (event.target === deleteButton) {
                        return;
                    }

                    if (mode === 'erase') {
                        event.preventDefault();
                        event.stopPropagation();
                        deleteAnnotation(index);
                        return;
                    }

                    if (!textarea.readOnly) {
                        return;
                    }

                    beginAnnotationDrag(event, index, 'text');
                });
                box.addEventListener('click', (event) => {
                    if (!textarea.readOnly) {
                        return;
                    }

                    event.preventDefault();
                    event.stopPropagation();

                    if (event.target === deleteButton || suppressAnnotationClick) {
                        return;
                    }

                    enterAnnotationEdit(textarea);
                });

                box.appendChild(textarea);
                box.appendChild(deleteButton);
                surface.appendChild(box);
                autoGrowAnnotationText(textarea);
            });

            surfaceMarks
                .filter((entry) => entry.mark.type === 'number')
                .forEach(({ mark, index }) => {
                    const element = document.createElement('button');
                    element.type = 'button';
                    element.className = 'number-mark';
                    element.dataset.index = String(index);
                    element.style.setProperty('--x', `${mark.x}%`);
                    element.style.setProperty('--y', `${mark.y}%`);
                    element.textContent = sanitizeNumber(mark.value);
                    element.title = `Angka ${element.textContent}`;
                    surface.appendChild(element);
                });
        });
    }

    function collectDraft() {
        const fields = {};
        form.querySelectorAll('input, textarea').forEach((field) => {
            if (!field.name) {
                return;
            }

            if ((field.type === 'radio' || field.type === 'checkbox') && !field.checked) {
                return;
            }

            fields[field.name] = field.type === 'checkbox' ? '1' : field.value;
        });

        return { fields, marks };
    }

    function cloneDraft(draft) {
        return {
            fields: { ...(draft.fields || {}) },
            marks: Array.isArray(draft.marks)
                ? draft.marks.map((mark) => ({ ...mark }))
                : [],
        };
    }

    function createSnapshot() {
        return cloneDraft(collectDraft());
    }

    function getOnlyDigits(value) {
        return String(value || '').replace(/\D/g, '');
    }

    function formatRupiahDigits(value) {
        const digits = getOnlyDigits(value);

        if (!digits) {
            return '';
        }

        return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }

    function formatNumberGroupToRupiah(numberText) {
        return formatRupiahDigits(numberText);
    }

    function formatRupiahFreeText(value) {
        const text = String(value || '');
        const cleaned = text
            .replace(/rp\.?/gi, '')
            .replace(/[^\d.,\-\s]/g, '');

        if (!cleaned.trim()) {
            return '';
        }

        const parts = cleaned.split('-');
        const formattedParts = parts.map((part) => formatNumberGroupToRupiah(part));
        const visibleParts = formattedParts.filter(Boolean);

        if (visibleParts.length === 0) {
            return '';
        }

        if (parts.length > 1 && formattedParts[0]) {
            const secondPart = formattedParts.slice(1).find(Boolean);

            return secondPart
                ? `${formattedParts[0]} - ${secondPart}`
                : `${formattedParts[0]} - `;
        }

        return visibleParts[0];
    }

    function applyEstimateRupiahFormat(input) {
        if (!input) {
            return;
        }

        input.value = formatRupiahFreeText(input.value);
    }

    function applyRupiahFormat(input) {
        if (!input) {
            return;
        }

        if (
            input.classList.contains('estimate-cost-input') &&
            !input.classList.contains('grand-total-input')
        ) {
            applyEstimateRupiahFormat(input);
            return;
        }

        input.value = formatRupiahDigits(input.value);
    }

    function formatAllRupiahInputs() {
        form.querySelectorAll('.rupiah-input').forEach(applyRupiahFormat);
    }

    function initRupiahInputs() {
        form.querySelectorAll('.rupiah-input').forEach((input) => {
            input.setAttribute('type', 'text');
            input.setAttribute('inputmode', 'numeric');
            input.setAttribute('autocomplete', 'off');

            applyRupiahFormat(input);

            if (input.dataset.rupiahReady === '1') {
                return;
            }

            input.dataset.rupiahReady = '1';

            input.addEventListener('input', () => {
                applyRupiahFormat(input);

                if (!input.classList.contains('estimate-cost-input')) {
                    scheduleSave();
                }
            });

            input.addEventListener('blur', () => {
                applyRupiahFormat(input);

                if (!input.classList.contains('estimate-cost-input')) {
                    scheduleSave();
                }
            });
        });
    }

    function parseEstimateAmount(value) {
        const text = String(value || '');
        const firstNumberMatch = text.match(/\d[\d.]*/);

        if (!firstNumberMatch) {
            return 0;
        }

        const normalized = firstNumberMatch[0].replace(/\D/g, '');

        return Number(normalized || 0);
    }

    function formatRupiahNumber(value) {
        const number = Number(value || 0);

        if (!number) {
            return '';
        }

        return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }

    function updateEstimateGrandTotal(shouldSave = true) {
        const estimateInputs = form.querySelectorAll(
            '.estimate-table .estimate-cost-input'
        );

        let total = 0;

        estimateInputs.forEach((input) => {
            total += parseEstimateAmount(input.value);
        });

        const grandTotalInput = form.querySelector('.grand-total-input');

        if (grandTotalInput) {
            grandTotalInput.value = formatRupiahNumber(total);
        }

        if (shouldSave) {
            scheduleSave();
        }
    }

    function initEstimateAutoTotal() {
        form.querySelectorAll('.estimate-table .estimate-cost-input').forEach((input) => {
            if (input.dataset.estimateTotalReady === '1') {
                return;
            }

            input.dataset.estimateTotalReady = '1';
            input.addEventListener('input', () => updateEstimateGrandTotal());
            input.addEventListener('blur', () => updateEstimateGrandTotal());
        });

        const grandTotalInput = form.querySelector('.grand-total-input');

        if (grandTotalInput) {
            grandTotalInput.readOnly = true;
        }

        updateEstimateGrandTotal(false);
    }

    function createDailyRecapId() {
        return `recap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function formatDateForRecap(date = new Date()) {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();

        return `${day}/${month}/${year}`;
    }

    function getMonthlyResetKey(date = new Date()) {
        const month = String(date.getMonth() + 1).padStart(2, '0');

        return `${date.getFullYear()}-${month}`;
    }

    function loadDailyRecap() {
        try {
            const storedRecap = JSON.parse(
                localStorage.getItem(DAILY_RECAP_STORAGE_KEY) || '[]'
            );

            dailyRecap = Array.isArray(storedRecap)
                ? storedRecap.map((entry) => ({
                    id: String(entry.id || createDailyRecapId()),
                    unitName: String(entry.unitName || ''),
                    inspectionDate: String(entry.inspectionDate || ''),
                    location: String(entry.location || ''),
                }))
                : [];
        } catch (error) {
            dailyRecap = [];
        }
    }

    function saveDailyRecap() {
        localStorage.setItem(DAILY_RECAP_STORAGE_KEY, JSON.stringify(dailyRecap));
    }

    function renderDailyRecap() {
        const recapBody = document.getElementById('dailyRecapBody');

        if (!recapBody) {
            return;
        }

        recapBody.textContent = '';

        if (dailyRecap.length === 0) {
            const emptyRow = document.createElement('tr');
            const emptyCell = document.createElement('td');

            emptyCell.colSpan = 5;
            emptyCell.className = 'daily-recap-empty';
            emptyCell.textContent = 'Belum ada data rekap.';
            emptyRow.appendChild(emptyCell);
            recapBody.appendChild(emptyRow);
            return;
        }

        dailyRecap.forEach((entry, index) => {
            const row = document.createElement('tr');
            const selectCell = document.createElement('td');
            const numberCell = document.createElement('td');
            const unitCell = document.createElement('td');
            const dateCell = document.createElement('td');
            const locationCell = document.createElement('td');
            const selectInput = document.createElement('input');
            const unitInput = document.createElement('input');
            const dateInput = document.createElement('input');
            const locationInput = document.createElement('input');

            selectCell.className = 'daily-recap-select-cell';
            selectInput.type = 'checkbox';
            selectInput.className = 'daily-recap-select';
            selectInput.dataset.recapId = entry.id;
            selectInput.setAttribute('aria-label', `Pilih rekap ${index + 1}`);
            selectCell.appendChild(selectInput);

            numberCell.className = 'daily-recap-no';
            numberCell.textContent = String(index + 1);

            unitInput.type = 'text';
            unitInput.className = 'daily-recap-input daily-recap-unit-input';
            unitInput.dataset.recapId = entry.id;
            unitInput.value = entry.unitName;
            unitInput.setAttribute('aria-label', `Nama Unit rekap ${index + 1}`);

            dateInput.type = 'text';
            dateInput.className = 'daily-recap-input daily-recap-date-input';
            dateInput.dataset.recapId = entry.id;
            dateInput.value = entry.inspectionDate;
            dateInput.setAttribute('aria-label', `Tanggal Inspeksi rekap ${index + 1}`);

            locationInput.type = 'text';
            locationInput.className = 'daily-recap-input daily-recap-location-input';
            locationInput.dataset.recapId = entry.id;
            locationInput.value = entry.location;
            locationInput.setAttribute('aria-label', `Lokasi rekap ${index + 1}`);

            unitCell.appendChild(unitInput);
            dateCell.appendChild(dateInput);
            locationCell.appendChild(locationInput);
            row.appendChild(selectCell);
            row.appendChild(numberCell);
            row.appendChild(unitCell);
            row.appendChild(dateCell);
            row.appendChild(locationCell);
            recapBody.appendChild(row);
        });
    }

    function createRecapId() {
        return createDailyRecapId();
    }

    function hasEmptyRecapUnitName() {
        loadDailyRecap();

        return dailyRecap.some((item) => !String(item.unitName || '').trim());
    }

    function addManualRecapRow() {
        loadDailyRecap();

        if (hasEmptyRecapUnitName()) {
            window.alert('Isi Nama Unit pada baris kosong terlebih dahulu.');
            return;
        }

        const newRow = {
            id: createRecapId(),
            unitName: '',
            inspectionDate: formatDateForRecap(),
            location: '',
        };

        dailyRecap.push(newRow);
        saveDailyRecap();
        renderDailyRecap();

        window.requestAnimationFrame(() => {
            const input = document.querySelector(
                `.daily-recap-unit-input[data-recap-id="${CSS.escape(newRow.id)}"]`
            );

            input?.focus();
        });
    }

    function deleteSelectedRecapRows() {
        const selectedInputs = document.querySelectorAll(
            '.daily-recap-select:checked'
        );

        if (selectedInputs.length === 0) {
            window.alert('Pilih baris rekap yang ingin dihapus.');
            return;
        }

        const selectedIds = new Set(
            Array.from(selectedInputs).map((input) => input.dataset.recapId)
        );

        loadDailyRecap();
        dailyRecap = dailyRecap.filter((item) => !selectedIds.has(item.id));
        saveDailyRecap();
        renderDailyRecap();
    }

    function updateDailyRecapField(input) {
        const recapId = input.dataset.recapId;
        const item = dailyRecap.find((entry) => entry.id === recapId);

        if (!item) {
            return;
        }

        if (input.classList.contains('daily-recap-unit-input')) {
            item.unitName = input.value;
        } else if (input.classList.contains('daily-recap-date-input')) {
            item.inspectionDate = input.value;
        } else if (input.classList.contains('daily-recap-location-input')) {
            item.location = input.value;
        }

        saveDailyRecap();
    }

    function addCurrentInspectionToRecap({ quiet = false } = {}) {
        const unitField = form.querySelector('[name="merk_tipe"]');
        const inspectionDateField = form.querySelector('[name="waktu_inspeksi"]');
        const unitName = String(unitField?.value || '').trim();

        if (!unitName) {
            if (!quiet) {
                window.alert('Nama Unit belum diisi.');
            }

            return false;
        }

        dailyRecap.push({
            id: createDailyRecapId(),
            unitName,
            inspectionDate:
                String(inspectionDateField?.value || '').trim() ||
                formatDateForRecap(),
            location: '',
        });

        saveDailyRecap();
        renderDailyRecap();
        return true;
    }

    function getDraftDataBySlot(slot) {
        const raw = localStorage.getItem(getDraftStorageKey(slot));

        if (!raw) {
            return null;
        }

        try {
            return JSON.parse(raw);
        } catch (error) {
            console.error('Invalid draft data for slot', slot, error);
            return null;
        }
    }

    function getFieldValueFromDraftData(draftData, fieldName) {
        if (!draftData) {
            return '';
        }

        if (draftData.fields && fieldName in draftData.fields) {
            return String(draftData.fields[fieldName] || '').trim();
        }

        if (fieldName in draftData) {
            return String(draftData[fieldName] || '').trim();
        }

        return '';
    }

    function addAllFileSlotsToRecap() {
        saveDraft(getActiveFileSlot());
        loadDailyRecap();

        const recapRows = [];

        fileSlots.forEach((slot) => {
            const draftData = getDraftDataBySlot(slot);

            if (!draftData) {
                return;
            }

            const unitName = getFieldValueFromDraftData(draftData, 'merk_tipe');

            if (!unitName) {
                return;
            }

            recapRows.push({
                id: `${Date.now().toString(36)}-${slot}-${Math.random().toString(36).slice(2, 8)}`,
                unitName,
                inspectionDate:
                    getFieldValueFromDraftData(draftData, 'waktu_inspeksi') ||
                    formatDateForRecap(),
                location: '',
            });
        });

        if (recapRows.length === 0) {
            return 0;
        }

        dailyRecap = dailyRecap.concat(recapRows);
        saveDailyRecap();
        renderDailyRecap();

        return recapRows.length;
    }

    function runMonthlyRecapReset() {
        const now = new Date();
        const monthlyResetKey = getMonthlyResetKey(now);
        const lastMonthlyReset =
            localStorage.getItem(DAILY_RECAP_MONTHLY_RESET_KEY);

        if (
            now.getDate() !== 1 ||
            now.getHours() < 9 ||
            lastMonthlyReset === monthlyResetKey
        ) {
            return;
        }

        dailyRecap = [];
        localStorage.removeItem(DAILY_RECAP_STORAGE_KEY);
        localStorage.setItem(DAILY_RECAP_MONTHLY_RESET_KEY, monthlyResetKey);
    }
    function getActiveFileSlot() {
        const slot = localStorage.getItem(ACTIVE_FILE_SLOT_KEY);

        return fileSlots.includes(slot) ? slot : '1';
    }

    function setActiveFileSlot(slot) {
        const nextSlot = fileSlots.includes(slot) ? slot : '1';

        localStorage.setItem(ACTIVE_FILE_SLOT_KEY, nextSlot);
    }

    function getDraftStorageKey(slot = getActiveFileSlot()) {
        const targetSlot = fileSlots.includes(slot) ? slot : '1';

        return `rtech-inspection-draft-file-${targetSlot}`;
    }

    function applyDraft(draft) {
        const nextDraft = cloneDraft(draft);

        form.querySelectorAll('input, textarea').forEach((field) => {
            if (!field.name) {
                return;
            }

            if (field.type === 'radio' || field.type === 'checkbox') {
                field.checked = false;
                return;
            }

            field.value = '';
        });

        Object.entries(nextDraft.fields).forEach(([name, value]) => {
            const escapedName = CSS.escape(name);
            const escapedValue = CSS.escape(value);
            const checked = form.querySelector(`input[name="${escapedName}"][value="${escapedValue}"]`);

            if (checked && (checked.type === 'radio' || checked.type === 'checkbox')) {
                checked.checked = true;
                return;
            }

            const field = form.querySelector(`input[name="${escapedName}"]:not([type="radio"]):not([type="checkbox"]), textarea[name="${escapedName}"]`);

            if (field) {
                field.value = value;
            }
        });

        marks = nextDraft.marks;
        renderMarks();
        autoGrowAll();
        formatAllRupiahInputs();
        updateEstimateGrandTotal(false);
    }

    function clearCurrentFormViewWithoutDeletingStorage() {
        removePendingNumberInput();
        applyDraft({ fields: {}, marks: [] });
    }

    function setCurrentSnapshot(snapshot) {
        currentSnapshot = cloneDraft(snapshot);
        currentSnapshotKey = JSON.stringify(currentSnapshot);
    }

    function resetUndoHistory() {
        undoStack = [];
        setCurrentSnapshot(createSnapshot());
    }

    function recordHistoryChange() {
        const nextSnapshot = createSnapshot();
        const nextSnapshotKey = JSON.stringify(nextSnapshot);

        if (!currentSnapshot) {
            setCurrentSnapshot(nextSnapshot);
            scheduleSave();
            return;
        }

        if (nextSnapshotKey !== currentSnapshotKey) {
            undoStack.push(cloneDraft(currentSnapshot));

            if (undoStack.length > 80) {
                undoStack.shift();
            }

            currentSnapshot = nextSnapshot;
            currentSnapshotKey = nextSnapshotKey;
        }

        scheduleSave();
    }

    function undoLastChange() {
        commitPendingNumberInput();

        const previousSnapshot = undoStack.pop();

        if (!previousSnapshot) {
            draftState.textContent = 'Tidak ada perubahan untuk di-undo';
            return;
        }

        applyDraft(previousSnapshot);
        setCurrentSnapshot(previousSnapshot);
        saveDraft();
        draftState.textContent = 'Perubahan terakhir dibatalkan';
    }

    function saveDraft(slot = getActiveFileSlot()) {
        updateEstimateGrandTotal(false);
        formatAllRupiahInputs();
        clearTimeout(saveTimer);
        saveTimer = null;
        localStorage.setItem(getDraftStorageKey(slot), JSON.stringify(collectDraft()));
        draftState.textContent = `Draft File ${slot} tersimpan`;
    }

    function loadDraft(slot = getActiveFileSlot()) {
        const raw = localStorage.getItem(getDraftStorageKey(slot));

        clearCurrentFormViewWithoutDeletingStorage();

        if (!raw) {
            draftState.textContent = `File ${slot} kosong`;
            resetUndoHistory();
            return;
        }

        try {
            const draft = JSON.parse(raw);
            applyDraft(draft);
            draftState.textContent = `Draft File ${slot} dipulihkan`;
        } catch (error) {
            localStorage.removeItem(getDraftStorageKey(slot));
            draftState.textContent = `File ${slot} kosong`;
            resetUndoHistory();
            return;
        }

        resetUndoHistory();
    }

    function scheduleSave() {
        clearTimeout(saveTimer);
        const targetSlot = getActiveFileSlot();
        const targetStorageKey = getDraftStorageKey(targetSlot);

        saveTimer = setTimeout(() => {
            updateEstimateGrandTotal(false);
            formatAllRupiahInputs();
            localStorage.setItem(targetStorageKey, JSON.stringify(collectDraft()));
            draftState.textContent = `Draft File ${targetSlot} tersimpan`;
        }, 200);
    }

    function autoGrow(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.max(textarea.scrollHeight, 18)}px`;
    }

    function autoGrowAll() {
        form.querySelectorAll('textarea').forEach(autoGrow);
    }

    function sanitizeNumber(value) {
        let cleaned = String(value || '')
            .replace(/\./g, ',')
            .replace(/[^0-9,]/g, '');

        const commaIndex = cleaned.indexOf(',');

        if (commaIndex === -1) {
            return cleaned.slice(0, 2);
        }

        const integerPart = (cleaned.slice(0, commaIndex) || '0').slice(0, 2);
        const decimalPart = cleaned
            .slice(commaIndex + 1)
            .replace(/,/g, '')
            .slice(0, 2);

        return `${integerPart},${decimalPart}`;
    }

    function getSurfacePoint(event, surface) {
        const rect = surface.getBoundingClientRect();

        return {
            x: Number((((event.clientX - rect.left) / rect.width) * 100).toFixed(2)),
            y: Number((((event.clientY - rect.top) / rect.height) * 100).toFixed(2)),
        };
    }

    function removePendingNumberInput() {
        if (!pendingNumberInput) {
            return;
        }

        pendingNumberInput.remove();
        pendingNumberInput = null;
    }

    function commitPendingNumberInput() {
        if (!pendingNumberInput) {
            return;
        }

        const input = pendingNumberInput;
        const value = sanitizeNumber(input.value);
        pendingNumberInput = null;
        input.remove();

        if (!value) {
            return;
        }

        marks.push({
            type: 'number',
            view: input.dataset.view,
            x: Number(input.dataset.x),
            y: Number(input.dataset.y),
            value,
        });
        renderMarks();
        recordHistoryChange();
    }

    function startNumberInput(surface, point) {
        commitPendingNumberInput();

        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.maxLength = 5;
        input.className = 'mark-number-input';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Nilai desimal, contoh 0,17');
        input.dataset.view = surface.dataset.view;
        input.dataset.x = String(point.x);
        input.dataset.y = String(point.y);
        input.style.setProperty('--x', `${point.x}%`);
        input.style.setProperty('--y', `${point.y}%`);

        input.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('input', () => {
            input.value = sanitizeNumber(input.value);
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commitPendingNumberInput();
            }

            if (event.key === 'Escape') {
                event.preventDefault();
                removePendingNumberInput();
            }
        });
        input.addEventListener('blur', commitPendingNumberInput);

        surface.appendChild(input);
        pendingNumberInput = input;
        input.focus();
    }

    function createAnnotation(surface, point) {
        const textPoint = getDefaultAnnotationTextPoint(point.x, point.y);
        const annotation = {
            type: 'annotation',
            id: createAnnotationId(),
            view: surface.dataset.view,
            circleX: clampPercent(point.x),
            circleY: clampPercent(point.y),
            circleRadius: annotationRadius,
            textX: textPoint.x,
            textY: textPoint.y,
            text: '',
        };

        marks.push(annotation);
        renderMarks();
        recordHistoryChange();
        enterAnnotationEdit(surface.querySelector(`.annotation-text[data-index="${marks.length - 1}"]`));
    }

    document.querySelectorAll('[data-mark-mode]').forEach((button) => {
        button.addEventListener('click', () => setMode(button.dataset.markMode));
    });

    fileSlotSelect?.addEventListener('change', () => {
        const nextSlot = fileSlotSelect.value;
        const currentSlot = getActiveFileSlot();

        if (nextSlot === currentSlot) {
            return;
        }

        saveDraft(currentSlot);
        setActiveFileSlot(nextSlot);
        loadDraft(nextSlot);

        draftState.textContent = `File ${nextSlot} aktif`;
    });

    document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const trigger = target?.closest('.bulk-good-trigger');

        if (!trigger) {
            return;
        }

        const table = trigger.closest('table');

        if (!table) {
            return;
        }

        const bulkValue = trigger.dataset.bulkValue || 'Baik';

        table
            .querySelectorAll(`tbody input[type="radio"][value="${CSS.escape(bulkValue)}"]`)
            .forEach((input) => {
                if (input.checked) {
                    return;
                }

                input.checked = true;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
    });

    document.querySelectorAll('.mark-surface').forEach((surface) => {
        surface.addEventListener('click', (event) => {
            const targetElement = event.target instanceof Element ? event.target : null;

            if (!targetElement) {
                return;
            }

            if (targetElement.closest('.annotation-circle, .annotation-box')) {
                return;
            }

            const targetMark = targetElement.closest('.number-mark');

            if (targetMark && surface.contains(targetMark)) {
                if (mode === 'erase') {
                    commitPendingNumberInput();
                    marks.splice(Number(targetMark.dataset.index), 1);
                    renderMarks();
                    recordHistoryChange();
                }
                return;
            }

            if (mode === 'number') {
                startNumberInput(surface, getSurfacePoint(event, surface));
                return;
            }

            if (mode !== 'mark') {
                return;
            }

            const point = getSurfacePoint(event, surface);
            createAnnotation(surface, point);
        });
    });

    function performFullReset() {
        clearTimeout(saveTimer);
        saveTimer = null;

        fileSlots.forEach((slot) => {
            localStorage.removeItem(getDraftStorageKey(slot));
        });
        localStorage.removeItem(ACTIVE_FILE_SLOT_KEY);
        setActiveFileSlot('1');

        if (fileSlotSelect) {
            fileSlotSelect.value = '1';
        }

        clearCurrentFormViewWithoutDeletingStorage();
        setMode('mark');
        resetUndoHistory();
        draftState.textContent = 'Semua file kosong';
    }

    function openResetChoiceModal() {
        document.getElementById('resetChoiceModal')?.removeAttribute('hidden');
    }

    function closeResetChoiceModal() {
        document.getElementById('resetChoiceModal')?.setAttribute('hidden', '');
    }
    document.getElementById('undoMark')?.addEventListener('click', () => {
        undoLastChange();
    });

    document.getElementById('toggleDailyRecap')?.addEventListener('click', () => {
        const recapPanel = document.getElementById('dailyRecapPanel');
        const toggleButton = document.getElementById('toggleDailyRecap');

        if (!recapPanel) {
            return;
        }

        const willOpen = recapPanel.hasAttribute('hidden');
        recapPanel.toggleAttribute('hidden', !willOpen);
        toggleButton?.classList.toggle('active', willOpen);
    });

    document.getElementById('addRecapRowButton')?.addEventListener(
        'click',
        addManualRecapRow
    );

    document.getElementById('deleteRecapRowButton')?.addEventListener(
        'click',
        deleteSelectedRecapRows
    );

    document.getElementById('dailyRecapBody')?.addEventListener('input', (event) => {
        const input = event.target instanceof HTMLInputElement ? event.target : null;

        if (!input || !input.classList.contains('daily-recap-input')) {
            return;
        }

        updateDailyRecapField(input);
    });

    document.getElementById('resetForm').addEventListener('click', () => {
        openResetChoiceModal();
    });

    document.getElementById('saveAndResetButton')?.addEventListener('click', (event) => {
        const saveAndResetButton = event.currentTarget;

        saveAndResetButton.disabled = true;

        try {
            const addedCount = addAllFileSlotsToRecap();

            if (addedCount === 0) {
                window.alert('Tidak ada data file yang memiliki Nama Unit.');
                return;
            }

            closeResetChoiceModal();
            performFullReset();
        } finally {
            saveAndResetButton.disabled = false;
        }
    });

    document.getElementById('resetOnlyButton')?.addEventListener('click', () => {
        closeResetChoiceModal();
        performFullReset();
    });
    document.getElementById('printPage').addEventListener('click', () => {
        commitPendingNumberInput();
        autoGrowAll();
        saveDraft();
        beginPrintMode();
        window.print();
        window.setTimeout(endPrintMode, 300);
    });

    form.addEventListener('pointerdown', (event) => {
        const field = getChecklistFieldFromTarget(event.target);

        if (!field) {
            return;
        }

        checklistClickState.set(field, field.checked);
    }, true);

    form.addEventListener('click', (event) => {
        const field = getChecklistFieldFromTarget(event.target);

        if (!field) {
            return;
        }

        const target = event.target instanceof Element ? event.target : null;
        const label = target?.closest('label') || null;
        const isDirectFieldClick = event.target === field;
        const isLabelClick = Boolean(label && label.contains(field));
        const wasChecked = checklistClickState.get(field) === true;

        if (mode === 'erase') {
            event.preventDefault();
            event.stopPropagation();

            if (!field.checked) {
                return;
            }

            field.checked = false;
            field.dispatchEvent(new Event('change', { bubbles: true }));
            draftState.textContent = 'Pilihan dihapus';
            recordHistoryChange();
            return;
        }

        if (isDirectFieldClick || isLabelClick) {
            if (!wasChecked) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            field.checked = false;
            field.dispatchEvent(new Event('change', { bubbles: true }));
            draftState.textContent = 'Pilihan dikosongkan';
            recordHistoryChange();
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        field.checked = !wasChecked;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        draftState.textContent = field.checked
            ? 'Pilihan dipilih'
            : 'Pilihan dikosongkan';
        recordHistoryChange();
    }, true);

    form.addEventListener('input', (event) => {
        if (event.target.classList.contains('mark-number-input')) {
            return;
        }

        if (event.target.tagName === 'TEXTAREA') {
            autoGrow(event.target);
        }
        recordHistoryChange();
    });

    form.addEventListener('change', recordHistoryChange);
    window.addEventListener('resize', updateSheetScreenScale, { passive: true });
    window.addEventListener('orientationchange', () => {
        window.setTimeout(updateSheetScreenScale, 120);
    });

    if (mobileSheetQuery.addEventListener) {
        mobileSheetQuery.addEventListener('change', updateSheetScreenScale);
        mobileToolbarQuery.addEventListener(
            'change',
            requestToolbarViewportSync
        );
    } else {
        mobileSheetQuery.addListener(updateSheetScreenScale);
        mobileToolbarQuery.addListener(
            requestToolbarViewportSync
        );
    }

    window.addEventListener(
        'load',
        requestToolbarViewportSync
    );

    window.addEventListener(
        'resize',
        requestToolbarViewportSync,
        { passive: true }
    );

    window.addEventListener(
        'orientationchange',
        () => {
            window.setTimeout(
                requestToolbarViewportSync,
                120
            );
        }
    );

    window.addEventListener(
        'scroll',
        requestToolbarViewportSync,
        { passive: true }
    );

    if (window.visualViewport) {
        window.visualViewport.addEventListener(
            'resize',
            requestToolbarViewportSync,
            { passive: true }
        );

        window.visualViewport.addEventListener(
            'scroll',
            requestToolbarViewportSync,
            { passive: true }
        );
    }

    window.addEventListener('beforeprint', () => {
        commitPendingNumberInput();
        updateEstimateGrandTotal(false);
        formatAllRupiahInputs();
        autoGrowAll();
        beginPrintMode();
    });
    window.addEventListener('afterprint', () => {
        endPrintMode();
    });

    updateSheetScreenScale();
    requestToolbarViewportSync();
    const activeSlot = getActiveFileSlot();

    if (fileSlotSelect) {
        fileSlotSelect.value = activeSlot;
    }

    initRupiahInputs();
    initEstimateAutoTotal();
    loadDailyRecap();
    runMonthlyRecapReset();
    renderDailyRecap();
    loadDraft(activeSlot);
    updateEstimateGrandTotal(false);
    formatAllRupiahInputs();
    autoGrowAll();
})();
