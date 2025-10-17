(function(){
  class SimpleImageViewer {
    constructor() {
      this.overlay = null;
      this.img = null;
      this.state = { scale: 1, x: 0, y: 0 };
      this._drag = { active: false, startX: 0, startY: 0, baseX: 0, baseY: 0 };
      this._onWheel = this.onWheel.bind(this);
      this._onMouseDown = this.onMouseDown.bind(this);
      this._onMouseMove = this.onMouseMove.bind(this);
      this._onMouseUp = this.onMouseUp.bind(this);
      this._onKey = this.onKey.bind(this);
    }

    open({ src, title = "" }) {
      if (!this.overlay) this.create();
      this.img.src = src;
      this.img.alt = title || "Image";
      // reset transform each open
      this.state = { scale: 1, x: 0, y: 0 };
      this.applyTransform();
      requestAnimationFrame(() => {
        this.overlay.classList.add("active");
      });
    }

    close() {
      if (!this.overlay) return;
      this.overlay.classList.remove("active");
      setTimeout(() => {
        if (this.overlay && this.overlay.parentNode) {
          this.overlay.parentNode.removeChild(this.overlay);
        }
        document.removeEventListener("keydown", this._onKey);
        this.overlay = null;
        this.img = null;
      }, 150);
    }

    create() {
      const overlay = document.createElement("div");
      overlay.className = "image-viewer-overlay";

      const container = document.createElement("div");
      container.className = "image-viewer-container";

      const img = document.createElement("img");
      img.className = "image-viewer-canvas";

      const toolbar = document.createElement("div");
      toolbar.className = "image-viewer-toolbar";
      toolbar.innerHTML = `
        <button class="image-viewer-btn" data-action="zoom-out" title="Zoom Out"><i class="fas fa-minus"></i></button>
        <button class="image-viewer-btn" data-action="reset" title="Reset"><i class="fas fa-undo"></i></button>
        <button class="image-viewer-btn" data-action="zoom-in" title="Zoom In"><i class="fas fa-plus"></i></button>
      `;

      const closeBtn = document.createElement("button");
      closeBtn.className = "image-viewer-close";
      closeBtn.innerHTML = '<i class="fas fa-times"></i>';

      overlay.appendChild(container);
      container.appendChild(img);
      container.appendChild(toolbar);
      overlay.appendChild(closeBtn);

      // interactions
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) this.close();
      });
      closeBtn.addEventListener("click", () => this.close());

      toolbar.addEventListener("click", (e) => {
        const btn = e.target.closest(".image-viewer-btn");
        if (!btn) return;
        const action = btn.getAttribute("data-action");
        if (action === "zoom-in") this.zoom(1.2);
        if (action === "zoom-out") this.zoom(1/1.2);
        if (action === "reset") this.reset();
      });

      img.addEventListener("wheel", this._onWheel, { passive: false });
      img.addEventListener("mousedown", this._onMouseDown);
      window.addEventListener("mousemove", this._onMouseMove);
      window.addEventListener("mouseup", this._onMouseUp);

      // Touch support (drag + double tap to zoom)
      let lastTap = 0;
      img.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) {
          const now = Date.now();
          if (now - lastTap < 300) {
            this.zoom(1.2);
          }
          lastTap = now;
          const t = e.touches[0];
          this._drag.active = true;
          this._drag.startX = t.clientX;
          this._drag.startY = t.clientY;
          this._drag.baseX = this.state.x;
          this._drag.baseY = this.state.y;
        }
      }, { passive: true });
      img.addEventListener("touchmove", (e) => {
        if (!this._drag.active || e.touches.length !== 1) return;
        const t = e.touches[0];
        this.state.x = this._drag.baseX + (t.clientX - this._drag.startX);
        this.state.y = this._drag.baseY + (t.clientY - this._drag.startY);
        this.applyTransform();
      }, { passive: true });
      img.addEventListener("touchend", () => { this._drag.active = false; }, { passive: true });

      document.body.appendChild(overlay);
      document.addEventListener("keydown", this._onKey);

      this.overlay = overlay;
      this.img = img;
    }

    onKey(e) {
      if (e.key === "Escape") this.close();
      if (e.key === "+") this.zoom(1.2);
      if (e.key === "-") this.zoom(1/1.2);
      if (e.key.toLowerCase() === "r") this.reset();
    }

    onWheel(e) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.1 : 0.9;
      this.zoom(delta);
    }

    onMouseDown(e) {
      e.preventDefault();
      this._drag.active = true;
      this.img.classList.add("dragging");
      this._drag.startX = e.clientX;
      this._drag.startY = e.clientY;
      this._drag.baseX = this.state.x;
      this._drag.baseY = this.state.y;
    }

    onMouseMove(e) {
      if (!this._drag.active) return;
      this.state.x = this._drag.baseX + (e.clientX - this._drag.startX);
      this.state.y = this._drag.baseY + (e.clientY - this._drag.startY);
      this.applyTransform();
    }

    onMouseUp() {
      if (!this._drag.active) return;
      this._drag.active = false;
      if (this.img) this.img.classList.remove("dragging");
    }

    zoom(factor) {
      const newScale = this.state.scale * factor;
      // clamp scale
      this.state.scale = Math.min(Math.max(newScale, 0.5), 8);
      this.applyTransform();
    }

    reset() {
      this.state = { scale: 1, x: 0, y: 0 };
      this.applyTransform();
    }

    applyTransform() {
      if (!this.img) return;
      const { scale, x, y } = this.state;
      this.img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
  }

  const singleton = new SimpleImageViewer();
  window.ImageViewer = {
    open: (opts) => singleton.open(opts),
    close: () => singleton.close()
  };
})();
