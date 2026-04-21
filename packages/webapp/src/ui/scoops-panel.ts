/**
 * Scoops Panel - UI for managing conversation scoops.
 *
 * Provides:
 * - List of registered scoops
 * - Create/delete scoops
 * - Switch active scoop
 * - View scoop status
 */

import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import { type Orchestrator } from '../scoops/orchestrator.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('scoops-panel');

export interface ScoopsPanelCallbacks {
  /** Called when user selects a scoop */
  onScoopSelect: (scoop: RegisteredScoop) => void;
  /** Called when user sends a message to a scoop */
  onSendMessage: (scoopJid: string, text: string) => void;
  /** Called when the scoop list changes (for logo updates, etc.) */
  onScoopsChanged?: (scoops: RegisteredScoop[]) => void;
}

export class ScoopsPanel {
  private container: HTMLElement;
  private orchestrator: Orchestrator | null = null;
  private callbacks: ScoopsPanelCallbacks;
  private selectedScoopJid: string | null = null;
  private scoopStatuses: Map<string, ScoopTabState['status']> = new Map();
  private expanded = false;

  // Roaming eyes state
  private eyesEl: HTMLElement | null = null;
  private hoveredJid: string | null = null;
  private lastProcessingJid: string | null = null;
  private coneJid: string | null = null;
  private leftPupilGroup: SVGGElement | null = null;
  private rightPupilGroup: SVGGElement | null = null;
  private eyesSvg: SVGSVGElement | null = null;
  private mouseMoveBound: ((e: MouseEvent) => void) | null = null;

  constructor(container: HTMLElement, callbacks: ScoopsPanelCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  /** Clean up listeners and DOM elements */
  dispose(): void {
    if (this.mouseMoveBound) {
      document.removeEventListener('mousemove', this.mouseMoveBound);
      this.mouseMoveBound = null;
    }
    this.eyesEl?.remove();
    this.eyesEl = null;
    this.eyesSvg = null;
    this.leftPupilGroup = null;
    this.rightPupilGroup = null;
    document.querySelectorAll('.scoop-fixed-tooltip').forEach((t) => t.remove());
  }

  /** Toggle the nav rail expanded/collapsed state */
  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.container.classList.toggle('layout__scoops--expanded', this.expanded);
  }

  // Eye geometry constants (in SVG viewBox units 0 0 200 100)
  private static readonly LEFT_EYE = { cx: 55, cy: 50, r: 38 };
  private static readonly RIGHT_EYE = { cx: 145, cy: 50, r: 38 };
  private static readonly PUPIL_R = 18;
  private static readonly MAX_OFFSET = 16; // how far pupil can move from eye center

  /** Create the roaming eyes overlay element */
  private createEyesEl(): HTMLElement {
    const ns = 'http://www.w3.org/2000/svg';
    const el = document.createElement('div');
    el.className = 'scoop-eyes';

    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 200 100');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');

    const { LEFT_EYE, RIGHT_EYE, PUPIL_R } = ScoopsPanel;

    // Helper: create one eye (white circle + pupil group with highlight)
    const makeEye = (eye: { cx: number; cy: number; r: number }) => {
      // White sclera
      const sclera = document.createElementNS(ns, 'circle');
      sclera.setAttribute('cx', String(eye.cx));
      sclera.setAttribute('cy', String(eye.cy));
      sclera.setAttribute('r', String(eye.r));
      sclera.setAttribute('fill', '#fff');
      sclera.setAttribute('stroke', '#000');
      sclera.setAttribute('stroke-width', '4');
      svg.appendChild(sclera);

      // Pupil group — translated as a unit to follow mouse
      const g = document.createElementNS(ns, 'g');

      // Black pupil circle (drawn at origin, group is translated)
      const pupil = document.createElementNS(ns, 'circle');
      pupil.setAttribute('cx', String(eye.cx));
      pupil.setAttribute('cy', String(eye.cy));
      pupil.setAttribute('r', String(PUPIL_R));
      pupil.setAttribute('fill', '#000');
      g.appendChild(pupil);

      // White crescent highlight (half-moon light reflection)
      // A smaller white circle offset to the upper-left of the pupil
      const highlight = document.createElementNS(ns, 'circle');
      highlight.setAttribute('cx', String(eye.cx - PUPIL_R * 0.3));
      highlight.setAttribute('cy', String(eye.cy - PUPIL_R * 0.35));
      highlight.setAttribute('r', String(PUPIL_R * 0.4));
      highlight.setAttribute('fill', '#fff');
      g.appendChild(highlight);

      svg.appendChild(g);
      return g;
    };

