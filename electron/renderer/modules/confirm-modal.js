/**
 * Ultra-lightweight Confirmation Modal
 */
(function() {
  // Inject minimal HTML
  document.body.insertAdjacentHTML('beforeend', `
    <div id="cfm" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;align-items:center;justify-content:center">
      <div style="background:#1a1a24;border-radius:8px;padding:16px;min-width:280px;max-width:360px;border:1px solid #333">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <b id="cfm-t" style="color:#fff;font-size:14px">Confirm</b>
          <span id="cfm-x" style="color:#666;cursor:pointer;font-size:18px;line-height:1">&times;</span>
        </div>
        <p id="cfm-m" style="color:#aaa;font-size:13px;margin:0 0 16px"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="cfm-n" style="padding:6px 14px;background:#2a2a3a;color:#aaa;border:none;border-radius:4px;cursor:pointer;font-size:12px">Cancel</button>
          <button id="cfm-y" style="padding:6px 14px;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">OK</button>
        </div>
      </div>
    </div>
  `);

  const el = document.getElementById('cfm');
  let cb = null;

  const close = (v) => { el.style.display = 'none'; cb && cb(v); cb = null; };

  document.getElementById('cfm-x').onclick = () => close(false);
  document.getElementById('cfm-n').onclick = () => close(false);
  document.getElementById('cfm-y').onclick = () => close(true);
  el.onclick = (e) => e.target === el && close(false);

  window.confirmModal = {
    show: (msg, title) => new Promise(r => {
      cb = r;
      document.getElementById('cfm-t').textContent = title || 'Confirm';
      document.getElementById('cfm-m').textContent = msg;
      el.style.display = 'flex';
    })
  };
})();
