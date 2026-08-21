// 预加载脚本：错误页「重试」通道 + 页面缩放手势（Ctrl+滚轮 / Ctrl+0 / Ctrl+= / Ctrl+-）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  retry: () => ipcRenderer.invoke('dsh-retry')
});

// 页面缩放手势：Ctrl+滚轮 上滑放大 / 下滑缩小；Ctrl+0 复位；Ctrl+= 放大；Ctrl+- 缩小。
// 监听器挂在捕获阶段并 preventDefault：Ctrl 组合键由缩放接管，
// 不会触发页面自身的滚动或快捷键行为（与浏览器原生行为一致）。
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    ipcRenderer.send('zoom-wheel', e.deltaY < 0 ? 'in' : 'out');
  }
}, { capture: true, passive: false });

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    if (e.key === '0') {
      e.preventDefault();
      ipcRenderer.send('zoom-reset');
    } else if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      ipcRenderer.send('zoom-in');
    } else if (e.key === '-') {
      e.preventDefault();
      ipcRenderer.send('zoom-out');
    }
  }
}, { capture: true });