    this.leftPupilGroup = makeEye(LEFT_EYE);
    this.rightPupilGroup = makeEye(RIGHT_EYE);

    el.appendChild(svg);
    this.eyesSvg = svg;

    // Start tracking mouse
    if (!this.mouseMoveBound) {
      this.mouseMoveBound = (e: MouseEvent) => this.onMouseMove(e);
      document.addEventListener('mousemove', this.mouseMoveBound);
    }

    return el;
  }

  /** Map a screen-space mouse position to a pupil offset within the eye */
  private onMouseMove(e: MouseEvent): void {
    if (!this.eyesSvg || !this.leftPupilGroup || !this.rightPupilGroup) return;

    const svgRect = this.eyesSvg.getBoundingClientRect();
    if (svgRect.width === 0 || svgRect.height === 0) return;

    // Convert mouse coords to SVG viewBox space
    const scaleX = 200 / svgRect.width;
    const scaleY = 100 / svgRect.height;
    const mx = (e.clientX - svgRect.left) * scaleX;
    const my = (e.clientY - svgRect.top) * scaleY;

    const { LEFT_EYE, RIGHT_EYE, MAX_OFFSET } = ScoopsPanel;

    this.positionPupilGroup(this.leftPupilGroup, LEFT_EYE.cx, LEFT_EYE.cy, mx, my, MAX_OFFSET);
    this.positionPupilGroup(this.rightPupilGroup, RIGHT_EYE.cx, RIGHT_EYE.cy, mx, my, MAX_OFFSET);
  }

  private positionPupilGroup(
    group: SVGGElement,
    eyeCx: number,
    eyeCy: number,
    mx: number,
    my: number,
    maxOffset: number
  ): void {
    const dx = mx - eyeCx;
    const dy = my - eyeCy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clamp = Math.min(dist, maxOffset);
    const tx = dist > 0 ? (dx / dist) * clamp : 0;
    const ty = dist > 0 ? (dy / dist) * clamp : 0;
    group.setAttribute('transform', `translate(${tx},${ty})`);
  }

  /** Determine which jid should currently have the eyes */
  private resolveEyesOwner(): string | null {
    // Priority 1: hover (verify element still exists in DOM)
    if (this.hoveredJid && this.hasScoopItem(this.hoveredJid)) return this.hoveredJid;
    // Priority 2: most recently processing scoop/cone
    if (this.lastProcessingJid) {
      const status = this.scoopStatuses.get(this.lastProcessingJid);
      if (status === 'processing' && this.hasScoopItem(this.lastProcessingJid))
        return this.lastProcessingJid;
    }
    // Priority 3: any currently processing
    for (const [jid, status] of this.scoopStatuses) {
      if (status === 'processing' && this.hasScoopItem(jid)) {
        this.lastProcessingJid = jid;
        return jid;
      }
    }
    // Default: cone
    return this.coneJid;
  }

  /** Check if a scoop-item element exists for the given jid */
  private hasScoopItem(jid: string): boolean {
    return !!this.container.querySelector(`.scoop-item[data-jid="${CSS.escape(jid)}"]`);
  }

  /** Move the eyes element to the icon-wrap of the given jid */
  private moveEyes(): void {
    if (!this.eyesEl) {
      this.eyesEl = this.createEyesEl();
    }
    const targetJid = this.resolveEyesOwner();
    if (!targetJid) return;

    const item = this.container.querySelector(`.scoop-item[data-jid="${CSS.escape(targetJid)}"]`);
    if (!item) return;
    const iconWrap = item.querySelector('.scoop-icon-wrap');
    if (!iconWrap) return;

    // Only move if not already parented there
    if (this.eyesEl.parentElement !== iconWrap) {
      iconWrap.appendChild(this.eyesEl);
    }
  }

  /** Set the orchestrator instance */
  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    this.refreshScoops();
  }

  /** Update scoop status */
  updateScoopStatus(jid: string, status: ScoopTabState['status']): void {
    this.scoopStatuses.set(jid, status);
    if (status === 'processing') {
      this.lastProcessingJid = jid;
    }
    this.refreshScoops();
  }

  /** Refresh the scoop list */
  refreshScoops(): void {
    if (!this.orchestrator) return;

    // Clean up any stale tooltips from previous render
    document.querySelectorAll('.scoop-fixed-tooltip').forEach((t) => t.remove());

    const allScoops = this.orchestrator.getScoops();
    const cone = allScoops.find((s) => s.isCone);
    const scoops = allScoops.filter((s) => !s.isCone);

    const ns = 'http://www.w3.org/2000/svg';
    // Canonical scoop colors from logo-editor.html (base, dark outline)
    const SCOOP_PALETTE = [
      { base: '#FFB6C1', outline: '#B97B88' }, // Strawberry (pink)
      { base: '#98FB98', outline: '#65AC65' }, // Mint (green)
      { base: '#87CEEB', outline: '#5591AC' }, // Blueberry (blue)
      { base: '#DDA0DD', outline: '#9F649F' }, // Grape (plum)
      { base: '#F0E68C', outline: '#A9A059' }, // Vanilla (khaki)
      { base: '#FFD700', outline: '#B89700' }, // Mango (gold)
      { base: '#FFA07A', outline: '#B86E50' }, // Peach (salmon)
      { base: '#DEB887', outline: '#9F8260' }, // Caramel (burlywood)
      { base: '#F08080', outline: '#AC5656' }, // Cherry (coral)
      { base: '#E0BBE4', outline: '#A085A4' }, // Lavender
    ];
    const SCOOP_COLORS = SCOOP_PALETTE.map((c) => c.base);
    const SCOOP_OUTLINES = SCOOP_PALETTE.map((c) => c.outline);

    // --- Cone header (fixed, not scrollable) ---
    const coneHeaderEl = this.container.querySelector('.scoop-cone-header');
    if (coneHeaderEl) {
      while (coneHeaderEl.firstChild) coneHeaderEl.removeChild(coneHeaderEl.firstChild);

      if (cone) {
        this.coneJid = cone.jid;
        const coneStatus = this.scoopStatuses.get(cone.jid) ?? 'inactive';
        const isConeSelected = cone.jid === this.selectedScoopJid;
        const coneColor = '#D2691E'; // Cone base (chocolate)
        const coneOutline = '#8B4513'; // Cone outline (saddle brown)
        const coneWaffle = '#E8A75C'; // Waffle crosshatch (lighter brown)

        const coneItem = document.createElement('div');
        coneItem.className = `scoop-item scoop-item--cone ${isConeSelected ? 'selected' : ''} status-${coneStatus}`;
        coneItem.dataset.jid = cone.jid;
        coneItem.setAttribute('aria-label', cone.assistantLabel);

        // Set accent color as CSS custom properties for border styling
        coneItem.style.setProperty('--scoop-accent', coneOutline);
        // Solid-fill color for light mode (see .theme-light overrides in CSS)
        coneItem.style.setProperty('--scoop-bg', coneColor);

        // Icon wrapper — 40px for cone
        const iconWrap = document.createElement('div');
        iconWrap.className = 'scoop-icon-wrap scoop-icon-wrap--cone';
        iconWrap.style.width = '40px';
        iconWrap.style.height = '40px';

        // Whimsical cone icon (from asset SVGs)
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '70 330 440 570');
        svg.innerHTML =
          `<path d="M108.22,414.88l189.84,460.03c1.36,3.3,6.09,3.16,7.25-.22l159.34-463.34c.87-2.53-1.03-5.16-3.7-5.13l-349.18,3.32c-2.74.03-4.59,2.82-3.55,5.35Z" fill="${coneColor}" stroke="${coneOutline}" stroke-linejoin="round" stroke-width="20"/>` +
          `<path d="M261.93,482.48h0c15.03-15.03,4.46-40.72-16.79-40.83h0c-21.37-.11-32.14,25.72-17.03,40.83h0c9.34,9.34,24.48,9.34,33.82,0Z" fill="${coneWaffle}"/>` +
          `<path d="M384.85,527.49l-51.82,51.82c-2.24,2.24-2.24,5.86,0,8.1l55.71,55.71c2.24,2.24,5.86,2.24,8.1,0h0c.62-.62,1.08-1.36,1.37-2.19l26.52-77.11c.71-2.07.18-4.36-1.37-5.91l-30.41-30.41c-2.24-2.24-5.86-2.24-8.1,0Z" fill="${coneWaffle}"/>` +
          `<rect x="274.59" y="463.59" width="84.73" height="95.66" rx="42.36" ry="42.36" transform="translate(-268.79 373.91) rotate(-45)" fill="${coneWaffle}"/>` +
          `<rect x="291.06" y="603.84" width="72.24" height="90.24" rx="36.12" ry="36.12" transform="translate(-363.06 421.43) rotate(-45)" fill="${coneWaffle}"/>` +
          `<path d="M371.7,684.58l-25.94,25.94c-2.24,2.24-2.24,5.86,0,8.1l12.67,12.67c2.99,2.99,8.09,1.82,9.46-2.19l13.28-38.61c1.97-5.74-5.17-10.2-9.46-5.91Z" fill="${coneWaffle}"/>` +
          `<path d="M159.42,564.14l2.73,6.83c1.52,3.82,6.46,4.83,9.37,1.93l2.05-2.05c2.24-2.24,2.24-5.86,0-8.1l-4.78-4.78c-4.4-4.4-11.67.39-9.37,6.17Z" fill="${coneWaffle}"/>` +
          `<path d="M243.92,633.11l-48.65-48.65c-5.24-5.24-13.74-5.24-18.99,0h0c-3.8,3.8-4.97,9.49-2.98,14.47l27.77,69.54c3.58,8.95,15.14,11.33,21.96,4.51l20.89-20.89c5.24-5.24,5.24-13.74,0-18.99Z" fill="${coneWaffle}"/>` +
          `<path d="M211.32,533.1h0c14.11-14.11,14.11-36.98,0-51.08l-34.94-34.94c-.72-.72-.72-1.89,0-2.62h0c1.16-1.16.34-3.15-1.3-3.16l-11.23-.06c-25.62-.13-43.23,25.72-33.73,49.51l5.37,13.45c1.82,4.55,4.54,8.68,8,12.15l16.74,16.74c14.11,14.11,36.98,14.11,51.08,0Z" fill="${coneWaffle}"/>` +
          `<path d="M263.74,792.53h0c-5.69,5.69-7.45,14.23-4.46,21.71l22.5,56.36c6.92,17.34,31.68,16.74,37.75-.92l8.66-25.2c2.5-7.28.64-15.35-4.8-20.79l-31.17-31.17c-7.87-7.87-20.62-7.87-28.48,0Z" fill="${coneWaffle}"/>` +
          `<path d="M392.94,503.07l40.81-40.81c2.24-2.24,5.86-2.24,8.1,0l.06.06c2.24,2.24,2.24,5.86,0,8.1l-40.81,40.81c-2.24,2.24-2.24,5.86,0,8.1l22.48,22.48c2.99,2.99,8.09,1.82,9.46-2.19l30.71-89.32c1.27-3.71-1.47-7.57-5.39-7.59l-120.63-.6c-5.11-.03-7.69,6.16-4.08,9.77l51.18,51.18c2.24,2.24,5.86,2.24,8.1,0Z" fill="${coneWaffle}"/>` +
          `<rect x="217.18" y="527.25" width="72.24" height="95.66" rx="36.12" ry="36.12" transform="translate(-332.45 347.55) rotate(-45)" fill="${coneWaffle}"/>` +
          `<path d="M350.28,739.46h0c-9.24-9.24-24.22-9.24-33.46,0l-13.94,13.94c-9.24,9.24-9.24,24.22,0,33.46l6.81,6.81c12.37,12.37,33.42,7.5,39.1-9.04l7.13-20.75c2.94-8.55.75-18.03-5.64-24.42Z" fill="${coneWaffle}"/>` +
          `<path d="M234.18,749.12l13.2,33.06c1.52,3.82,6.46,4.83,9.37,1.93l9.93-9.93c2.24-2.24,2.24-5.86,0-8.1l-23.13-23.13c-4.4-4.4-11.67.39-9.37,6.17Z" fill="${coneWaffle}"/>` +
          `<rect x="236.26" y="661.25" width="67.04" height="90.24" rx="33.52" ry="33.52" transform="translate(-420.46 397.65) rotate(-45)" fill="${coneWaffle}"/>` +
          `<ellipse cx="288.37" cy="404.38" rx="182.34" ry="67.01" fill="${coneColor}" stroke="${coneOutline}" stroke-miterlimit="10" stroke-width="20"/>`;
        iconWrap.appendChild(svg);

        // Status dot on cone
        if (coneStatus === 'processing' || coneStatus === 'ready' || coneStatus === 'error') {
          const dot = document.createElement('span');
          dot.className = `scoop-dot scoop-dot--${coneStatus}`;
          iconWrap.appendChild(dot);
        }

        coneItem.appendChild(iconWrap);

        // Info
        const infoEl = document.createElement('div');
        infoEl.className = 'scoop-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'scoop-name';
        nameEl.textContent = cone.assistantLabel;
        infoEl.appendChild(nameEl);

        // Only show subtitle for processing/error
        if (coneStatus === 'processing' || coneStatus === 'error') {
          const subtitleEl = document.createElement('div');
          subtitleEl.className = 'scoop-subtitle';
          subtitleEl.textContent = coneStatus === 'processing' ? 'Working\u2026' : 'Error';
          infoEl.appendChild(subtitleEl);
        }

        coneItem.appendChild(infoEl);

        // Actions
        const actionsEl = document.createElement('div');
        actionsEl.className = 'scoop-actions';
        if (coneStatus === 'processing') {
          const spinDot = document.createElement('span');
          spinDot.className = 'scoop-spin-dot';
          actionsEl.appendChild(spinDot);
        } else if (coneStatus === 'error') {
          const errDot = document.createElement('span');
          errDot.className = 'scoop-err-dot';
          actionsEl.appendChild(errDot);
        }
        coneItem.appendChild(actionsEl);

        coneItem.addEventListener('click', () => this.selectScoop(cone));

        // Eyes hover tracking
        coneItem.addEventListener('mouseenter', () => {
          this.hoveredJid = cone.jid;
          this.moveEyes();
        });
        coneItem.addEventListener('mouseleave', () => {
          if (this.hoveredJid === cone.jid) this.hoveredJid = null;
          this.moveEyes();
        });

        // Collapsed-mode tooltip
        const label = cone.assistantLabel;
        coneItem.addEventListener('mouseenter', () => {
          if (this.expanded) return;
          const tip = document.createElement('div');
          tip.className = 'scoop-fixed-tooltip';
          tip.textContent = label;
          document.body.appendChild(tip);
          const rect = coneItem.getBoundingClientRect();
          tip.style.top = `${rect.top + rect.height / 2}px`;
          tip.style.left = `${rect.right + 8}px`;
          (coneItem as any).__tip = tip;
        });
        coneItem.addEventListener('mouseleave', () => {
          const tip = (coneItem as any).__tip;
          if (tip) {
            tip.remove();
            (coneItem as any).__tip = null;
          }
        });

        coneHeaderEl.appendChild(coneItem);
      }
    }

    // --- Scoop list (scrollable) ---
    const listEl = this.container.querySelector('.scoops-list');
    if (!listEl) return;

    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

    if (scoops.length === 0) {
      // Still notify even if no scoops
      this.callbacks.onScoopsChanged?.(allScoops);
      this.moveEyes();
      return;
    }

    for (let i = 0; i < scoops.length; i++) {
      const scoop = scoops[i];
      const status = this.scoopStatuses.get(scoop.jid) ?? 'inactive';
      const isSelected = scoop.jid === this.selectedScoopJid;
      const iconColor = SCOOP_COLORS[i % SCOOP_COLORS.length];
      const iconOutline = SCOOP_OUTLINES[i % SCOOP_OUTLINES.length];

      const item = document.createElement('div');
      item.className = `scoop-item ${isSelected ? 'selected' : ''} status-${status}`;
      item.dataset.jid = scoop.jid;

      // Display name: strip "-scoop" suffix
      const displayName = scoop.assistantLabel.replace(/-scoop$/, '');
      item.setAttribute('aria-label', displayName);

      // Set accent color as CSS custom properties for border styling
      item.style.setProperty('--scoop-accent', iconOutline);
      // Solid-fill color for light mode (see .theme-light overrides in CSS)
      item.style.setProperty('--scoop-bg', iconColor);

      // Icon wrapper
      const iconWrap = document.createElement('div');
      iconWrap.className = 'scoop-icon-wrap';

      // Whimsical scoop icon (organic blob from asset SVGs)
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '20');
      svg.setAttribute('viewBox', '0 0 580 470');
      const sp1 = document.createElementNS(ns, 'path');
      sp1.setAttribute(
        'd',
        'M566.75,340.67c0-29.85-12.97-56.87-33.96-76.47,4.8-9.98,7.44-20.71,7.44-31.9,0-38.29-30.62-71.33-74.92-86.77.33-3.07.51-6.17.51-9.3,0-69.72-84.29-126.24-188.26-126.24s-188.26,56.52-188.26,126.24c0,4,.29,7.95.83,11.86-34.94,15.4-58.48,44.25-58.48,77.34,0,18.21,7.15,35.15,19.39,49.26-25.1,19.88-41.05,49.47-41.05,82.54,0,59.85,52.15,108.37,116.49,108.37,10.83,0,21.3-1.4,31.26-3.98,31.42,41.91,83.55,69.34,142.55,69.34,64.73,0,121.2-33,151.11-81.94,63.8-.57,115.34-48.85,115.34-108.34Z'
      );
      sp1.setAttribute('fill', iconColor);
      sp1.setAttribute('stroke', iconOutline);
      sp1.setAttribute('stroke-width', '20');
      svg.appendChild(sp1);
      iconWrap.appendChild(svg);

      // Status dot
      if (status === 'processing' || status === 'ready' || status === 'error') {
        const dot = document.createElement('span');
        dot.className = `scoop-dot scoop-dot--${status}`;
        iconWrap.appendChild(dot);
      }

      item.appendChild(iconWrap);

      // Content: name + subtitle
      const infoEl = document.createElement('div');
      infoEl.className = 'scoop-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'scoop-name';
      nameEl.textContent = displayName;
      infoEl.appendChild(nameEl);

      // Only show subtitle for processing/error
      if (status === 'processing' || status === 'error') {
        const subtitleEl = document.createElement('div');
        subtitleEl.className = 'scoop-subtitle';
        subtitleEl.textContent = status === 'processing' ? 'Working\u2026' : 'Error';
        infoEl.appendChild(subtitleEl);
      }

      item.appendChild(infoEl);

      // Right actions
      const actionsEl = document.createElement('div');
      actionsEl.className = 'scoop-actions';

      if (status === 'processing') {
        const spinDot = document.createElement('span');
        spinDot.className = 'scoop-spin-dot';
        actionsEl.appendChild(spinDot);
      } else if (status === 'error') {
        const errDot = document.createElement('span');
        errDot.className = 'scoop-err-dot';
        actionsEl.appendChild(errDot);
      }

      item.appendChild(actionsEl);

      item.addEventListener('click', () => {
        this.selectScoop(scoop);
      });

      // Eyes hover tracking
      item.addEventListener('mouseenter', () => {
        this.hoveredJid = scoop.jid;
        this.moveEyes();
      });
      item.addEventListener('mouseleave', () => {
        if (this.hoveredJid === scoop.jid) this.hoveredJid = null;
        this.moveEyes();
      });

      // Collapsed-mode tooltip
      item.addEventListener('mouseenter', () => {
        if (this.expanded) return;
        const tip = document.createElement('div');
        tip.className = 'scoop-fixed-tooltip';
        tip.textContent = displayName;
        document.body.appendChild(tip);
        const rect = item.getBoundingClientRect();
        tip.style.top = `${rect.top + rect.height / 2}px`;
        tip.style.left = `${rect.right + 8}px`;
        (item as any).__tip = tip;
      });
      item.addEventListener('mouseleave', () => {
        const tip = (item as any).__tip;
        if (tip) {
          tip.remove();
          (item as any).__tip = null;
        }
      });

      listEl.appendChild(item);
    }

    // Notify listeners of scoop list change
    this.callbacks.onScoopsChanged?.(allScoops);

    // Position roaming eyes
    this.moveEyes();
  }

  /** Select a scoop */
  private selectScoop(scoop: RegisteredScoop): void {
    this.selectedScoopJid = scoop.jid;
    this.refreshScoops();
    this.callbacks.onScoopSelect(scoop);

    // Update URL state
    const url = new URL(window.location.href);
    if (scoop.isCone) {
      url.searchParams.delete('scoop');
    } else {
      url.searchParams.set('scoop', scoop.folder);
    }
    history.replaceState(null, '', url.toString());
  }

  /** Select scoop by folder name (for URL restoration) */
  selectScoopByFolder(folder: string): void {
    if (!this.orchestrator) return;
    const scoops = this.orchestrator.getScoops();
    const scoop = scoops.find((s) => s.folder === folder);
    if (scoop) {
      this.selectScoop(scoop);
    }
  }

  /** Set selected scoop JID externally (no callback, just visual sync) */
  setSelectedJid(jid: string): void {
    this.selectedScoopJid = jid;
    this.refreshScoops();
  }

  /** Get selected scoop JID */
  getSelectedScoopJid(): string | null {
    return this.selectedScoopJid;
  }

  /** Delete a scoop */
  async deleteScoop(jid: string): Promise<void> {
    if (!this.orchestrator) return;

    const scoop = this.orchestrator.getScoop(jid);
    if (!scoop) return;

    if (scoop.isCone) {
      alert('Cannot delete the cone');
      return;
    }

    if (!confirm(`Delete scoop "${scoop.name}"? This cannot be undone.`)) {
      return;
    }

    try {
      await this.orchestrator.unregisterScoop(jid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(msg);
      return;
    }

    if (this.selectedScoopJid === jid) {
      this.selectedScoopJid = null;
    }

    this.refreshScoops();
    log.info('Scoop deleted', { jid, name: scoop.name });
  }

  /**
   * Bootstrap the cone. Only ever used once, from `main.ts`, when the
   * orchestrator starts with no existing cone on disk. Non-cone scoops come
   * exclusively from the agent's `scoop_scoop` tool.
   */
  async createCone(name = 'Cone'): Promise<RegisteredScoop> {
    if (!this.orchestrator) {
      throw new Error('Orchestrator not set');
    }

    const scoop: RegisteredScoop = {
      jid: `cone_${Date.now()}`,
      name,
      folder: 'cone',
      requiresTrigger: false,
      isCone: true,
      type: 'cone',
      assistantLabel: 'sliccy',
      addedAt: new Date().toISOString(),
    };

    await this.orchestrator.registerScoop(scoop);
    this.refreshScoops();

    log.info('Cone created', { jid: scoop.jid, name });
    return scoop;
  }

  /** Render the panel as an icon-only nav rail (UXC design). */
  private render(): void {
    // Build DOM safely
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);

    const panel = document.createElement('div');
    panel.className = 'scoops-panel';

    // Cone header — fixed above scrollable list
    const coneHeader = document.createElement('div');
    coneHeader.className = 'scoop-cone-header';
    panel.appendChild(coneHeader);

    const list = document.createElement('div');
    list.className = 'scoops-list';
    panel.appendChild(list);

    this.container.appendChild(panel);

    // Add styles — UXC icon rail mode
    const style = document.createElement('style');
    style.textContent = `
      .scoops-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--s2-bg-layer-1);
        color: var(--s2-content-default);
        align-items: flex-start;
        padding: 12px 4px 12px 8px;
        gap: 8px;
        overflow: visible;
      }

      /* Cone header — fixed above scrollable list */
      .scoop-cone-header {
        width: 100%;
        flex-shrink: 0;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(0,0,0,0.06);
        margin-bottom: 4px;
      }
      .scoop-cone-header:empty {
        display: none;
      }

      .scoops-list {
        flex: 1;
        overflow-y: auto;
        scrollbar-width: none;
        -ms-overflow-style: none;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        width: 100%;
        padding: 0;
      }
      .scoops-list::-webkit-scrollbar {
        display: none;
      }

      .scoops-empty {
        padding: var(--s2-spacing-100);
        text-align: center;
        color: var(--s2-content-disabled);
        font-size: 10px;
      }

      .scoop-item {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px; height: 52px;
        margin-left: 5px;
        border-radius: 8px;
        cursor: pointer;
        transition: background var(--s2-transition-default), width 200ms ease;
        position: relative;
        flex-shrink: 0;
        background: transparent;
        overflow: visible;
      }

      .scoop-item:hover {
        background: transparent;
      }

      /* Collapsed selected */
      .scoop-item.selected {
        opacity: 1;
      }
      .scoop-item.selected .scoop-icon-wrap {
        background: transparent;
        border-width: 3px;
      }

      /* Fade idle scoops */
      .scoop-item.status-ready,
      .scoop-item.status-inactive {
        opacity: 0.55;
      }
      .scoop-item:hover,
      .scoop-item.selected {
        opacity: 1;
      }

      /* Icon wrapper — same size in both modes */
      .scoop-icon-wrap {
        width: 32px; height: 32px;
        border-radius: 6px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        background: transparent;
        box-sizing: border-box;
        border: 2px solid var(--scoop-accent, currentColor);
      }
      .scoop-icon-wrap svg {
        width: 18px; height: 18px;
      }

      /* Light mode keeps the legacy solid-fill look (pale tinted bg, no outline ring).
         The wrapper bg is a lightened version of the scoop base color so the
         SVG (filled with the base color + darker outline) remains distinct. */
      :root.theme-light .scoop-icon-wrap {
        background: color-mix(in oklab, var(--scoop-bg, transparent) 35%, #ffffff);
        border: none;
      }
      :root.theme-light .scoop-item.selected .scoop-icon-wrap {
        background: color-mix(in oklab, var(--scoop-bg, transparent) 35%, #ffffff);
        border: none;
      }

      /* Hide info/actions in rail mode — shown via tooltip */
      .scoop-info { display: none; }
      .scoop-actions { display: none; }

      /* Hide delete buttons by default, show on hover */
      .scoop-delete { opacity: 0; transition: opacity 130ms ease; }
      .scoop-item:hover .scoop-delete { opacity: 1; }

      /* Expanded state — Figma card design */
      .layout__scoops--expanded .scoops-panel {
        align-items: stretch;
        padding: 12px 8px;
        gap: 2px;
      }
      .layout__scoops--expanded .scoop-item {
        width: 100%;
        height: auto;
        justify-content: flex-start;
        padding: 10px 5px;
        margin-left: 0;
        gap: 8px;
        border: none;
        border-radius: 8px;
        background: transparent;
      }
      .layout__scoops--expanded .scoop-item:hover {
        background: var(--s2-bg-elevated);
      }
      /* Expanded selected: tinted background only */
      .layout__scoops--expanded .scoop-item.selected {
        background: var(--scoop-accent-bg, #efe4f8);
      }
      .layout__scoops--expanded .scoop-item.selected .scoop-icon-wrap {
        box-shadow: none;
      }
      .layout__scoops--expanded .scoop-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        min-width: 0;
        justify-content: center;
      }
      .layout__scoops--expanded .scoop-name {
        font-size: 13px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--s2-content-default);
        line-height: 16px;
      }
      .layout__scoops--expanded .scoop-subtitle {
        font-size: 11px;
        font-weight: 400;
        color: var(--s2-content-secondary);
        line-height: 1.4;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .layout__scoops--expanded .scoop-item.selected .scoop-name {
        color: var(--s2-content-default);
      }

      /* Right actions in expanded mode */
      .layout__scoops--expanded .scoop-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .scoop-spin-dot {
        width: 10px; height: 10px;
        border-radius: 50%;
        background: var(--s2-notice);
        animation: spin-pulse 1.2s ease-in-out infinite;
      }
      @keyframes spin-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      .scoop-err-dot {
        width: 10px; height: 10px;
        border-radius: 50%;
        background: var(--s2-negative, #d73220);
      }
      .layout__scoops--expanded .scoop-delete,
      .layout__scoops--expanded .scoop-chevron {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px; height: 28px;
        border: none;
        background: transparent;
        color: var(--s2-content-tertiary);
        cursor: pointer;
        border-radius: 4px;
        flex-shrink: 0;
        padding: 0;
        transition: background 130ms ease, color 130ms ease;
      }
      .layout__scoops--expanded .scoop-delete:hover {
        background: rgba(0,0,0,0.06);
        color: var(--s2-negative, #d73220);
      }
      .layout__scoops--expanded .scoop-chevron {
        cursor: default;
      }
      .layout__scoops--expanded .scoop-chevron:hover {
        background: rgba(0,0,0,0.06);
        color: var(--s2-content-secondary);
      }

      .layout__scoops--expanded .scoops-hamburger {
        align-self: flex-end;
        margin-left: 0;
      }

      /* Status dot — overlays top-right corner of icon-wrap */
      .scoop-dot {
        position: absolute; top: 0; right: 0;
        width: 9px; height: 9px;
        border-radius: 50%;
        border: 1.5px solid var(--s2-gray-25);
        z-index: 1;
        pointer-events: none;
        transform: translate(30%, -30%);
      }
      .scoop-dot--processing { background: var(--s2-notice); }
      .scoop-dot--ready { background: var(--s2-positive); }
      .scoop-dot--error { background: var(--s2-negative); }

      /* Roaming eyes overlay */
      .scoop-eyes {
        position: absolute;
        top: 22%;
        left: 24%;
        width: 70%;
        height: 45%;
        pointer-events: none;
        z-index: 2;
      }
      .scoop-icon-wrap--cone .scoop-eyes {
        top: -2%;
        left: 25.5%;
        width: 64%;
        height: 44%;
      }

      /* Footer — pinned to bottom of nav rail */
      .scoops-footer {
        margin-top: auto;
        flex-shrink: 0;
        padding-top: 8px;
        border-top: 1px solid rgba(0,0,0,0.06);
        width: 100%;
        display: flex;
        justify-content: center;
      }
      .scoops-footer__btn {
        width: 28px; height: 28px;
        border: none;
        background: transparent;
        color: var(--s2-content-tertiary);
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center; justify-content: center;
        padding: 0;
        transition: background 130ms ease, color 130ms ease;
      }
      .scoops-footer__btn:hover {
        background: var(--s2-bg-elevated);
        color: var(--s2-negative, #d73220);
      }

      /* Fixed tooltip for collapsed mode */
      .scoop-fixed-tooltip {
        position: fixed;
        transform: translateY(-50%);
        padding: 4px 10px;
        background: var(--s2-gray-900);
        color: var(--s2-gray-25);
        font-size: 12px;
        font-weight: 500;
        font-family: var(--s2-font-family);
        white-space: nowrap;
        border-radius: var(--s2-radius-s);
        pointer-events: none;
        z-index: 10000;
        line-height: 1.3;
      }

`;
    this.container.appendChild(style);
  }
}
